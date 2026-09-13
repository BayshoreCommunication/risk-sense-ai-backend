import request from 'supertest';
import mongoose from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { GENESIS_HASH } from '../../lib/hash';
import { AuditLogModel } from './model';
import { audit } from './service';

describe('audit hash chain', () => {
  let tenantId: string;

  beforeEach(async () => {
    const { publicTenant } = await seeded();
    tenantId = String(publicTenant._id);
  });

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
});
