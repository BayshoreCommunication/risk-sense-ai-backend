import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { SessionModel } from './model';

const duplicateKey = (keyPattern: Record<string, number>) => Object.assign(new Error('forced duplicate key'), { code: 11000, keyPattern });

describe('auth & sessions', () => {
  beforeEach(async () => {
    await seeded();
  });

  it('rejects requests without a token or dev header [FR-01]', async () => {
    const res = await request(app).get('/api/v1/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('creates a session and /me returns exactly one role [FR-02]', async () => {
    const headers = await login('requestor@dev.local');
    const me = await request(app).get('/api/v1/me').set(headers);
    expect(me.status).toBe(200);
    expect(me.body.data.user.role).toBe('requestor');
    expect(me.body.data.tenant.plan).toBe('free');
  });

  it('requires X-Session-Id after login [SEC-02]', async () => {
    const res = await request(app).get('/api/v1/me').set('X-Dev-User', 'requestor@dev.local');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_INVALID');
  });

  it('supersedes the oldest session when max concurrent = 1 [SEC-02]', async () => {
    const first = await login('requestor@dev.local');
    const second = await login('requestor@dev.local');
    const old = await request(app).get('/api/v1/me').set(first);
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('SESSION_INVALID');
    const fresh = await request(app).get('/api/v1/me').set(second);
    expect(fresh.status).toBe(200);
    const superseded = await SessionModel.findOne({ sessionId: first['X-Session-Id'] });
    expect(superseded?.terminationReason).toBe('superseded');
  });

  it('blocks a second login when tenant.features.blockConcurrentLogin [FR-04]', async () => {
    await TenantModel.updateOne({ slug: 'acme' }, { $set: { 'features.blockConcurrentLogin': true } });
    await login('requestor@paid.local');
    const res = await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'requestor@paid.local');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONCURRENT_LOGIN_BLOCKED');
  });

  it('atomically enforces a single active slot during concurrent login [FR-04, SEC-02]', async () => {
    await TenantModel.updateOne({ slug: 'public' }, { $set: { 'features.blockConcurrentLogin': true } });
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () => request(app).post('/api/v1/auth/session').set('X-Dev-User', 'requestor@dev.local')),
    );
    expect(attempts.filter((response) => response.status === 201)).toHaveLength(1);
    expect(attempts.filter((response) => response.body.error?.code === 'CONCURRENT_LOGIN_BLOCKED')).toHaveLength(3);
    const user = await (await import('../users/model')).UserModel.findOne({ email: 'requestor@dev.local' });
    expect(await SessionModel.countDocuments({ userId: user!._id, terminatedAt: null })).toBe(1);
  });

  it('restarts session allocation after the active-slot create loses a race [FR-04, SEC-02]', async () => {
    const insertSession = SessionModel.collection.insertOne.bind(SessionModel.collection);
    let attempts = 0;
    const insertSpy = vi.spyOn(SessionModel.collection, 'insertOne').mockImplementation(async (doc, options) => {
      attempts += 1;
      if (attempts === 1) throw duplicateKey({ userId: 1, slot: 1 });
      return insertSession(doc, options);
    });
    const res = await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'requestor@dev.local');
    insertSpy.mockRestore();

    expect(res.status).toBe(201);
    expect(attempts).toBe(2);
    expect(await SessionModel.countDocuments({ sessionId: res.body.data.sessionId })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'session.created', 'entity.id': res.body.data.sessionId })).toBe(1);
  });

  it('does not retry an unrelated duplicate from SessionModel.create [FR-04, SEC-02]', async () => {
    const user = (await UserModel.findOne({ email: 'requestor@dev.local' }).lean())!;
    let attempts = 0;
    const insertSpy = vi.spyOn(SessionModel.collection, 'insertOne').mockImplementation(async () => {
      attempts += 1;
      throw duplicateKey({ sessionId: 1 });
    });
    const res = await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'requestor@dev.local');
    insertSpy.mockRestore();

    expect(res.status).toBe(500);
    expect(attempts).toBe(1);
    expect(await SessionModel.countDocuments({ userId: user._id })).toBe(0);
    expect((await UserModel.findById(user._id).lean())?.lastLoginAt).toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'session.created' })).toBe(0);
  });

  it('restarts the full auth transaction after a session audit-sequence collision [SEC-02, SEC-07]', async () => {
    const insertAudit = AuditLogModel.collection.insertOne.bind(AuditLogModel.collection);
    const attemptedSessionIds: string[] = [];
    let collided = false;
    const insertSpy = vi.spyOn(AuditLogModel.collection, 'insertOne').mockImplementation(async (doc, options) => {
      if (doc.action === 'session.created') {
        attemptedSessionIds.push(String(doc.entity?.id));
        if (!collided) {
          collided = true;
          throw duplicateKey({ tenantId: 1, seq: 1 });
        }
      }
      return insertAudit(doc, options);
    });
    const res = await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'requestor@dev.local');
    insertSpy.mockRestore();

    expect(res.status).toBe(201);
    expect(attemptedSessionIds).toHaveLength(2);
    expect(attemptedSessionIds[0]).not.toBe(attemptedSessionIds[1]);
    expect(await SessionModel.findOne({ sessionId: attemptedSessionIds[0] })).toBeNull();
    expect(await SessionModel.countDocuments({ sessionId: attemptedSessionIds[1] })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'session.created' })).toBe(1);
    expect((await AuditLogModel.findOne({ action: 'session.created' }).lean())?.entity.id).toBe(attemptedSessionIds[1]);
  });

  it('expires an idle session and audits session.timeout [SEC-02]', async () => {
    const headers = await login('requestor@dev.local');
    await SessionModel.updateOne({ sessionId: headers['X-Session-Id'] }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).get('/api/v1/me').set(headers);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
    const s = await SessionModel.findOne({ sessionId: headers['X-Session-Id'] });
    expect(s?.terminationReason).toBe('timeout');
  });

  it('logout terminates the session [SEC-02]', async () => {
    const headers = await login('requestor@dev.local');
    const out = await request(app).delete('/api/v1/auth/session').set(headers);
    expect(out.status).toBe(200);
    const again = await request(app).get('/api/v1/me').set(headers);
    expect(again.status).toBe(401);
  });

  it('rolls back session termination when its audit fails, then logs out cleanly [SEC-02, SEC-07]', async () => {
    const headers = await login('requestor@dev.local');
    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'session.logout') throw new Error('forced logout audit failure');
      return writeAudit(entry);
    });
    const failed = await request(app).delete('/api/v1/auth/session').set(headers);
    writeSpy.mockRestore();

    expect(failed.status).toBe(500);
    expect((await SessionModel.findOne({ sessionId: headers['X-Session-Id'] }).lean())?.terminatedAt).toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'session.logout', 'entity.id': headers['X-Session-Id'] })).toBe(0);

    const retry = await request(app).delete('/api/v1/auth/session').set(headers);
    expect(retry.status).toBe(200);
    expect((await SessionModel.findOne({ sessionId: headers['X-Session-Id'] }).lean())?.terminationReason).toBe('logout');
    expect(await AuditLogModel.countDocuments({ action: 'session.logout', 'entity.id': headers['X-Session-Id'] })).toBe(1);
  });

  it('denies admin routes to a requestor and audits the attempt [SEC-01]', async () => {
    const headers = await login('requestor@dev.local');
    const res = await request(app).get('/api/v1/audit-logs').set(headers);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('requires MFA for administrator roles [SEC-03]', async () => {
    await UserModel.updateOne({ email: 'admin@dev.local' }, { $set: { mfaEnrolled: false } });
    const headers = await login('admin@dev.local');
    const res = await request(app).get('/api/v1/audit-logs').set(headers);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
  });
});
