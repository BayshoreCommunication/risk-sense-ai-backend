import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Firebase Admin is mocked: tests never talk to Google. Token "uid:<x>" → verified identity.
vi.mock('../../lib/firebase', () => ({
  verifyIdToken: async (token: string) => {
    if (!token.startsWith('uid:')) {
      const { AppError } = await import('../../lib/errors');
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired ID token');
    }
    const [, uid, email, mfa, provider] = token.split(':');
    return { uid, email, name: 'Firebase User', mfa: mfa === 'mfa', signInProvider: provider };
  },
}));

import { app, seeded } from '../../tests/helpers';
import { env } from '../../config/env';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { SessionModel } from './model';

describe('Firebase bearer login', () => {
  beforeEach(async () => {
    const { tac } = await seeded();
    env.PUBLIC_DEMO_TENANT_ID = String(tac._id);
    await TenantModel.updateOne({ slug: 'tac' }, { $set: { 'features.sso': true, sso: { providerId: 'oidc.tac', domain: 'tac.example' } } });
  });

  it('rejects an invalid token [FR-01]', async () => {
    const res = await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('seeds FREE and PAID tenant auth-policy values consistently [FR-02, SEC-03]', async () => {
    const tenants = await TenantModel.find({ slug: { $in: ['public', 'tac', 'acme'] } })
      .select('slug plan authPolicy')
      .sort({ slug: 1 })
      .lean();
    expect(tenants.map(({ slug, plan, authPolicy }) => ({ slug, plan, otpRequired: authPolicy.otpRequired }))).toEqual([
      { slug: 'acme', plan: 'paid', otpRequired: true },
      { slug: 'public', plan: 'free', otpRequired: false },
      { slug: 'tac', plan: 'paid', otpRequired: true },
    ]);
  });

  it('self-provisions a FREE requestor directly even when the stored OTP policy is true [FR-01, FR-02, SEC-03]', async () => {
    // Legacy/default stored values must not override the FREE tier's direct-session invariant.
    await TenantModel.updateOne({ slug: 'public' }, { $set: { 'authPolicy.otpRequired': true } });
    const res = await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer uid:abc123:new.person@gmail.com');
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('requestor');
    expect(res.body.data.tenant.slug).toBe('public');
    expect(res.body.data.accessMode).toBe('standard');
    expect(res.body.data.tenant.authPolicy).toEqual({ otpRequired: false });
    const user = await UserModel.findOne({ firebaseUid: 'abc123' });
    expect(user?.email).toBe('new.person@gmail.com');
    expect((await SessionModel.findOne({ sessionId: res.body.data.sessionId }).lean())?.loginAssurance).toMatchObject({
      method: 'single_factor',
    });
    const me = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer uid:abc123:new.person@gmail.com')
      .set('X-Session-Id', res.body.data.sessionId);
    expect(me.status).toBe(200);
    const signup = await AuditLogModel.findOne({ action: 'auth.self_signup' });
    expect(signup).toBeTruthy();
  });

  it('rolls back self-signup when its audit fails, then provisions normally on retry [FR-01, FR-02, SEC-07]', async () => {
    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'auth.self_signup') throw new Error('forced self-signup audit failure');
      return writeAudit(entry);
    });
    const failed = await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer uid:atomic-new:new.atomic@example.com');
    writeSpy.mockRestore();

    expect(failed.status).toBe(500);
    expect(await UserModel.countDocuments({ email: 'new.atomic@example.com' })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'auth.self_signup' })).toBe(0);
    expect(await SessionModel.countDocuments()).toBe(0);

    const retry = await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer uid:atomic-new:new.atomic@example.com');
    expect(retry.status).toBe(201);
    expect(await UserModel.countDocuments({ email: 'new.atomic@example.com', firebaseUid: 'atomic-new' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'auth.self_signup' })).toBe(1);
  });

  it('links a pre-provisioned account only after the required OTP succeeds [FR-01, FR-02, SEC-03]', async () => {
    const res = await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer uid:real-admin-uid:admin@dev.local:mfa:oidc.tac');
    expect(res.status).toBe(401); // administrators always need the OTP step (SEC-03)
    expect(res.body.error.code).toBe('OTP_REQUIRED');
    let users = await UserModel.find({ email: 'admin@dev.local' });
    expect(users).toHaveLength(1);
    expect(users[0]!.firebaseUid).toBe('dev:admin@dev.local');

    const requested = await request(app).post('/api/v1/auth/otp/request').set('Authorization', 'Bearer uid:real-admin-uid:admin@dev.local:mfa:oidc.tac');
    const login = await request(app)
      .post('/api/v1/auth/session')
      .set('Authorization', 'Bearer uid:real-admin-uid:admin@dev.local:mfa:oidc.tac')
      .send({ otpCode: requested.body.data.devCode });
    expect(login.status).toBe(201);
    users = await UserModel.find({ email: 'admin@dev.local' });
    expect(users).toHaveLength(1);
    expect(users[0]!.firebaseUid).toBe('real-admin-uid');
    expect(await AuditLogModel.countDocuments({ action: 'auth.identity_linked', 'entity.id': String(users[0]!._id) })).toBe(1);
  });

  it('rolls back identity linking when its audit fails, then links and creates a session on retry [FR-01, FR-02, SEC-02, SEC-07]', async () => {
    const before = (await UserModel.findOne({ email: 'requestor@dev.local' }).lean())!;
    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'auth.identity_linked') throw new Error('forced identity-link audit failure');
      return writeAudit(entry);
    });
    const failed = await request(app)
      .post('/api/v1/auth/session')
      .set('Authorization', 'Bearer uid:real-requestor-uid:requestor@dev.local');
    writeSpy.mockRestore();

    expect(failed.status).toBe(500);
    expect((await UserModel.findById(before._id).lean())?.firebaseUid).toBe('dev:requestor@dev.local');
    expect(await SessionModel.countDocuments({ userId: before._id })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'auth.identity_linked', 'entity.id': String(before._id) })).toBe(0);

    const retry = await request(app)
      .post('/api/v1/auth/session')
      .set('Authorization', 'Bearer uid:real-requestor-uid:requestor@dev.local');
    expect(retry.status).toBe(201);
    expect((await UserModel.findById(before._id).lean())?.firebaseUid).toBe('real-requestor-uid');
    expect(await SessionModel.countDocuments({ userId: before._id, terminatedAt: null })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'auth.identity_linked', 'entity.id': String(before._id) })).toBe(1);
  });

  it('second login reuses the same user and does not create another audit self_signup', async () => {
    await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer uid:u2:two@x.com');
    await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer uid:u2:two@x.com');
    expect(await UserModel.countDocuments({ firebaseUid: 'u2' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'auth.self_signup' })).toBe(1);
  });

  it('a Firebase-provisioned requestor cannot reach admin routes [SEC-01]', async () => {
    const login = await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer uid:u3:three@x.com');
    const res = await request(app)
      .get('/api/v1/audit-logs')
      .set('Authorization', 'Bearer uid:u3:three@x.com')
      .set('X-Session-Id', login.body.data.sessionId);
    expect(res.status).toBe(403);
  });

  it('creates server-issued read-only sessions for exactly the four flagged TAC roles without Firebase [FR-01, FR-02, SEC-03]', async () => {
    const tenant = (await TenantModel.findOneAndUpdate(
      { slug: 'tac' },
      { $set: { publicDemo: true } },
      { new: true },
    ).select('+publicDemo'))!;
    const identities = [
      ['requestor@tac.local', 'requestor'],
      ['admin@dev.local', 'administrator'],
      ['sysadmin@dev.local', 'system_administrator'],
      ['audit@dev.local', 'audit'],
    ] as const;

    for (const [email, role] of identities) {
      await UserModel.updateOne({ email, tenantId: tenant._id, role }, { $set: { publicDemo: true } });
      const login = await request(app).post('/api/v1/auth/public-demo/session').send({ role });

      expect(login.status, `${email}: ${JSON.stringify(login.body)}`).toBe(201);
      expect(login.body.data.user.role, email).toBe(role);
      expect(login.body.data.accessMode, email).toBe('public_demo_read_only');
      expect(login.headers['cache-control']).toBe('no-store');
      expect(login.headers.pragma).toBe('no-cache');
      expect((await SessionModel.findOne({ sessionId: login.body.data.sessionId }).lean())?.loginAssurance).toMatchObject({
        method: 'public_demo',
      });
      expect((await SessionModel.findOne({ sessionId: login.body.data.sessionId }).lean())?.absoluteExpiresAt).toBeTruthy();

      const me = await request(app)
        .get('/api/v1/me')
        .set('X-Session-Id', login.body.data.sessionId);
      expect(me.status, email).toBe(200);
      expect(me.body.data.accessMode, email).toBe('public_demo_read_only');
      expect(me.headers['cache-control'], email).toBe('no-store');
      expect(me.headers.pragma, email).toBe('no-cache');
    }
  });

  it('keeps public-demo sessions read-only, blocks unmask, and still permits logout [SEC-01, SEC-03]', async () => {
    const tenant = (await TenantModel.findOneAndUpdate(
      { slug: 'tac' },
      { $set: { publicDemo: true } },
      { new: true },
    ).select('+publicDemo'))!;
    await UserModel.updateOne(
      { email: 'admin@dev.local', tenantId: tenant._id },
      { $set: { publicDemo: true } },
    );
    const login = await request(app).post('/api/v1/auth/public-demo/session').send({ role: 'administrator' });
    const headers = { 'X-Session-Id': login.body.data.sessionId as string };

    expect((await request(app).get('/api/v1/personas').set(headers)).status).toBe(200);

    const mutation = await request(app).post('/api/v1/personas').set(headers).send({});
    expect(mutation.status).toBe(403);
    expect(mutation.body.error.code).toBe('FORBIDDEN');
    expect(await AuditLogModel.countDocuments({ action: 'access.denied', 'payload.code': 'FORBIDDEN' })).toBe(1);

    const unmask = await request(app).get('/api/v1/audit-logs').query({ unmask: 'true' }).set(headers);
    expect(unmask.status).toBe(403);
    expect(unmask.body.error.code).toBe('FORBIDDEN');

    for (const path of [
      '/api/v1/reports/summary/export?format=csv',
      '/api/v1/datasets/some-id',
      '/api/v1/audit-logs/verify',
      '/api/v1/assessments/some-id/reconstruct',
      '/api/v1/reports/summary?refresh=true',
    ]) {
      const blocked = await request(app).get(path).set(headers);
      expect(blocked.status, path).toBe(403);
      expect(blocked.body.error.code, path).toBe('FORBIDDEN');
    }

    const logout = await request(app).delete('/api/v1/auth/session').set(headers);
    expect(logout.status).toBe(200);
    expect(logout.headers['cache-control']).toBe('no-store');
    expect((await SessionModel.findOne({ sessionId: headers['X-Session-Id'] }).lean())?.terminationReason).toBe('logout');
  });

  it('revalidates the demo kill switch and persisted flags on every session touch [SEC-02, SEC-03]', async () => {
    const tenant = (await TenantModel.findOneAndUpdate(
      { slug: 'tac' },
      { $set: { publicDemo: true } },
      { new: true },
    ).select('+publicDemo'))!;
    const user = (await UserModel.findOneAndUpdate(
      { email: 'audit@dev.local', tenantId: tenant._id },
      { $set: { publicDemo: true } },
      { new: true },
    ).select('+publicDemo'))!;
    const login = await request(app).post('/api/v1/auth/public-demo/session').send({ role: 'audit' });
    const sessionId = login.body.data.sessionId as string;
    const access = () => request(app).get('/api/v1/me').set('X-Session-Id', sessionId);
    expect((await access()).status).toBe(200);

    const originalFlag = env.PUBLIC_DEMO_ACCESS_ENABLED;
    let disabled;
    try {
      env.PUBLIC_DEMO_ACCESS_ENABLED = false;
      disabled = await access();
    } finally {
      env.PUBLIC_DEMO_ACCESS_ENABLED = originalFlag;
    }
    expect(disabled.status).toBe(401);
    expect(disabled.body.error.code).toBe('SESSION_INVALID');

    const replacement = await request(app).post('/api/v1/auth/public-demo/session').send({ role: 'audit' });
    const replacementId = replacement.body.data.sessionId as string;
    await UserModel.updateOne({ _id: user._id }, { $set: { publicDemo: false } });
    const unflagged = await request(app)
      .get('/api/v1/me')
      .set('X-Session-Id', replacementId);
    expect(unflagged.status).toBe(401);
    expect(unflagged.body.error.code).toBe('SESSION_INVALID');

    await UserModel.updateOne({ _id: user._id }, { $set: { publicDemo: true } });
    const tenantReplacement = await request(app).post('/api/v1/auth/public-demo/session').send({ role: 'audit' });
    await TenantModel.updateOne({ _id: tenant._id }, { $set: { publicDemo: false } });
    const tenantUnflagged = await request(app)
      .get('/api/v1/me')
      .set('X-Session-Id', tenantReplacement.body.data.sessionId as string);
    expect(tenantUnflagged.status).toBe(401);
  });

  it('never upgrades Firebase bearer or an unflagged lookalike to public-demo assurance [SEC-03]', async () => {
    const tenant = await TenantModel.findOne({ slug: 'tac' });
    expect(tenant).toBeTruthy();
    await TenantModel.updateOne({ _id: tenant!._id }, { $set: { publicDemo: true } });
    await UserModel.updateOne({ email: 'admin@dev.local' }, { $set: { publicDemo: false } });
    await UserModel.create({
      firebaseUid: 'public-demo-lookalike',
      email: 'admin-lookalike@dev.local',
      name: 'Flagged lookalike',
      role: 'administrator',
      tenantId: tenant!._id,
      publicDemo: true,
    });

    const denied = await request(app)
      .post('/api/v1/auth/session')
      .set('Authorization', 'Bearer uid:not-demo-admin:admin@dev.local::password');
    expect(denied.status).toBe(401);
    // Test mode retains the separate legacy non-production SSO convenience, but it must still use
    // the ordinary PAID OTP policy and can never mint public_demo assurance from the address shape.
    expect(denied.body.error.code).toBe('OTP_REQUIRED');

    const unavailable = await request(app).post('/api/v1/auth/public-demo/session').send({ role: 'administrator' });
    expect(unavailable.status).toBe(403);
    expect(await SessionModel.countDocuments({ 'loginAssurance.method': 'public_demo' })).toBe(0);
  });

  it('rejects ordinary bearer and session-exchange reuse for a flagged public-demo identity [SEC-03]', async () => {
    const tenant = (await TenantModel.findOneAndUpdate(
      { slug: 'tac' },
      { $set: { publicDemo: true } },
      { new: true },
    ).select('+publicDemo'))!;
    await UserModel.updateOne({ email: 'admin@dev.local', tenantId: tenant._id }, { $set: { publicDemo: true } });

    const bearer = await request(app)
      .post('/api/v1/auth/session')
      .set('Authorization', 'Bearer uid:public-demo-admin:admin@dev.local:mfa:oidc.tac');
    expect(bearer.status).toBe(403);
    expect(await SessionModel.countDocuments({ 'loginAssurance.method': 'public_demo' })).toBe(0);

    const demo = await request(app).post('/api/v1/auth/public-demo/session').send({ role: 'administrator' });
    const reused = await request(app)
      .post('/api/v1/auth/session')
      .set('X-Session-Id', demo.body.data.sessionId as string);
    expect(reused.status).toBe(403);
    expect(await SessionModel.countDocuments({ 'loginAssurance.method': 'development_bypass' })).toBe(0);
  });

  it('keeps a promoted identity and its standard session invalid when the public-demo kill switch is off [SEC-02, SEC-03]', async () => {
    const standard = await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'admin@dev.local');
    expect(standard.status).toBe(201);
    const tenant = (await TenantModel.findOneAndUpdate(
      { slug: 'tac' },
      { $set: { publicDemo: true } },
      { new: true },
    ).select('+publicDemo'))!;
    await UserModel.updateOne({ email: 'admin@dev.local', tenantId: tenant._id }, { $set: { publicDemo: true } });

    const originalFlag = env.PUBLIC_DEMO_ACCESS_ENABLED;
    const [ordinary, stale] = await (async () => {
      try {
        env.PUBLIC_DEMO_ACCESS_ENABLED = false;
        return await Promise.all([
          request(app).post('/api/v1/auth/session').set('X-Dev-User', 'admin@dev.local'),
          request(app)
            .get('/api/v1/me')
            .set('X-Dev-User', 'admin@dev.local')
            .set('X-Session-Id', standard.body.data.sessionId as string),
        ]);
      } finally {
        env.PUBLIC_DEMO_ACCESS_ENABLED = originalFlag;
      }
    })();
    expect(ordinary.status).toBe(403);
    expect(ordinary.body.error.code).toBe('FORBIDDEN');
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('SESSION_INVALID');
  });

  it('caps public-demo concurrency without evicting older viewers and leaves TAC standard policy intact [FR-04, SEC-02]', async () => {
    const tenant = (await TenantModel.findOneAndUpdate(
      { slug: 'tac' },
      { $set: { publicDemo: true, 'sessionPolicy.maxConcurrentSessions': 1, 'features.blockConcurrentLogin': true } },
      { new: true },
    ).select('+publicDemo'))!;
    await UserModel.updateOne({ email: 'audit@dev.local', tenantId: tenant._id }, { $set: { publicDemo: true } });

    const sessions = [];
    for (let index = 0; index < 10; index++) {
      const response = await request(app).post('/api/v1/auth/public-demo/session').send({ role: 'audit' });
      expect(response.status, String(index)).toBe(201);
      sessions.push(response.body.data.sessionId as string);
    }
    const excess = await request(app).post('/api/v1/auth/public-demo/session').send({ role: 'audit' });
    expect(excess.status).toBe(409);
    expect(excess.body.error.code).toBe('CONCURRENT_LOGIN_BLOCKED');
    expect(await SessionModel.countDocuments({ sessionId: { $in: sessions }, terminatedAt: null })).toBe(10);

    const standardFirst = await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'admin2@dev.local');
    const standardSecond = await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'admin2@dev.local');
    expect(standardFirst.status).toBe(201);
    expect(standardSecond.status).toBe(409);
  });

  it('expires public-demo sessions at their absolute lifetime even if the idle window remains open [SEC-02]', async () => {
    const tenant = (await TenantModel.findOneAndUpdate(
      { slug: 'tac' },
      { $set: { publicDemo: true } },
      { new: true },
    ).select('+publicDemo'))!;
    await UserModel.updateOne({ email: 'audit@dev.local', tenantId: tenant._id }, { $set: { publicDemo: true } });
    const login = await request(app).post('/api/v1/auth/public-demo/session').send({ role: 'audit' });
    await SessionModel.updateOne(
      { sessionId: login.body.data.sessionId },
      { $set: { absoluteExpiresAt: new Date(Date.now() - 1), expiresAt: new Date(Date.now() + 60_000) } },
    );
    const expired = await request(app).get('/api/v1/me').set('X-Session-Id', login.body.data.sessionId as string);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('SESSION_EXPIRED');
  });
});
