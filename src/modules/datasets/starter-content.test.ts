import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { PersonaModel } from '../personas/model';
import { QuestionModel } from '../questions/model';
import { ScenarioModel } from '../scenarios/model';

const curatedDraftQuestionKeys = [
  'fin_q06e_fraud_type',
  'fin_q06f_internal_collusion',
  'fin_q08e_concern_type',
  'fin_q18e_origin_recognition',
  'hc_q02d_phi_category',
  'hc_q02e_access_revoked',
  'hc_q04a_clinical_decision',
  'hc_q04b_identity_mixup',
  'it_q02a_access_vector',
  'it_q02b_exfiltration',
  'it_q12_lateral_movement',
  'it_q13_system_isolated',
  'it_q14_unauthorized_change',
] as const;

const splitKeys = (value: string) => value.split(';').map((key) => key.trim()).filter(Boolean);

/**
 * templates/starter-content.json is review-gated development content for Financial Services,
 * Healthcare and IT. It includes a small, traceable subset of TAC's unapproved draft question bank;
 * it must always pass the same validation a later production upload will face.
 */
describe('starter content (templates/starter-content.json)', () => {
  let admin: Record<string, string>;
  let admin2: Record<string, string>;
  const content = JSON.parse(readFileSync(join(process.cwd(), 'templates', 'starter-content.json'), 'utf8'));

  beforeEach(async () => {
    await seeded();
    admin = await login('admin@dev.local');
    admin2 = await login('admin2@dev.local');
  });

  it('validates without row errors and activates end to end [FR-13, FR-12, FR-03, FR-07]', async () => {
    const up = await request(app).post('/api/v1/datasets').set(admin).send({ fileName: 'starter-content.json', content });
    expect(up.status).toBe(201);
    expect(up.body.data.validationErrors).toEqual([]);
    expect(up.body.data.status).toBe('validated');
    expect(up.body.data.counts).toMatchObject({ personas: 3, scenarios: 13, questions: 76, scoring: 6 });

    await request(app).post(`/api/v1/datasets/${up.body.data._id}/approve`).set(admin2);
    const act = await request(app).post(`/api/v1/datasets/${up.body.data._id}/activate`).set(admin);
    expect(act.status).toBe(200);
    expect(act.body.data.status).toBe('active');

    expect(await PersonaModel.countDocuments({ status: 'active', isCurrent: true })).toBe(3);
    expect(await ScenarioModel.countDocuments({ status: 'active', isCurrent: true })).toBe(13);
    expect(await QuestionModel.countDocuments({ status: 'active' })).toBe(76);
    // every persona's default scenario exists and is active
    for (const p of await PersonaModel.find({ isCurrent: true }).lean()) {
      expect(await ScenarioModel.exists({ key: p.defaultScenarioKey, status: 'active' })).toBeTruthy();
    }
    // every scenario has a pinned question set and ≥ 5 questions in its flow
    for (const s of await ScenarioModel.find({ isCurrent: true }).lean()) {
      expect(s.questionSetHash).toMatch(/^[a-f0-9]{64}$/);
      expect(s.conversationFlow.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('keeps the curated client draft deduplicated, explicitly tagged and reachable without new scoring rules [FR-15, FR-07, FR-12, FR-08]', () => {
    const questionByKey = new Map(content.questions.map((question: { question_key: string }) => [question.question_key, question]));
    const scenarioByKey = new Map(content.scenarios.map((scenario: { scenario_key: string }) => [scenario.scenario_key, scenario]));
    const personaByKey = new Map(content.personas.map((persona: { persona_key: string }) => [persona.persona_key, persona]));
    const normalizedTexts = content.questions.map((question: { text: string }) =>
      question.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
    );

    expect(new Set(normalizedTexts).size).toBe(normalizedTexts.length);
    expect(curatedDraftQuestionKeys).toHaveLength(13);

    const sectorCounts = new Map<string, number>();
    for (const key of curatedDraftQuestionKeys) {
      const question = questionByKey.get(key) as
        | {
            question_key: string;
            type: string;
            options: string;
            fact_key: string;
            required: string;
            persona_keys: string;
            scenario_keys: string;
            sectors: string;
            scoring_hint: string;
          }
        | undefined;
      expect(question, `${key} must remain in the reviewed starter dataset`).toBeDefined();
      expect(question!.fact_key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(splitKeys(question!.persona_keys)).not.toHaveLength(0);
      expect(splitKeys(question!.scenario_keys)).not.toHaveLength(0);
      expect(splitKeys(question!.sectors)).toHaveLength(1);
      expect(question!.required).toBe('false');
      expect(question!.scoring_hint).toBe('');
      if (question!.type === 'mcq') expect(splitKeys(question!.options).length).toBeGreaterThanOrEqual(2);
      else expect(question!.type).toBe('yes_no');

      const sector = splitKeys(question!.sectors)[0]!;
      sectorCounts.set(sector, (sectorCounts.get(sector) ?? 0) + 1);
      for (const scenarioKey of splitKeys(question!.scenario_keys)) {
        const scenario = scenarioByKey.get(scenarioKey) as
          | { scenario_key: string; persona_key: string; conversation_flow: string }
          | undefined;
        expect(scenario, `${key} references a known scenario`).toBeDefined();
        expect(splitKeys(question!.persona_keys)).toContain(scenario!.persona_key);
        expect(
          splitKeys(question!.sectors),
          `${key} sector must match the scenario persona`,
        ).toContain((personaByKey.get(scenario!.persona_key) as { sector: string }).sector);

        const reachable = new Set<string>();
        const queue = splitKeys(scenario!.conversation_flow);
        while (queue.length) {
          const nextKey = queue.shift()!;
          if (reachable.has(nextKey)) continue;
          reachable.add(nextKey);
          const next = questionByKey.get(nextKey) as { branch_question_keys?: string } | undefined;
          queue.push(...splitKeys(next?.branch_question_keys ?? ''));
        }
        expect(reachable, `${key} must be reachable from ${scenarioKey}`).toContain(key);
      }
    }

    expect(Object.fromEntries(sectorCounts)).toEqual({ financial: 4, healthcare: 4, it: 5 });
    const scoringText = JSON.stringify(content.scoring);
    for (const key of curatedDraftQuestionKeys) {
      const question = questionByKey.get(key) as { fact_key: string };
      expect(scoringText).not.toContain(question.fact_key);
    }

    const allReachable = new Set<string>();
    const allQueue = content.scenarios.flatMap((scenario: { conversation_flow: string }) => splitKeys(scenario.conversation_flow));
    while (allQueue.length) {
      const key = allQueue.shift()!;
      if (allReachable.has(key)) continue;
      allReachable.add(key);
      const question = questionByKey.get(key) as { branch_question_keys?: string } | undefined;
      allQueue.push(...splitKeys(question?.branch_question_keys ?? ''));
    }
    expect([...questionByKey.keys()].filter((key) => !allReachable.has(key))).toEqual([]);
  });
});
