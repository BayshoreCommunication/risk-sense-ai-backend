import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Token "uid:<uid>:<email>:<mfa|->:<provider>" → verified identity with a sign-in provider (FR-03).
vi.mock('../../lib/firebase', () => ({
  verifyIdToken: async (token: string) => {
    if (!token.startsWith('uid:')) {
      const { AppError } = await import('../../lib/errors');
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired ID token');
    }
    const [, uid, email, mfa, provider] = token.split(':');
    return { uid, email, name: 'SSO User', mfa: mfa === 'mfa', signInProvider: provider || 'password' };
  },
}));

import { app, login, seeded } from '../../tests/helpers';
import { env } from '../../config/env';
import { AuditLogModel } from '../audit/model';
import { PersonaModel } from '../personas/model';
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { SessionModel } from './model';

describe('SSO via Firebase OIDC/OAuth providers [FR-03, SEC-03]', () => {
  beforeEach(async () => {
    await seeded();
    env.PUBLIC_DEMO_TENANT_ID = '000000000000000000000001';
    await TenantModel.updateOne({ slug: 'acme' }, { $set: { 'features.sso': true, sso: { providerId: 'oidc.acme', domain: 'acme.com' } } });
  });

  const bearer = (token: string) => request(app).post('/api/v1/auth/session').set('Authorization', `Bearer ${token}`);

  it('lookup tells the login page which provider to use for a domain, and nothing else', async () => {
    const yes = await request(app).get('/api/v1/auth/sso/lookup').query({ email: 'Jane@Acme.com' });
    expect(yes.body.data).toEqual({ providerId: 'oidc.acme', tenant: 'Acme Financial (PAID demo)' });
    const no = await request(app).get('/api/v1/auth/sso/lookup').query({ email: 'someone@gmail.com' });
    expect(no.body.data).toEqual({ providerId: null, tenant: null });
    expect((await request(app).get('/api/v1/auth/sso/lookup').query({ email: 'not-an-email' })).status).toBe(400);
  });

  it('an unknown user with configured SSO plus Firebase MFA is provisioned without an email challenge', async () => {
    const res = await bearer('uid:sso-1:jane@acme.com:mfa:oidc.acme');
    expect(res.status).toBe(201);
    expect(res.body.data.tenant.slug).toBe('acme');
    expect(res.body.data.user.role).toBe('requestor');
    const user = await UserModel.findOne({ firebaseUid: 'sso-1' }).lean();
    expect(String(user!.tenantId)).toBe(String((await TenantModel.findOne({ slug: 'acme' }))!._id));
    const signup = await AuditLogModel.findOne({ action: 'auth.self_signup', 'entity.id': String(user!._id) }).lean();
    expect(signup!.payload).toMatchObject({ tenant: 'acme', viaSso: true });
    const created = await AuditLogModel.findOne({ action: 'session.created', actorUserId: user!._id }).lean();
    expect(created!.payload).toMatchObject({ signInProvider: 'oidc.acme', authenticationMethod: 'firebase_mfa' });
    expect((await SessionModel.findOne({ sessionId: res.body.data.sessionId }).lean())?.loginAssurance).toMatchObject({
      method: 'firebase_mfa',
      mfaVerifiedAt: expect.any(Date),
    });
  });

  it('fails closed for legacy paid sessions and lets a compliant re-login replace them [SEC-02, SEC-03]', async () => {
    const token = 'uid:legacy-paid:legacy@acme.com:mfa:oidc.acme';
    const login = await bearer(token);
    expect(login.status).toBe(201);
    const legacySessionId = login.body.data.sessionId as string;
    const user = await UserModel.findOne({ firebaseUid: 'legacy-paid' }).lean();
    expect(user?.mfaEnrolled).toBe(true);

    const priorLastSeenAt = new Date(Date.now() - 60_000);
    await SessionModel.collection.updateOne(
      { sessionId: legacySessionId },
      {
        $unset: { loginAssurance: '' },
        $set: { lastSeenAt: priorLastSeenAt, expiresAt: new Date(Date.now() + 10 * 60_000) },
      },
    );
    const denied = await request(app)
      .get('/api/v1/me')
      // A later token and historical enrollment must not upgrade an unclassified legacy session.
      .set('Authorization', 'Bearer uid:legacy-paid:legacy@acme.com:-:oidc.acme')
      .set('X-Session-Id', legacySessionId);
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('SESSION_INVALID');
    const unchanged = await SessionModel.findOne({ sessionId: legacySessionId }).lean();
    expect(unchanged?.lastSeenAt.getTime()).toBe(priorLastSeenAt.getTime());
    expect(unchanged?.terminatedAt).toBeUndefined();

    // An invalid legacy row cannot deadlock a tenant whose policy blocks concurrent logins.
    await TenantModel.updateOne({ slug: 'acme' }, { $set: { 'features.blockConcurrentLogin': true } });
    const replacement = await bearer(token);
    expect(replacement.status).toBe(201);
    expect((await SessionModel.findOne({ sessionId: legacySessionId }).lean())?.terminationReason).toBe('superseded');
    expect((await SessionModel.findOne({ sessionId: replacement.body.data.sessionId }).lean())?.loginAssurance).toMatchObject({
      method: 'firebase_mfa',
      mfaVerifiedAt: expect.any(Date),
    });
  });

  it('paid requestors may use Firebase MFA while managed operators complete RiskSense OTP [FR-03, SEC-03]', async () => {
    const missingMfa = await bearer('uid:sso-2:bob@acme.com:-:oidc.acme');
    expect(missingMfa.status).toBe(401);
    expect(missingMfa.body.error.code).toBe('OTP_REQUIRED');
    const withMfa = await bearer('uid:sso-2:bob@acme.com:mfa:oidc.acme');
    expect(withMfa.status).toBe(201);
    const pw = await bearer('uid:sso-2:bob@acme.com:-:password');
    expect(pw.status).toBe(401);
    expect(pw.body.error.code).toBe('SSO_REQUIRED');
    // an administrator of the tenant signing in through SSO still completes our second factor
    await UserModel.create({ firebaseUid: 'dev:sso-admin', email: 'ops@acme.com', name: 'Acme Ops', role: 'administrator', tenantId: (await TenantModel.findOne({ slug: 'acme' }))!._id, mfaEnrolled: true });
    const admin = await bearer('uid:sso-admin-uid:ops@acme.com:-:oidc.acme');
    expect(admin.status).toBe(401);
    expect(admin.body.error.code).toBe('OTP_REQUIRED');
    // Audit is a managed PAID role and must not fall through when optional tenant OTP is disabled.
    await TenantModel.updateOne({ slug: 'acme' }, { $set: { 'authPolicy.otpRequired': false } });
    await UserModel.create({ firebaseUid: 'dev:sso-audit', email: 'audit@acme.com', name: 'Acme Audit', role: 'audit', tenantId: (await TenantModel.findOne({ slug: 'acme' }))!._id });
    // Even a current Firebase-MFA claim cannot replace the RiskSense-controlled factor for audit.
    const audit = await bearer('uid:sso-audit-uid:audit@acme.com:mfa:oidc.acme');
    expect(audit.status).toBe(401);
    expect(audit.body.error.code).toBe('OTP_REQUIRED');
    const issued = await request(app)
      .post('/api/v1/auth/otp/request')
      .set('Authorization', 'Bearer uid:sso-audit-uid:audit@acme.com:-:oidc.acme');
    const auditLogin = await bearer('uid:sso-audit-uid:audit@acme.com:-:oidc.acme').send({
      otpCode: issued.body.data.devCode,
    });
    expect(auditLogin.status).toBe(201);
    expect((await SessionModel.findOne({ sessionId: auditLogin.body.data.sessionId }).lean())?.loginAssurance).toMatchObject({
      method: 'risk_sense_otp',
      mfaVerifiedAt: expect.any(Date),
    });
    // SSO disabled on the tenant → the provider match no longer counts
    await TenantModel.updateOne({ slug: 'acme' }, { $set: { 'features.sso': false } });
    const off = await bearer('uid:sso-2:bob@acme.com:-:oidc.acme');
    expect(off.status).toBe(401);
    expect(off.body.error.code).toBe('SSO_REQUIRED');
  });

  it('does not JIT-provision a paid-domain identity authenticated by the wrong provider [FR-03]', async () => {
    const res = await bearer('uid:wrong-provider:intruder@acme.com:-:google.com');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SSO_REQUIRED');
    expect(await UserModel.countDocuments({ email: 'intruder@acme.com' })).toBe(0);
  });

  it('excludes the public demo tenant from SSO lookup, JIT, and ordinary domain ownership [FR-03, SEC-01, SEC-03]', async () => {
    const tac = (await TenantModel.findOneAndUpdate(
      { slug: 'tac' },
      {
        $set: {
          publicDemo: true,
          'features.sso': true,
          sso: { providerId: 'oidc.demo', domain: 'customer.example' },
        },
      },
      { new: true },
    ).select('+publicDemo'))!;
    env.PUBLIC_DEMO_TENANT_ID = String(tac._id);
    await UserModel.updateOne(
      { email: 'sysadmin@dev.local', tenantId: tac._id },
      { $set: { publicDemo: true } },
    );

    const hidden = await request(app)
      .get('/api/v1/auth/sso/lookup')
      .query({ email: 'person@customer.example' });
    expect(hidden.body.data).toEqual({ providerId: null, tenant: null });
    const notJitIntoDemo = await bearer('uid:demo-domain-user:person@customer.example:mfa:oidc.demo');
    expect(notJitIntoDemo.status).toBe(201);
    expect(notJitIntoDemo.body.data.tenant.slug).toBe('public');
    expect(String((await UserModel.findOne({ firebaseUid: 'demo-domain-user' }).lean())?.tenantId))
      .not.toBe(String(tac._id));

    const acme = (await TenantModel.findOne({ slug: 'acme' }))!;
    await UserModel.create({
      firebaseUid: 'dev:acme-sysadmin@ops.example',
      email: 'acme-sysadmin@ops.example',
      name: 'Acme System Administrator',
      role: 'system_administrator',
      tenantId: acme._id,
      mfaEnrolled: true,
    });
    const acmeSystemAdmin = await login('acme-sysadmin@ops.example');
    const claimed = await request(app)
      .patch('/api/v1/system/tenant')
      .set(acmeSystemAdmin)
      .send({
        sso: { providerId: 'oidc.customer', domain: 'customer.example' },
        features: { sso: true },
      });
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    const discovered = await request(app)
      .get('/api/v1/auth/sso/lookup')
      .query({ email: 'new@customer.example' });
    expect(discovered.body.data).toEqual({ providerId: 'oidc.customer', tenant: 'Acme Financial (PAID demo)' });
    const ordinaryJit = await bearer('uid:customer-user:new@customer.example:mfa:oidc.customer');
    expect(ordinaryJit.status).toBe(201);
    expect(ordinaryJit.body.data.tenant.slug).toBe('acme');

    const demoLogin = await request(app)
      .post('/api/v1/auth/public-demo/session')
      .send({ role: 'system_administrator' });
    expect(demoLogin.status).toBe(201);
    const demoHeaders = { 'X-Session-Id': demoLogin.body.data.sessionId as string };
    const unsafeDomain = await request(app)
      .patch('/api/v1/system/tenant')
      .set(demoHeaders)
      .send({ sso: { providerId: 'oidc.demo', domain: 'another-customer.example' } });
    expect(unsafeDomain.status).toBe(400);
    const reservedDomain = await request(app)
      .patch('/api/v1/system/tenant')
      .set(demoHeaders)
      .send({
        sso: { providerId: 'oidc.demo', domain: 'sandbox.invalid' },
        features: { sso: true },
      });
    expect(reservedDomain.status, JSON.stringify(reservedDomain.body)).toBe(200);
    const reservedHidden = await request(app)
      .get('/api/v1/auth/sso/lookup')
      .query({ email: 'person@sandbox.invalid' });
    expect(reservedHidden.body.data).toEqual({ providerId: null, tenant: null });
  });

  it('system administrators configure SSO and policies for their tenant; changes are audited [FR-03, FR-25, SEC-02]', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const before = await request(app).get('/api/v1/system/tenant').set(sysadmin);
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ slug: 'tac', plan: 'paid', sso: { providerId: null, domain: null } });
    // enabling SSO without a domain is refused
    const bad = await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ features: { sso: true } });
    expect(bad.status).toBe(400);
    // a domain another tenant already claims is refused
    const clash = await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sso: { providerId: 'saml.bayshore', domain: 'acme.com' } });
    expect(clash.status).toBe(409);
    const okRes = await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sso: { providerId: 'saml.bayshore', domain: 'Bayshore.example' }, features: { sso: true }, sessionPolicy: { idleTimeoutMin: 20 }, authPolicy: { otpRequired: false } });
    expect(okRes.status).toBe(200);
    // Legacy clients may still send authPolicy, but PAID always reports and stores the effective
    // required value so a settings response cannot imply that current-login MFA was disabled.
    expect(okRes.body.data).toMatchObject({ sso: { providerId: 'saml.bayshore', domain: 'bayshore.example' }, features: { sso: true }, sessionPolicy: { idleTimeoutMin: 20 }, authPolicy: { otpRequired: true } });
    expect((await TenantModel.findOne({ slug: 'tac' }).lean())?.authPolicy.otpRequired).toBe(true);
    const entry = await AuditLogModel.findOne({ action: 'tenant.updated' }).lean();
    expect(entry!.category).toBe('config');
    expect([...(entry!.payload as { changed: string[] }).changed].sort()).toEqual(['authPolicy', 'features', 'sessionPolicy', 'sso']);
    expect((entry!.payload as { before: { sso: { domain: null } } }).before.sso.domain).toBeNull();
    expect((await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ unknown: 1 })).status).toBe(400);
    expect((await request(app).get('/api/v1/system/tenant').set(await login('admin@dev.local'))).status).toBe(403);
    expect((await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sessionPolicy: { idleTimeoutMin: 60 } })).status).toBe(400);
  });

  it('uses the tenant-configured sector vocabulary across settings and content APIs [NFR-04, NFR-08]', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const configured = await request(app)
      .patch('/api/v1/system/tenant')
      .set(sysadmin)
      .send({ sectors: ['financial', 'healthcare', 'it', 'energy'] });
    expect(configured.status).toBe(200);
    expect(configured.body.data.sectors).toEqual(['financial', 'healthcare', 'it', 'energy']);

    const admin = await login('admin@dev.local');
    const me = await request(app).get('/api/v1/me').set(admin);
    expect(me.body.data.tenant.sectors).toEqual(['financial', 'healthcare', 'it', 'energy']);
    const persona = {
      key: 'energy_operator',
      name: 'Energy operator',
      sector: 'energy',
      description: 'Owns operational energy risk intake.',
    };
    const created = await request(app).post('/api/v1/personas').set(admin).send(persona);
    expect(created.status).toBe(201);
    expect(created.body.data.sector).toBe('energy');

    const unknown = await request(app).post('/api/v1/personas').set(admin).send({ ...persona, key: 'space_operator', sector: 'space' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toContain('not configured');

    const removeInUse = await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sectors: ['financial', 'healthcare', 'it'] });
    expect(removeInUse.status).toBe(409);
    expect(removeInUse.body.error.message).toContain('energy');
  });

  it('serializes a concurrent sector removal against a new content reference [NFR-04, NFR-08]', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const admin = await login('admin@dev.local');
    expect((await request(app)
      .patch('/api/v1/system/tenant')
      .set(sysadmin)
      .send({ sectors: ['financial', 'healthcare', 'it', 'general', 'energy'] })).status).toBe(200);

    const create = request(app).post('/api/v1/personas').set(admin).send({
      key: 'concurrent_energy_operator',
      name: 'Concurrent energy operator',
      sector: 'energy',
      description: 'Owns energy-sector incidents created during a vocabulary update.',
    });
    const remove = request(app)
      .patch('/api/v1/system/tenant')
      .set(sysadmin)
      .send({ sectors: ['financial', 'healthcare', 'it', 'general'] });
    const [created, removed] = await Promise.all([create, remove]);

    expect([[201, 409], [400, 200]]).toContainEqual([created.status, removed.status]);
    const tenant = await TenantModel.findOne({ slug: 'tac' }).lean();
    const persona = await PersonaModel.findOne({ tenantId: tenant!._id, key: 'concurrent_energy_operator' }).lean();
    // The invariant must hold regardless of which transaction wins: a persisted reference implies
    // that its sector remains configured, while successful removal implies no reference survived.
    expect(Boolean(persona)).toBe(tenant!.sectors.includes('energy'));
  });
});
