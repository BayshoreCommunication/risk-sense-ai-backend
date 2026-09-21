import request from 'supertest';
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { GENESIS_HASH } from '../../lib/hash';
import { AuditLogModel } from './model';
import { audit, sessionAuditReference } from './service';
import { AuditArchiveManifestModel } from './archive.model';
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { SessionModel } from '../auth/model';

describe('audit hash chain', () => {
  let tenantId: string;

  beforeEach(async () => {
    const { tac } = await seeded();
    tenantId = String(tac._id);
  });

  afterEach(() => vi.restoreAllMocks());

  it('links entries with prevHash starting from genesis and verifies ok [SEC-07]', async () => {
    const actor = { id: new mongoose.Types.ObjectId().toString(), role: 'system_administrator' };
    await audit.write({ tenantId, category: 'config', action: 'persona.created', actor, entity: { type: 'persona', id: 'p1', version: 1 } });
    await audit.write({ tenantId, category: 'config', action: 'persona.activated', actor, entity: { type: 'persona', id: 'p1', version: 1 } });
    const rows = await AuditLogModel.find({ tenantId }).sort({ seq: 1 }).lean();
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[0]!.prevHash).toBe(GENESIS_HASH);
    expect(rows[1]!.prevHash).toBe(rows[0]!.hash);
    expect(await audit.verify(tenantId)).toEqual({ ok: true, checked: 2 });
  });

  it('detects a tampered payload [SEC-07]', async () => {
    await audit.write({ tenantId, category: 'config', action: 'rule.created', actor: null, entity: { type: 'rule', id: 'r1' }, payload: { forced: 'risk' } });
    await audit.write({ tenantId, category: 'config', action: 'rule.activated', actor: null, entity: { type: 'rule', id: 'r1' } });
    // Bypass Mongoose (the model forbids updates) to simulate a direct DB edit.
    await mongoose.connection.db!.collection('auditLogs').updateOne({ seq: 1 }, { $set: { 'payload.forced': 'issue' } });
    const result = await audit.verify(tenantId);
    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(1);
  });

  it('model refuses updates and deletes [SEC-07]', async () => {
    await audit.write({ tenantId, category: 'access', action: 'access.denied', actor: null, entity: { type: 'route', id: 'GET /x' } });
    await expect(AuditLogModel.updateOne({ seq: 1 }, { $set: { action: 'x' } })).rejects.toThrow(/append-only/);
    await expect(AuditLogModel.deleteMany({})).rejects.toThrow(/append-only/);
  });

  it('serializes concurrent writes into a gap-free sequence [SEC-07]', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        audit.write({ tenantId, category: 'session', action: 'session.created', actor: null, entity: { type: 'session', id: `s${i}` } }),
      ),
    );
    const result = await audit.verify(tenantId);
    expect(result).toEqual({ ok: true, checked: 20 });
  });

  it('exposes read-only endpoints to audit role and verify to sysadmin [SEC-07]', async () => {
    const auditor = await login('audit@dev.local');
    const list = await request(app).get('/api/v1/audit-logs?category=session').set(auditor);
    expect(list.status).toBe(200);
    expect(list.body.data.items[0].action).toBe('session.created');

    const sysadmin = await login('sysadmin@dev.local');
    const verify = await request(app).get('/api/v1/audit-logs/verify').set(sysadmin);
    expect(verify.status).toBe(200);
    expect(verify.body.data.ok).toBe(true);
  });

  it('masks sensitive payloads by default and audits explicit unmask without altering the chain [SEC-05, SEC-07]', async () => {
    const secret = 'Patient Jane Doe has account 4471';
    await audit.write({
      tenantId,
      category: 'assessment',
      action: 'assessment.answered',
      actor: null,
      entity: { type: 'assessment', id: 'sensitive-case' },
      payload: { user: { name: 'Jane Doe', email: 'jane@example.com' }, answer: 4471, facts: [{ key: 'patient', value: secret, evidence: secret }], explanation: secret },
    });
    const auditor = await login('audit@dev.local');
    const masked = await request(app).get('/api/v1/audit-logs').set(auditor).query({ entityId: 'sensitive-case' });
    expect(masked.status).toBe(200);
    expect(masked.body.data.items[0].payloadMasked).toBe(true);
    expect(JSON.stringify(masked.body.data.items[0].payload)).not.toContain('Jane Doe');
    expect(masked.body.data.items[0].payload.answer).toBe('•••');
    expect(masked.body.data.items[0].payload.user).toEqual({ name: 'J••• (8 chars)', email: 'j•••@example.com' });

    const clear = await request(app).get('/api/v1/audit-logs').set(auditor).query({ entityId: 'sensitive-case', unmask: 'true' });
    expect(clear.status).toBe(200);
    expect(clear.body.data.items[0].payload.facts[0].value).toBe(secret);
    expect(await AuditLogModel.countDocuments({ action: 'access.unmasked', 'payload.what': 'audit payloads' })).toBe(1);
    expect((await audit.verify(tenantId)).ok).toBe(true);
  });

  it('exports a bounded paid audit range and records an immutable manifest [SEC-06, SEC-07]', async () => {
    const acme = (await TenantModel.findOne({ slug: 'acme' }))!;
    await UserModel.updateOne({ email: 'sysadmin@dev.local' }, { $set: { tenantId: acme._id } });
    await audit.write({ tenantId: String(acme._id), category: 'assessment', action: 'assessment.started', actor: null, entity: { type: 'assessment', id: 'archive-me' }, payload: { openingText: 'authorized cold-storage export' } });
    const sysadmin = await login('sysadmin@dev.local');
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const exported = await request(app).post('/api/v1/audit-logs/archive').set(sysadmin).send({ from, to });
    expect(exported.status).toBe(201);
    expect(exported.body.data.manifest).toMatchObject({ firstSeq: 1, lastSeq: 2, recordCount: 2 });
    expect(exported.body.data.manifest.exportHash).toMatch(/^[a-f0-9]{64}$/);
    expect(exported.body.data.records).toHaveLength(2);
    const manifest = await AuditArchiveManifestModel.findById(exported.body.data.manifest._id);
    await expect(AuditArchiveManifestModel.updateOne({ _id: manifest!._id }, { $set: { recordCount: 0 } })).rejects.toThrow(/immutable/);
    expect((await audit.verify(String(acme._id))).ok).toBe(true);
    const listed = await request(app).get('/api/v1/audit-logs/archive-manifests').set(sysadmin);
    expect(listed.body.data).toHaveLength(1);
  });

  it('redacts historical bearer-equivalent session ids from standard audit archives [SEC-02, SEC-07]', async () => {
    const acme = (await TenantModel.findOne({ slug: 'acme' }))!;
    await UserModel.updateOne({ email: 'sysadmin@dev.local' }, { $set: { tenantId: acme._id } });
    const sysadmin = await login('sysadmin@dev.local');
    const session = (await SessionModel.findOne({ sessionId: sysadmin['X-Session-Id'] }))!;
    await AuditLogModel.collection.updateOne(
      { tenantId: acme._id, action: 'session.created' },
      { $set: { 'entity.id': session.sessionId } },
    );

    const exported = await request(app).post('/api/v1/audit-logs/archive').set(sysadmin).send({
      from: new Date(Date.now() - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(exported.status).toBe(201);
    const serialized = JSON.stringify(exported.body.data.records);
    expect(serialized).not.toContain(session.sessionId);
    expect(serialized).toContain(sessionAuditReference(session.sessionId));
  });

  it('rolls back an archive manifest when its audit evidence fails [FR-25, SEC-06, SEC-07]', async () => {
    await audit.write({ tenantId, category: 'assessment', action: 'assessment.started', actor: null, entity: { type: 'assessment', id: 'archive-rollback' } });
    const sysadmin = await login('sysadmin@dev.local');
    const writeAudit = audit.write.bind(audit);
    vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'audit.archive_created') throw new Error('forced archive audit failure');
      return writeAudit(entry);
    });
    const response = await request(app)
      .post('/api/v1/audit-logs/archive')
      .set(sysadmin)
      .send({ from: new Date(Date.now() - 60_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });

    expect(response.status).toBe(500);
    expect(await AuditArchiveManifestModel.countDocuments({ tenantId })).toBe(0);
    expect(await AuditLogModel.countDocuments({ tenantId, action: 'audit.archive_created' })).toBe(0);
    expect(await AuditLogModel.countDocuments({ tenantId, action: 'assessment.started' })).toBe(1);
  });
});
