import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AssessmentModel } from './model';
import { reconstruct } from './reconstruct';

/** T-063 / FR-26: the lifecycle is rebuilt from the audit log alone; FR-30: the rebuilt state is compared with the stored document. */
describe('reconstruction from the audit log [FR-26, FR-30, SEC-07]', () => {
  const starter = JSON.parse(readFileSync(join(process.cwd(), 'templates', 'starter-content.json'), 'utf8'));

  beforeEach(async () => {
    await seeded();
    const admin = await login('admin@dev.local');
    const admin2 = await login('admin2@dev.local');
    const up = await request(app).post('/api/v1/datasets').set(admin).send({ fileName: 'starter.json', content: starter });
    await request(app).post(`/api/v1/datasets/${up.body.data._id}/approve`).set(admin2);
    expect((await request(app).post(`/api/v1/datasets/${up.body.data._id}/activate`).set(admin)).status).toBe(200);
  });

  /** Drives an intake to intake_complete with generic answers (mock AI). */
  async function runIntake(h: Record<string, string>) {
    const start = await request(app).post('/api/v1/assessments').set(h).send({ personaKey: 'finance_officer', text: 'unauthorized wire transfer without approval' });
    const id = start.body.data._id as string;
    let next = start.body.data.nextQuestion as { key: string; type: string; options: { id: string }[] } | null;
    let guard = 0;
    while (next && guard++ < 60) {
      const value = next.type === 'mcq' ? next.options[0]!.id : next.type === 'yes_no' ? false : next.type === 'number' ? 100 : undefined;
      const res = await request(app).post(`/api/v1/assessments/${id}/messages`).set(h).send(value === undefined ? { text: 'A short description of what happened, with enough words to be useful.' } : { value });
      expect(res.status).toBe(200);
      if (res.body.data.intakeComplete) break;
      next = res.body.data.nextQuestion;
    }
    expect((await request(app).post(`/api/v1/assessments/${id}/submit`).set(h)).status).toBe(200);
    return id;
  }

  it('PAID (fullAudit): timeline, facts, score, decisions and status all come back from the log and match the document [FR-26]', async () => {
    const req = await login('requestor@paid.local');
    const id = await runIntake(req);
    await request(app).post(`/api/v1/assessments/${id}/decision`).set(req).send({ type: 'escalate', reason: 'Needs treasury' });
    await request(app).post(`/api/v1/assessments/${id}/decision`).set(req).send({ type: 'override', overriddenTo: 'issue', reason: 'Treasury confirmed the wire was fraudulent.' });

    expect((await request(app).get(`/api/v1/assessments/${id}/reconstruct`).set(req)).status).toBe(403); // requestors do not audit
    const res = await request(app).get(`/api/v1/assessments/${id}/reconstruct`).set(await login('admin@paid.local'));
    expect(res.status).toBe(200);
    const r = res.body.data;
    expect(r.completeness).toBe('full');
    expect(r.missing).toEqual([]);
    expect(r.integrity).toMatchObject({ ok: true, badSeqs: [] });
    expect(r.integrity.checked).toBe(r.entries);
    expect(r.timeline.map((t: { action: string }) => t.action).slice(0, 3)).toEqual(['assessment.started', 'assessment.scenario_selected', 'assessment.answered']);
    expect(r.timeline.map((t: { action: string }) => t.action).slice(-5)).toEqual(['assessment.rules_evaluated', 'assessment.scored', 'assessment.recommended', 'decision.recorded', 'decision.recorded']);

    const doc = (await AssessmentModel.findById(id).lean())!;
    expect(r.state).toMatchObject({ personaKey: 'finance_officer', scenarioKey: doc.scenarioKey, status: 'closed', score: doc.result!.score, classification: doc.result!.classification, confidence: doc.result!.confidence, explanation: doc.result!.explanation, recommendedAction: doc.result!.recommendedAction });
    expect(r.state.versions).toMatchObject({ promptVersion: 'v1' });
    expect(r.state.factors).toBeTruthy();
    expect(r.state.facts).toEqual(Object.fromEntries(doc.facts.map((f) => [f.key, f.value])));
    expect(r.state.answers.length).toBe(doc.answers.length);
    expect(r.state.decisions.map((d: { type: string; reason: string }) => [d.type, d.reason])).toEqual([['escalate', 'Needs treasury'], ['override', 'Treasury confirmed the wire was fraudulent.']]);
    expect(r.conformance).toEqual({ matches: true, differences: [] });
  });

  it('FR-30: a stored document that drifted from its audit trail is reported, not silently accepted', async () => {
    const req = await login('requestor@paid.local');
    const id = await runIntake(req);
    const auditor = await login('admin@paid.local');
    // Tamper with the stored record directly (no API can do this): change a fact and the score.
    const doc = (await AssessmentModel.findById(id).lean())!;
    const firstFact = doc.facts[0]!.key;
    await mongoose.connection.db!.collection('assessments').updateOne({ _id: doc._id }, { $set: { 'facts.0.value': 'tampered', 'result.score': 99 } });
    const r = (await request(app).get(`/api/v1/assessments/${id}/reconstruct`).set(auditor)).body.data;
    expect(r.integrity.ok).toBe(true); // the log itself is intact
    expect(r.conformance.matches).toBe(false);
    expect(r.conformance.differences.map((d: { field: string }) => d.field).sort()).toEqual([`facts.${firstFact}`, 'result.score'].sort());
    expect(r.conformance.differences.find((d: { field: string }) => d.field === 'result.score')).toMatchObject({ fromAudit: doc.result!.score, stored: 99 });
  });

  it('SEC-07: a tampered audit entry is flagged by the per-entry hash check', async () => {
    const req = await login('requestor@paid.local');
    const id = await runIntake(req);
    const auditor = await login('admin@paid.local');
    const scored = await mongoose.connection.db!.collection('auditLogs').findOne({ action: 'assessment.scored', 'entity.id': id });
    await mongoose.connection.db!.collection('auditLogs').updateOne({ _id: scored!._id }, { $set: { 'payload.score': 1 } });
    const r = (await request(app).get(`/api/v1/assessments/${id}/reconstruct`).set(auditor)).body.data;
    expect(r.integrity).toMatchObject({ ok: false, badSeqs: [scored!.seq] });
    expect(r.state.score).toBe(1); // the rebuilt state follows the (tampered) log; integrity says not to trust it
    expect(r.conformance.matches).toBe(false);
  });

  it('FREE (minimal audit): the skeleton is rebuilt and the missing parts are named [FR-24]', async () => {
    const req = await login('requestor@dev.local');
    const id = await runIntake(req);
    await request(app).post(`/api/v1/assessments/${id}/decision`).set(req).send({ type: 'accept' });
    const r = (await request(app).get(`/api/v1/assessments/${id}/reconstruct`).set(await login('audit@dev.local'))).body.data;
    expect(r.fullAudit).toBe(false);
    expect(r.completeness).toBe('partial');
    expect(r.missing).toEqual(['answers', 'decisionReason', 'explanation', 'factors', 'facts', 'openingText', 'recommendedAction', 'rules']);
    expect(r.state).toMatchObject({ personaKey: 'finance_officer', status: 'closed', facts: {}, explanation: null });
    expect(r.state.score).toBeTypeOf('number');
    expect(r.state.answers.length).toBeGreaterThan(0);
    expect(r.state.answers[0].answer).toBeUndefined();
    expect(r.conformance.matches).toBe(true); // everything that IS reconstructible still matches
    // the public-tenant auditor cannot reach an Acme assessment
    const other = await runIntake(await login('requestor@paid.local'));
    expect((await request(app).get(`/api/v1/assessments/${other}/reconstruct`).set(await login('audit@dev.local'))).status).toBe(404);
  });

  it('pure reconstruct(): ordering by seq, unknown actions kept, empty log', () => {
    expect(reconstruct([])).toMatchObject({ completeness: 'empty', timeline: [], state: { status: 'unknown' } });
    const r = reconstruct([
      { seq: 3, action: 'assessment.scenario_selected', payload: { scenarioKey: 's', source: 'default', versions: { promptVersion: 'v1' } } },
      { seq: 1, action: 'assessment.started', payload: { personaKey: 'p', personaSource: 'ai', openingText: 'hello' } },
      { seq: 2, action: 'something.custom', payload: {} },
    ]);
    expect(r.timeline.map((t) => t.seq)).toEqual([1, 2, 3]);
    expect(r.timeline[1]!.summary).toBe('something.custom');
    expect(r.state).toMatchObject({ personaKey: 'p', openingText: 'hello', scenarioKey: 's', scenarioSource: 'default', status: 'in_progress' });
    expect(r.completeness).toBe('full');
  });
});
