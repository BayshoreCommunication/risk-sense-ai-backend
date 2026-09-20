import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { QuestionModel } from './model';

const base = {
  key: 'fin_q06_fraud_suspected',
  text: 'Does this incident involve a suspected fraudulent transaction?',
  type: 'yes_no',
  factKey: 'fraud_suspected',
  required: true,
  tags: { personaKeys: ['finance_officer'], sectors: ['financial'], category: 'Fraud' },
  branchTrigger: { onValue: true, questionKeys: ['fin_q06a_fraud_confirmed'] },
};

describe('questions (FR-15, FR-07)', () => {
  let admin: Record<string, string>;
  let auditor: Record<string, string>;

  beforeEach(async () => {
    await seeded();
    admin = await login('admin@dev.local');
    auditor = await login('audit@dev.local');
  });

  afterEach(() => vi.restoreAllMocks());

  it('creates a tagged question with a branch trigger; auditor can read, not write [FR-15, SEC-01]', async () => {
    const res = await request(app).post('/api/v1/questions').set(admin).send(base);
    expect(res.status).toBe(201);
    expect(res.body.data.tags.personaKeys).toEqual(['finance_officer']);
    expect(res.body.data.branchTrigger.questionKeys).toEqual(['fin_q06a_fraud_confirmed']);
    const list = await request(app).get('/api/v1/questions?personaKey=finance_officer&sector=financial').set(auditor);
    expect(list.body.data).toHaveLength(1);
    const denied = await request(app).post('/api/v1/questions').set(auditor).send({ ...base, key: 'x_other' });
    expect(denied.status).toBe(403);
  });

  it('requires persona and sector tags, validates mcq options [FR-15]', async () => {
    const noTags = await request(app).post('/api/v1/questions').set(admin).send({ ...base, tags: { personaKeys: [], sectors: [] } });
    expect(noTags.status).toBe(400);
    const badMcq = await request(app).post('/api/v1/questions').set(admin).send({ ...base, key: 'fin_q14_status', type: 'mcq', options: [{ id: 'a', label: 'Only one', factValue: 'a' }] });
    expect(badMcq.status).toBe(400);
    const okMcq = await request(app)
      .post('/api/v1/questions')
      .set(admin)
      .send({
        ...base,
        key: 'fin_q14_status',
        type: 'mcq',
        factKey: 'incident_status',
        branchTrigger: undefined,
        options: [
          { id: 'active', label: 'Still active', factValue: 'active' },
          { id: 'contained', label: 'Contained', factValue: 'contained' },
        ],
      });
    expect(okMcq.status).toBe(201);
  });

  it('rejects question tags outside the tenant sector vocabulary [FR-15, NFR-04]', async () => {
    const response = await request(app)
      .post('/api/v1/questions')
      .set(admin)
      .send({ ...base, tags: { ...base.tags, sectors: ['energy'] } });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('not configured');
    expect(await QuestionModel.countDocuments({ key: base.key })).toBe(0);
  });

  it('update is in place and audited with before/after [FR-25]', async () => {
    const created = await request(app).post('/api/v1/questions').set(admin).send(base);
    const id = created.body.data._id;
    const res = await request(app).patch(`/api/v1/questions/${id}`).set(admin).send({ text: 'Is a fraudulent transaction suspected?' });
    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe(id);
    const entry = await AuditLogModel.findOne({ action: 'question.updated' }).lean();
    expect(entry?.payload).toMatchObject({ changed: ['text'] });
    expect((entry?.payload as { before: { text: string } }).before.text).toBe(base.text);
  });

  it('rolls back question create, update and retirement when audit evidence fails [FR-15, FR-25, SEC-07]', async () => {
    const writeAudit = audit.write.bind(audit);
    let failAction = 'question.created';
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === failAction) throw new Error(`forced ${entry.action} audit failure`);
      return writeAudit(entry);
    });

    expect((await request(app).post('/api/v1/questions').set(admin).send(base)).status).toBe(500);
    expect(await QuestionModel.countDocuments({ key: base.key })).toBe(0);
    failAction = '';
    const created = await request(app).post('/api/v1/questions').set(admin).send(base);
    const id = created.body.data._id as string;

    failAction = 'question.updated';
    expect((await request(app).patch(`/api/v1/questions/${id}`).set(admin).send({ text: 'Uncommitted text' })).status).toBe(500);
    expect((await QuestionModel.findById(id).lean())?.text).toBe(base.text);

    failAction = 'question.retired';
    expect((await request(app).post(`/api/v1/questions/${id}/retire`).set(admin)).status).toBe(500);
    expect((await QuestionModel.findById(id).lean())?.status).toBe('active');
    writeSpy.mockRestore();
  });

  it('retire keeps the document, hides it from active listings, blocks edits [FR-15]', async () => {
    const created = await request(app).post('/api/v1/questions').set(admin).send(base);
    const id = created.body.data._id;
    await request(app).post(`/api/v1/questions/${id}/retire`).set(admin);
    expect((await request(app).get('/api/v1/questions?status=active').set(admin)).body.data).toHaveLength(0);
    expect((await request(app).get(`/api/v1/questions/${id}`).set(admin)).body.data.status).toBe('retired');
    const edit = await request(app).patch(`/api/v1/questions/${id}`).set(admin).send({ text: 'changed?' });
    expect(edit.status).toBe(409);
  });

  it('duplicate key rejected', async () => {
    await request(app).post('/api/v1/questions').set(admin).send(base);
    const dup = await request(app).post('/api/v1/questions').set(admin).send(base);
    expect(dup.status).toBe(409);
  });
});
