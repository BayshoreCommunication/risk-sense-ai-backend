import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AuditLogModel } from '../audit/model';

const persona = {
  key: 'finance_officer',
  name: 'Finance Officer',
  sector: 'financial',
  description: 'Approves payments, reconciles bank accounts, maintains the ledger.',
  responsibilities: ['Vendor payments', 'Bank reconciliation'],
  commonRisks: ['Duplicate payment', 'Unauthorized transfer'],
  detectHints: ['payment', 'invoice', 'wire'],
};

describe('personas (FR-09, versioning)', () => {
  let admin: Record<string, string>;
  let requestor: Record<string, string>;

  beforeEach(async () => {
    await seeded();
    admin = await login('admin@dev.local');
    requestor = await login('requestor@dev.local');
  });

  it('administrator creates a draft; requestor cannot create [SEC-01]', async () => {
    const denied = await request(app).post('/api/v1/personas').set(requestor).send(persona);
    expect(denied.status).toBe(403);
    const res = await request(app).post('/api/v1/personas').set(admin).send(persona);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ key: 'finance_officer', version: 1, status: 'draft', isCurrent: false });
    expect(await AuditLogModel.countDocuments({ action: 'persona.created' })).toBe(1);
  });

  it('validates the body (key format, sector enum) [FR-30]', async () => {
    const res = await request(app).post('/api/v1/personas').set(admin).send({ ...persona, key: 'Finance Officer', sector: 'space' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requestors only see active versions; activation makes it current [FR-09]', async () => {
    const created = await request(app).post('/api/v1/personas').set(admin).send(persona);
    const id = created.body.data._id;
    const before = await request(app).get('/api/v1/personas').set(requestor);
    expect(before.body.data).toHaveLength(0);
    const act = await request(app).post(`/api/v1/personas/${id}/activate`).set(admin);
    expect(act.status).toBe(200);
    expect(act.body.data).toMatchObject({ status: 'active', isCurrent: true });
    const after = await request(app).get('/api/v1/personas').set(requestor);
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0].name).toBe('Finance Officer');
  });

  it('editing an active persona creates a new draft version; activating it retires v1 but keeps it readable [FR-11, AI-04]', async () => {
    const created = await request(app).post('/api/v1/personas').set(admin).send(persona);
    const v1 = created.body.data._id;
    await request(app).post(`/api/v1/personas/${v1}/activate`).set(admin);

    const patched = await request(app).patch(`/api/v1/personas/${v1}`).set(admin).send({ name: 'Finance Officer (AP)' });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({ version: 2, status: 'draft', isCurrent: false, name: 'Finance Officer (AP)' });
    const v2 = patched.body.data._id;
    expect(v2).not.toBe(v1);

    const stillV1 = await request(app).get(`/api/v1/personas/${v1}`).set(admin);
    expect(stillV1.body.data).toMatchObject({ version: 1, status: 'active', isCurrent: true, name: 'Finance Officer' });

    await request(app).post(`/api/v1/personas/${v2}/activate`).set(admin);
    const oldV1 = await request(app).get(`/api/v1/personas/${v1}`).set(admin);
    expect(oldV1.body.data).toMatchObject({ version: 1, status: 'deactivated', isCurrent: false });
    const history = await request(app).get(`/api/v1/personas/${v2}/history`).set(admin);
    expect(history.body.data.map((p: { version: number }) => p.version)).toEqual([2, 1]);
    expect(await AuditLogModel.countDocuments({ action: 'persona.version_created' })).toBe(1);
  });

  it('a draft is edited in place; the key is immutable', async () => {
    const created = await request(app).post('/api/v1/personas').set(admin).send(persona);
    const id = created.body.data._id;
    const ok = await request(app).patch(`/api/v1/personas/${id}`).set(admin).send({ description: 'Updated description text.' });
    expect(ok.body.data).toMatchObject({ _id: id, version: 1, description: 'Updated description text.' });
    const bad = await request(app).patch(`/api/v1/personas/${id}`).set(admin).send({ key: 'other_key' });
    expect(bad.status).toBe(400);
  });

  it('duplicate key among current personas is rejected', async () => {
    const a = await request(app).post('/api/v1/personas').set(admin).send(persona);
    await request(app).post(`/api/v1/personas/${a.body.data._id}/activate`).set(admin);
    const dup = await request(app).post('/api/v1/personas').set(admin).send(persona);
    expect(dup.status).toBe(409);
  });

  it('deactivate removes it from new sessions but the document stays [FR-09]', async () => {
    const a = await request(app).post('/api/v1/personas').set(admin).send(persona);
    const id = a.body.data._id;
    await request(app).post(`/api/v1/personas/${id}/activate`).set(admin);
    await request(app).post(`/api/v1/personas/${id}/deactivate`).set(admin);
    expect((await request(app).get('/api/v1/personas').set(requestor)).body.data).toHaveLength(0);
    expect((await request(app).get(`/api/v1/personas/${id}`).set(admin)).body.data.status).toBe('deactivated');
  });
});
