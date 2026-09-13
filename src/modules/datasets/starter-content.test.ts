import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { PersonaModel } from '../personas/model';
import { QuestionModel } from '../questions/model';
import { ScenarioModel } from '../scenarios/model';

/**
 * templates/starter-content.json is the development content built from the BRD question sets
 * (Financial Services, Healthcare, IT) until TAC delivers the real library. It must always pass the
 * same validation TAC's uploads will face — this test is the guard.
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
    expect(up.body.data.counts).toMatchObject({ personas: 3, scenarios: 13, questions: 64, scoring: 6 });

    await request(app).post(`/api/v1/datasets/${up.body.data._id}/approve`).set(admin2);
    const act = await request(app).post(`/api/v1/datasets/${up.body.data._id}/activate`).set(admin);
    expect(act.status).toBe(200);
    expect(act.body.data.status).toBe('active');

    expect(await PersonaModel.countDocuments({ status: 'active', isCurrent: true })).toBe(3);
    expect(await ScenarioModel.countDocuments({ status: 'active', isCurrent: true })).toBe(13);
    expect(await QuestionModel.countDocuments({ status: 'active' })).toBe(64);
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
});
