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
import { AuditLogModel } from '../audit/model';
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';

describe('SSO via Firebase OIDC/OAuth providers [FR-03, SEC-03]', () => {
  beforeEach(async () => {
    await seeded();
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

  it('an unknown user on the SSO domain is provisioned into that tenant and skips the email OTP', async () => {
    const res = await bearer('uid:sso-1:jane@acme.com:-:oidc.acme');
    expect(res.status).toBe(201);
    expect(res.body.data.tenant.slug).toBe('acme');
    expect(res.body.data.user.role).toBe('requestor');
    const user = await UserModel.findOne({ firebaseUid: 'sso-1' }).lean();
    expect(String(user!.tenantId)).toBe(String((await TenantModel.findOne({ slug: 'acme' }))!._id));
    const signup = await AuditLogModel.findOne({ action: 'auth.self_signup', 'entity.id': String(user!._id) }).lean();
    expect(signup!.payload).toMatchObject({ tenant: 'acme', viaSso: true });
    const created = await AuditLogModel.findOne({ action: 'session.created', actorUserId: user!._id }).lean();
    expect(created!.payload).toMatchObject({ signInProvider: 'oidc.acme' });
  });

  it('paid requestors must use configured SSO; privileged roles also complete OTP [FR-03, SEC-03]', async () => {
    await bearer('uid:sso-2:bob@acme.com:-:oidc.acme');
    const pw = await bearer('uid:sso-2:bob@acme.com:-:password');
    expect(pw.status).toBe(401);
    expect(pw.body.error.code).toBe('SSO_REQUIRED');
    // an administrator of the tenant signing in through SSO still completes our second factor
    await UserModel.create({ firebaseUid: 'dev:sso-admin', email: 'ops@acme.com', name: 'Acme Ops', role: 'administrator', tenantId: (await TenantModel.findOne({ slug: 'acme' }))!._id, mfaEnrolled: true });
    const admin = await bearer('uid:sso-admin-uid:ops@acme.com:-:oidc.acme');
    expect(admin.status).toBe(401);
    expect(admin.body.error.code).toBe('OTP_REQUIRED');
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

  it('system administrators configure SSO and policies for their tenant; changes are audited [FR-03, FR-25, SEC-02]', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const before = await request(app).get('/api/v1/system/tenant').set(sysadmin);
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ slug: 'public', plan: 'free', sso: { providerId: null, domain: null } });
    // enabling SSO without a domain is refused
    const bad = await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ features: { sso: true } });
    expect(bad.status).toBe(400);
    // a domain another tenant already claims is refused
    const clash = await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sso: { providerId: 'saml.bayshore', domain: 'acme.com' } });
    expect(clash.status).toBe(409);
    const okRes = await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sso: { providerId: 'saml.bayshore', domain: 'Bayshore.example' }, features: { sso: true }, sessionPolicy: { idleTimeoutMin: 20 }, authPolicy: { otpRequired: false } });
    expect(okRes.status).toBe(200);
    expect(okRes.body.data).toMatchObject({ sso: { providerId: 'saml.bayshore', domain: 'bayshore.example' }, features: { sso: true }, sessionPolicy: { idleTimeoutMin: 20 }, authPolicy: { otpRequired: false } });
    const entry = await AuditLogModel.findOne({ action: 'tenant.updated' }).lean();
    expect(entry!.category).toBe('config');
    expect([...(entry!.payload as { changed: string[] }).changed].sort()).toEqual(['authPolicy', 'features', 'sessionPolicy', 'sso']);
    expect((entry!.payload as { before: { sso: { domain: null } } }).before.sso.domain).toBeNull();
    expect((await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ unknown: 1 })).status).toBe(400);
    expect((await request(app).get('/api/v1/system/tenant').set(await login('admin@dev.local'))).status).toBe(403);
    expect((await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sessionPolicy: { idleTimeoutMin: 60 } })).status).toBe(400);
  });
});
