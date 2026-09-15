import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { classify, computeConfidence, computeFactors, computeScore, simulate, type MatrixLike } from './compute';
import { FACTOR_KEYS, ScoringMatrixModel } from './model';
import { scoringService } from './service';

const matrix: MatrixLike = {
  factors: {
    impact: { weight: 25, scale: { min: 1, max: 5 }, mapping: [{ when: { factKey: 'amount_usd', op: 'gt', value: 100000 }, value: 5 }, { when: { factKey: 'amount_usd', op: 'gt', value: 10000 }, value: 3 }] },
    likelihood: { weight: 20, scale: { min: 1, max: 5 }, mapping: [{ when: { factKey: 'similar_incident_before', op: 'eq', value: true }, value: 4 }] },
    severity: { weight: 20, scale: { min: 1, max: 5 }, mapping: [{ when: { factKey: 'fraud_suspected', op: 'eq', value: true }, value: 4 }] },
    controlEffectiveness: { weight: 15, scale: { min: 1, max: 5 }, mapping: [{ when: { factKey: 'controls_bypassed', op: 'eq', value: true }, value: 5 }] },
    regulatorySensitivity: { weight: 15, scale: { min: 1, max: 5 }, mapping: [{ when: { factKey: 'regulatory_reporting_triggered', op: 'eq', value: true }, value: 5 }] },
    duration: { weight: 5, scale: { min: 1, max: 5 }, mapping: [{ when: { factKey: 'incident_status', op: 'eq', value: 'active' }, value: 4 }] },
  },
  thresholds: { monitor_only: { min: 0, max: 25 }, risk: { min: 26, max: 50 }, elevated_risk: { min: 51, max: 75 }, issue: { min: 76, max: 100 } },
  confidence: { professionalConsultBelow: 60, mandatoryReviewBelow: 40 },
};

describe('scoring compute (FR-18, FR-19, FR-20, AI-03)', () => {
  it('factor = first matching mapping, else scale.min; score is the normalized weighted sum in 0–100', () => {
    const f = computeFactors(matrix, { amount_usd: 250000, controls_bypassed: 'yes', incident_status: 'contained' });
    expect(f.impact).toMatchObject({ value: 5, matchedMapping: 0, contribution: 25 });
    expect(f.controlEffectiveness.value).toBe(5);
    expect(f.duration.value).toBe(1);
    expect(computeScore(f)).toBe(40); // 25 + 15
  });
  it('score exactly 0 when every factor sits at scale.min → error review [FR-18]', () => {
    const r = simulate({ matrix, rules: [], facts: {} });
    expect(r.score).toBe(0);
    expect(r.errorReview).toBe(true);
    expect(r.classification).toBe('monitor_only');
  });
  it('changing one weight changes a fixed case consistently [FR-18]', () => {
    const facts = { amount_usd: 250000, fraud_suspected: true };
    const base = computeScore(computeFactors(matrix, facts)); // 25 + 15 = 40
    const heavier = JSON.parse(JSON.stringify(matrix)) as MatrixLike;
    heavier.factors.impact.weight = 40;
    heavier.factors.likelihood.weight = 5;
    expect(computeScore(computeFactors(heavier, facts))).toBe(55); // 40 + 15
    expect(base).toBe(40);
  });
  it('thresholds classify at the boundaries [FR-19]', () => {
    expect(classify(matrix, 25)).toBe('monitor_only');
    expect(classify(matrix, 26)).toBe('risk');
    expect(classify(matrix, 75)).toBe('elevated_risk');
    expect(classify(matrix, 76)).toBe('issue');
  });
  it('a fired rule overrides the computed class and is labeled rule-driven [FR-17]', () => {
    const r = simulate({
      matrix,
      rules: [{ id: '1', key: 'confirmed', name: 'c', trigger: { factKey: 'fraud_confirmed', op: 'eq', value: 'confirmed' }, forcedClassification: 'issue', priority: 1 }],
      facts: { fraud_confirmed: 'confirmed', amount_usd: 500 },
    });
    expect(r.ruleDriven).toBe(true);
    expect(r.classification).toBe('issue');
    expect(r.computedClassification).toBe('monitor_only');
  });
  it('confidence: coverage 70 % + mean extraction confidence 30 %; < 60 → professional consult [FR-20, AI-03]', () => {
    expect(computeConfidence({ facts: { a: 1, b: 2 }, requiredFactKeys: ['a', 'b'] })).toBe(100);
    expect(computeConfidence({ facts: { a: 1 }, requiredFactKeys: ['a', 'b'] })).toBe(65);
    expect(computeConfidence({ facts: { a: 1 }, requiredFactKeys: ['a', 'b'], factConfidences: { a: 0.5 } })).toBe(50);
    const r = simulate({ matrix, rules: [], facts: { amount_usd: 20000 }, requiredFactKeys: ['amount_usd', 'authorized', 'fraud_suspected'] });
    expect(r.confidence).toBeLessThan(60);
    expect(r.professionalConsult).toBe(true);
  });
});

describe('scoring matrices API + simulate + golden set', () => {
  let admin: Record<string, string>;
  let admin2: Record<string, string>;
  const starter = JSON.parse(readFileSync(join(process.cwd(), 'templates', 'starter-content.json'), 'utf8'));

  beforeEach(async () => {
    await seeded();
    admin = await login('admin@dev.local');
    admin2 = await login('admin2@dev.local');
  });

  it('matrix body validation: weights must sum to 100, thresholds contiguous 0–100', async () => {
    const body = scoringService.parseSheet(starter.scoring).body!;
    const bad = JSON.parse(JSON.stringify(body));
    bad.factors.impact.weight = 10;
    const res = await request(app).post('/api/v1/scoring-matrices').set(admin).send(bad);
    expect(res.status).toBe(400);
    const bad2 = JSON.parse(JSON.stringify(body));
    bad2.thresholds.risk = { min: 30, max: 50 };
    expect((await request(app).post('/api/v1/scoring-matrices').set(admin).send(bad2)).status).toBe(400);
  });

  it('draft → approve (other admin) → activate; simulate uses the current matrix [AI-05]', async () => {
    const body = scoringService.parseSheet(starter.scoring).body!;
    const created = await request(app).post('/api/v1/scoring-matrices').set(admin).send(body);
    expect(created.status).toBe(201);
    const id = created.body.data._id;
    expect((await request(app).post(`/api/v1/scoring-matrices/${id}/activate`).set(admin)).body.error.code).toBe('NOT_APPROVED');
    expect((await request(app).post(`/api/v1/scoring-matrices/${id}/approve`).set(admin).send({ changeRef: 'CR-7' })).body.error.code).toBe('SELF_APPROVAL');
    await request(app).post(`/api/v1/scoring-matrices/${id}/approve`).set(admin2).send({ changeRef: 'CR-7' });
    const act = await request(app).post(`/api/v1/scoring-matrices/${id}/activate`).set(admin);
    expect(act.body.data).toMatchObject({ status: 'active', isCurrent: true });

    const sim = await request(app).post('/api/v1/scoring/simulate').set(admin).send({ facts: { amount_usd: 250000, controls_bypassed: true, incident_status: 'active' } });
    expect(sim.status).toBe(200);
    expect(sim.body.data.matrix.key).toBe('default');
    expect(sim.body.data.score).toBeGreaterThan(0);
    expect(FACTOR_KEYS.every((k) => k in sim.body.data.factors)).toBe(true);
  });

  it('an active-matrix edit preserves v1 and the effective-change editor cannot approve v2 [AI-05]', async () => {
    const body = scoringService.parseSheet(starter.scoring).body!;
    const created = await request(app).post('/api/v1/scoring-matrices').set(admin).send(body);
    const id = created.body.data._id;
    await request(app).post(`/api/v1/scoring-matrices/${id}/approve`).set(admin2).send({ changeRef: 'MATRIX-V1' });
    await request(app).post(`/api/v1/scoring-matrices/${id}/activate`).set(admin);

    const edit = await request(app).patch(`/api/v1/scoring-matrices/${id}`).set(admin2).send({ name: 'Edited default matrix' });
    const replacementId = edit.body.data._id;
    expect(edit.status).toBe(200);
    expect(edit.body.data).toMatchObject({ version: 2, status: 'draft', isCurrent: false, name: 'Edited default matrix' });
    expect(await ScoringMatrixModel.findById(id).lean()).toMatchObject({ version: 1, status: 'active', isCurrent: true, name: body.name });

    const latestEdit = await request(app).patch(`/api/v1/scoring-matrices/${replacementId}`).set(admin).send({ name: 'Final reviewed matrix' });
    expect(latestEdit.body.data).toMatchObject({ _id: replacementId, version: 2, status: 'draft', name: 'Final reviewed matrix' });
    const missingRef = await request(app).post(`/api/v1/scoring-matrices/${replacementId}/approve`).set(admin2).send({});
    expect(missingRef.status).toBe(400);
    const self = await request(app).post(`/api/v1/scoring-matrices/${replacementId}/approve`).set(admin).send({ changeRef: 'MATRIX-V2' });
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('SELF_APPROVAL');
    expect((await ScoringMatrixModel.findById(id).lean())?.status).toBe('active');

    expect((await request(app).post(`/api/v1/scoring-matrices/${replacementId}/approve`).set(admin2).send({ changeRef: 'MATRIX-V2' })).status).toBe(200);
    await request(app).post(`/api/v1/scoring-matrices/${replacementId}/activate`).set(admin);
    expect(await ScoringMatrixModel.findById(id).lean()).toMatchObject({ status: 'deactivated', isCurrent: false });
    expect(await ScoringMatrixModel.findById(replacementId).lean()).toMatchObject({ status: 'active', isCurrent: true });
  });

  it('does not activate a legacy matrix whose approval record has no change reference [AI-05]', async () => {
    const body = scoringService.parseSheet(starter.scoring).body!;
    const created = await request(app).post('/api/v1/scoring-matrices').set(admin).send(body);
    await request(app).post(`/api/v1/scoring-matrices/${created.body.data._id}/approve`).set(admin2).send({ changeRef: 'LEGACY-1' });
    await ScoringMatrixModel.updateOne({ _id: created.body.data._id }, { $unset: { changeRef: 1 } });

    const activation = await request(app).post(`/api/v1/scoring-matrices/${created.body.data._id}/activate`).set(admin);

    expect(activation.status).toBe(422);
    expect(activation.body.error.code).toBe('NOT_APPROVED');
  });

  it('golden set: the starter scoring sheet classifies the scenarios’ typical cases as expected [FR-18]', async () => {
    // Load the whole starter dataset (matrix + hard rules come from the scoring sheet).
    const up = await request(app).post('/api/v1/datasets').set(admin).send({ fileName: 'starter-content.json', content: starter });
    await request(app).post(`/api/v1/datasets/${up.body.data._id}/approve`).set(admin2);
    const act = await request(app).post(`/api/v1/datasets/${up.body.data._id}/activate`).set(admin);
    expect(act.status).toBe(200);
    expect(act.body.data.applied.matrix).toBe('default v1');
    expect(act.body.data.applied.rules.length).toBeGreaterThanOrEqual(5);

    const golden = JSON.parse(readFileSync(join(process.cwd(), 'src', 'modules', 'scoring', 'golden', 'starter.json'), 'utf8')) as {
      name: string;
      facts: Record<string, unknown>;
      requiredFactKeys?: string[];
      expect: { classification: string; ruleDriven?: boolean; minScore?: number; maxScore?: number };
    }[];
    for (const g of golden) {
      const res = await request(app).post('/api/v1/scoring/simulate').set(admin).send({ facts: g.facts, requiredFactKeys: g.requiredFactKeys ?? [] });
      expect(res.status, g.name).toBe(200);
      const d = res.body.data;
      expect(d.classification, `${g.name} (score ${d.score})`).toBe(g.expect.classification);
      if (g.expect.ruleDriven !== undefined) expect(d.ruleDriven, g.name).toBe(g.expect.ruleDriven);
      if (g.expect.minScore !== undefined) expect(d.score, g.name).toBeGreaterThanOrEqual(g.expect.minScore);
      if (g.expect.maxScore !== undefined) expect(d.score, g.name).toBeLessThanOrEqual(g.expect.maxScore);
    }
  });
});
