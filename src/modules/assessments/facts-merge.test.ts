import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { mockAi, setAi, type AiService } from '../ai/service';
import { AssessmentModel } from './model';

/**
 * Regression for a real-LLM incident found in the browser: the model returned "side facts" for every
 * catalogued key (value "unknown", confidence 0.5) and they overwrote clicked MCQ/yes-no answers.
 * Side facts may only fill gaps, with real confidence and no placeholders.
 */
describe('fact merge policy (FR-06, FR-30)', () => {
  let requestor: Record<string, string>;
  const starter = JSON.parse(readFileSync(join(process.cwd(), 'templates', 'starter-content.json'), 'utf8'));

  beforeEach(async () => {
    await seeded();
    const admin = await login('admin@dev.local');
    const admin2 = await login('admin2@dev.local');
    requestor = await login('requestor@tac.local');
    const up = await request(app).post('/api/v1/datasets').set(admin).send({ fileName: 'starter.json', content: starter });
    await request(app).post(`/api/v1/datasets/${up.body.data._id}/approve`).set(admin2);
    await request(app).post(`/api/v1/datasets/${up.body.data._id}/activate`).set(admin);
  });
  afterEach(() => setAi(null));

  it('a chatty extractor cannot overwrite structured answers or inject placeholders', async () => {
    const chatty: AiService = {
      ...mockAi,
      async extractFacts(input) {
        const base = await mockAi.extractFacts(input);
        // The model "helpfully" reports every catalogued fact as unknown/false at 0.5, plus one real, confident side fact.
        return {
          facts: [
            ...base.facts,
            ...input.factCatalog.filter((f) => f.key !== input.question.factKey).map((f) => ({ key: f.key, value: 'unknown' as const, confidence: 0.5, evidence: '' })),
            { key: 'loss_or_liability', value: true, confidence: 0.9, evidence: 'we will lose the money' },
          ],
          clarification: null,
        };
      },
    };
    setAi(chatty);

    const start = await request(app).post('/api/v1/assessments').set(requestor).send({ personaKey: 'finance_officer', text: 'unauthorized wire transfer without approval' });
    const id = start.body.data._id;
    expect(start.body.data.nextQuestion.key).toBe('fin_q01_process');
    // Structured answers first: they must survive later extraction.
    await request(app).post(`/api/v1/assessments/${id}/messages`).set(requestor).send({ text: 'Treasury wire payments to a new vendor account.' });
    await request(app).post(`/api/v1/assessments/${id}/messages`).set(requestor).send({ value: 'company' }); // fin_q02_funds
    await request(app).post(`/api/v1/assessments/${id}/messages`).set(requestor).send({ value: 250000 }); // fin_q03_amount
    await request(app).post(`/api/v1/assessments/${id}/messages`).set(requestor).send({ value: false }); // fin_q04_authorized
    const t = await request(app).post(`/api/v1/assessments/${id}/messages`).set(requestor).send({ text: 'No, we will lose the money and nobody signed off on it.' }); // fin_q05_approvals (free text)
    expect(t.status).toBe(200);

    const doc = await AssessmentModel.findById(id).lean();
    const fact = (k: string) => doc!.facts.find((f) => f.key === k);
    expect(fact('amount_usd')).toMatchObject({ value: 250000, source: 'mcq', confidence: 1 });
    expect(fact('funds_type')).toMatchObject({ value: 'company', source: 'mcq' });
    expect(fact('authorized')).toMatchObject({ value: false, source: 'mcq' });
    expect(fact('approvals_obtained')).toMatchObject({ value: false, source: 'ai' });
    expect(fact('loss_or_liability')).toMatchObject({ value: true, source: 'ai', confidence: 0.9 }); // confident side fact fills a gap
    expect(fact('incident_status')).toBeUndefined(); // placeholder "unknown" never stored
    expect(doc!.facts.some((f) => f.value === 'unknown')).toBe(false);
  });
});
