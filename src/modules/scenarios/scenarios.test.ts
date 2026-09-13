import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';

const persona = {
  key: 'finance_officer',
  name: 'Finance Officer',
  sector: 'financial',
  description: 'Approves payments, reconciles bank accounts, maintains the ledger.',
  detectHints: ['payment'],
};

const q = (key: string, factKey: string, extra: Record<string, unknown> = {}) => ({
  key,
  text: `Question ${key}?`,
  type: 'yes_no',
  factKey,
  required: true,
  tags: { personaKeys: ['finance_officer'], sectors: ['financial'] },
  ...extra,
});

const scenario = {
  key: 'fin_unauthorized_transaction',
  personaKey: 'finance_officer',
  name: 'Unauthorized transaction',
  description: 'A payment was executed without the required approvals.',
  businessContext: 'Accounts payable.',
  conversationFlow: [{ questionKey: 'fin_q04_authorized' }, { questionKey: 'fin_q06_fraud' }],
  requiredFactKeys: ['authorized', 'fraud_suspected'],
  expectedClassification: 'elevated_risk',
};

describe('scenarios (FR-11, FR-12, FR-03)', () => {
  let admin: Record<string, string>;

  beforeEach(async () => {
    await seeded();
    admin = await login('admin@dev.local');
    const p = await request(app).post('/api/v1/personas').set(admin).send(persona);
    await request(app).post(`/api/v1/personas/${p.body.data._id}/activate`).set(admin);
  });

  it('rejects a scenario for an unknown persona', async () => {
    const res = await request(app).post('/api/v1/scenarios').set(admin).send({ ...scenario, personaKey: 'nobody' });
    expect(res.status).toBe(400);
  });

  it('activation is blocked when the flow has no questions [FR-12]', async () => {
    const created = await request(app).post('/api/v1/scenarios').set(admin).send({ ...scenario, conversationFlow: [], requiredFactKeys: [] });
    const res = await request(app).post(`/api/v1/scenarios/${created.body.data._id}/activate`).set(admin);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NO_LINKED_QUESTIONS');
  });

  it('activation is blocked when a flow question does not exist or is retired [FR-12]', async () => {
    const created = await request(app).post('/api/v1/scenarios').set(admin).send(scenario);
    const res = await request(app).post(`/api/v1/scenarios/${created.body.data._id}/activate`).set(admin);
    expect(res.status).toBe(422);
    expect(res.body.error.details.missing).toEqual(['fin_q04_authorized', 'fin_q06_fraud']);
  });

  it('activation is blocked when a required fact is not produced by any reachable question [FR-03]', async () => {
    await request(app).post('/api/v1/questions').set(admin).send(q('fin_q04_authorized', 'authorized'));
    await request(app).post('/api/v1/questions').set(admin).send(q('fin_q06_fraud', 'fraud_suspected'));
    const created = await request(app).post('/api/v1/scenarios').set(admin).send({ ...scenario, requiredFactKeys: ['authorized', 'amount_usd'] });
    const res = await request(app).post(`/api/v1/scenarios/${created.body.data._id}/activate`).set(admin);
    expect(res.status).toBe(400);
    expect(res.body.error.details.uncovered).toEqual(['amount_usd']);
  });

  it('activates when questions (including branch follow-ups) cover the required facts, and pins a question-set hash [AI-04, FR-07]', async () => {
    await request(app).post('/api/v1/questions').set(admin).send(q('fin_q04_authorized', 'authorized'));
    await request(app)
      .post('/api/v1/questions')
      .set(admin)
      .send(q('fin_q06_fraud', 'fraud_suspected', { branchTrigger: { onValue: true, questionKeys: ['fin_q06a_confirmed'] } }));
    await request(app).post('/api/v1/questions').set(admin).send(q('fin_q06a_confirmed', 'fraud_confirmed', { required: false }));
    const created = await request(app)
      .post('/api/v1/scenarios')
      .set(admin)
      .send({ ...scenario, requiredFactKeys: ['authorized', 'fraud_suspected', 'fraud_confirmed'] });
    const res = await request(app).post(`/api/v1/scenarios/${created.body.data._id}/activate`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.questionSetHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('editing an active scenario creates a new version and never overwrites the active one [FR-11]', async () => {
    await request(app).post('/api/v1/questions').set(admin).send(q('fin_q04_authorized', 'authorized'));
    await request(app).post('/api/v1/questions').set(admin).send(q('fin_q06_fraud', 'fraud_suspected'));
    const created = await request(app).post('/api/v1/scenarios').set(admin).send(scenario);
    const v1 = created.body.data._id;
    await request(app).post(`/api/v1/scenarios/${v1}/activate`).set(admin);
    const patched = await request(app).patch(`/api/v1/scenarios/${v1}`).set(admin).send({ name: 'Unauthorized wire' });
    expect(patched.body.data).toMatchObject({ version: 2, status: 'draft', name: 'Unauthorized wire' });
    const v1Again = await request(app).get(`/api/v1/scenarios/${v1}`).set(admin);
    expect(v1Again.body.data).toMatchObject({ version: 1, status: 'active', name: 'Unauthorized transaction' });
    const second = await request(app).patch(`/api/v1/scenarios/${v1}`).set(admin).send({ name: 'Another' });
    expect(second.status).toBe(409); // one open draft per group
  });

  it('personaKey is immutable across versions', async () => {
    const created = await request(app).post('/api/v1/scenarios').set(admin).send(scenario);
    const res = await request(app).patch(`/api/v1/scenarios/${created.body.data._id}`).set(admin).send({ personaKey: 'someone_else' });
    expect(res.status).toBe(400);
  });
});
