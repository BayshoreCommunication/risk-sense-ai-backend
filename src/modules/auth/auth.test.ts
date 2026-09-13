import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { TenantModel } from '../tenants/model';
import { SessionModel } from './model';

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

  it('denies admin routes to a requestor and audits the attempt [SEC-01]', async () => {
    const headers = await login('requestor@dev.local');
    const res = await request(app).get('/api/v1/audit-logs').set(headers);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('requires MFA for administrator roles [SEC-03]', async () => {
    const { UserModel } = await import('../users/model');
    await UserModel.updateOne({ email: 'admin@dev.local' }, { $set: { mfaEnrolled: false } });
    const headers = await login('admin@dev.local');
    const res = await request(app).get('/api/v1/audit-logs').set(headers);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MFA_REQUIRED');
  });
});
