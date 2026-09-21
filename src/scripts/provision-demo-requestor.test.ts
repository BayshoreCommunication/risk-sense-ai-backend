import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Auth, UserRecord } from 'firebase-admin/auth';
import { AuditLogModel } from '../modules/audit/model';
import { audit } from '../modules/audit/service';
import { SessionModel } from '../modules/auth/model';
import { TenantModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';
import {
  PUBLIC_DEMO_IDENTITIES,
  assertSafeDemoFirebaseState,
  assertSafeDemoMongoState,
  disableFirebaseDemoIdentity,
  isFirebaseUserNotFound,
  reconcileMongoUser,
  requirePublicDemoTenantId,
  type DemoMongoState,
  type PublicDemoIdentity,
} from './provision-demo-requestor';

const identity = PUBLIC_DEMO_IDENTITIES[1]!;
const tacId = '000000000000000000000001';
const validState = (overrides: Partial<DemoMongoState> = {}): DemoMongoState => ({
  demoTenant: { id: tacId, plan: 'paid', publicDemo: true },
  emailUser: {
    id: 'demo-user-id',
    email: identity.email,
    tenantId: tacId,
    role: identity.role,
    firebaseUid: 'firebase-demo-uid',
    status: 'active',
    publicDemo: true,
  },
  uidUser: { id: 'demo-user-id', email: identity.email },
  ...overrides,
});

describe('shared four-role public demo operator guards [FR-01, FR-02, SEC-03, SEC-07]', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defines exactly one fixed identity per role in the synthetic TAC tenant [FR-02]', () => {
    expect(PUBLIC_DEMO_IDENTITIES.map(({ email, role }) => ({ email, role }))).toEqual([
      { email: 'requestor@tac.local', role: 'requestor' },
      { email: 'admin@dev.local', role: 'administrator' },
      { email: 'sysadmin@dev.local', role: 'system_administrator' },
      { email: 'audit@dev.local', role: 'audit' },
    ]);
  });

  it('requires an explicit immutable Mongo tenant id and never infers it from the TAC slug [SEC-03]', () => {
    expect(() => requirePublicDemoTenantId(undefined)).toThrow('PUBLIC_DEMO_TENANT_ID is required');
    expect(() => requirePublicDemoTenantId('tac')).toThrow('24-character Mongo ObjectId');
    expect(requirePublicDemoTenantId('ABCDEFABCDEFABCDEFABCDEF')).toBe('abcdefabcdefabcdefabcdef');
  });

  it('treats only Firebase\'s exact missing-user code as an absent credential [FR-01]', () => {
    expect(isFirebaseUserNotFound({ code: 'auth/user-not-found' })).toBe(true);
    expect(isFirebaseUserNotFound({ errorInfo: { code: 'auth/user-not-found' } })).toBe(true);
    expect(isFirebaseUserNotFound({ code: 'auth/internal-error' })).toBe(false);
    expect(isFirebaseUserNotFound(new Error('user not found'))).toBe(false);
  });

  it('disables a legacy Firebase identity and revokes its refresh tokens without creating credentials [SEC-03]', async () => {
    const updateUser = vi.fn().mockResolvedValue(undefined);
    const revokeRefreshTokens = vi.fn().mockResolvedValue(undefined);
    const auth = { updateUser, revokeRefreshTokens } as unknown as Auth;
    const firebaseUser = { uid: 'legacy-public-demo-uid' } as UserRecord;

    await expect(disableFirebaseDemoIdentity(auth, firebaseUser)).resolves.toBe('disabled_and_revoked');
    expect(updateUser).toHaveBeenCalledWith(firebaseUser.uid, { disabled: true });
    expect(revokeRefreshTokens).toHaveBeenCalledWith(firebaseUser.uid);
    await expect(disableFirebaseDemoIdentity(auth, null)).resolves.toBe('absent');
    expect(updateUser).toHaveBeenCalledTimes(1);
  });

  it('accepts one email/bound Firebase identity or a renamed bound identity, but rejects ambiguity [SEC-03]', () => {
    const same = { uid: 'legacy-uid', email: identity.email } as UserRecord;
    expect(() => assertSafeDemoFirebaseState(identity, same, same)).not.toThrow();
    expect(() => assertSafeDemoFirebaseState(
      identity,
      null,
      { uid: 'legacy-uid', email: 'renamed@example.com' } as UserRecord,
    )).not.toThrow();
    expect(() => assertSafeDemoFirebaseState(
      identity,
      same,
      { uid: 'different-bound-uid', email: 'renamed@example.com' } as UserRecord,
    )).toThrow('ambiguous credential retirement');
  });

  it('fails closed if Firebase token revocation fails after disabling the identity [SEC-03]', async () => {
    const updateUser = vi.fn().mockResolvedValue(undefined);
    const revokeRefreshTokens = vi.fn().mockRejectedValue(new Error('forced revoke failure'));
    const auth = { updateUser, revokeRefreshTokens } as unknown as Auth;

    await expect(disableFirebaseDemoIdentity(auth, { uid: 'legacy-uid' } as UserRecord)).rejects.toThrow('forced revoke failure');
    expect(updateUser).toHaveBeenCalledWith('legacy-uid', { disabled: true });
    expect(revokeRefreshTokens).toHaveBeenCalledWith('legacy-uid');
  });

  it('accepts exact existing or absent identities in the PAID TAC tenant [FR-01, FR-02]', () => {
    expect(() => assertSafeDemoMongoState(identity, validState(), tacId)).not.toThrow();
    expect(() => assertSafeDemoMongoState(identity, validState({ emailUser: null, uidUser: null }), tacId)).not.toThrow();
  });

  it('refuses a missing, mismatched, or non-PAID TAC tenant before provisioning [SEC-03]', () => {
    expect(() => assertSafeDemoMongoState(identity, validState({ demoTenant: null }), tacId)).toThrow('refusing to provision');
    expect(() => assertSafeDemoMongoState(identity, validState(), '000000000000000000000002')).toThrow('tenant id mismatch');
    expect(() => assertSafeDemoMongoState(identity, validState({
      demoTenant: { id: tacId, plan: 'free', publicDemo: false },
    }), tacId)).toThrow('must have plan "paid"');
  });

  it('refuses to move, change the role of, or steal the UID from another account [SEC-03]', () => {
    expect(() => assertSafeDemoMongoState(identity, validState({
      emailUser: { ...validState().emailUser!, tenantId: 'other-tenant' },
    }), tacId)).toThrow('refusing to move');
    expect(() => assertSafeDemoMongoState(identity, validState({
      emailUser: { ...validState().emailUser!, role: 'audit' },
    }), tacId)).toThrow('refusing to change its role');
    expect(() => assertSafeDemoMongoState(identity, validState({
      uidUser: { id: 'other-user-id', email: 'other@example.com' },
    }), tacId)).toThrow('belongs to another Mongo user');
  });

  it('atomically marks the exact tenant/user and writes audit evidence [FR-01, SEC-03, SEC-07]', async () => {
    const tenant = await TenantModel.create({ name: 'TAC synthetic demo', slug: 'tac', plan: 'paid' });
    const state = validState({
      demoTenant: { id: String(tenant._id), plan: 'paid', publicDemo: false },
      emailUser: null,
      uidUser: null,
    });

    const created = await reconcileMongoUser(identity, state, String(tenant._id));
    expect(created.action).toBe('created');
    expect(await UserModel.findOne({ email: identity.email }).select('+publicDemo').lean()).toMatchObject({
      firebaseUid: `public-demo:${identity.role}`,
      role: identity.role,
      status: 'active',
      publicDemo: true,
    });
    expect((await TenantModel.findById(tenant._id).select('+publicDemo').lean())?.publicDemo).toBe(true);
    expect(await TenantModel.findById(tenant._id).lean()).toMatchObject({
      sessionPolicy: { maxConcurrentSessions: 1 },
      features: { blockConcurrentLogin: false },
    });
    expect(await AuditLogModel.findOne({ action: 'user.provisioned' }).lean()).toMatchObject({
      tenantId: tenant._id,
      payload: { email: identity.email, accessMode: 'public_demo_read_only' },
    });
  });

  it('rolls the tenant and identity flags back when audit evidence fails [SEC-03, SEC-07]', async () => {
    const tenant = await TenantModel.create({ name: 'TAC synthetic demo', slug: 'tac', plan: 'paid' });
    const state = validState({
      demoTenant: { id: String(tenant._id), plan: 'paid', publicDemo: false },
      emailUser: null,
      uidUser: null,
    });
    vi.spyOn(audit, 'write').mockRejectedValueOnce(new Error('forced audit failure'));

    await expect(reconcileMongoUser(identity, state, String(tenant._id))).rejects.toThrow('forced audit failure');
    expect(await UserModel.findOne({ email: identity.email })).toBeNull();
    expect((await TenantModel.findById(tenant._id).select('+publicDemo').lean())?.publicDemo).toBe(false);
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });

  it('repairs flags/placeholder once and leaves a current row unchanged [SEC-03, SEC-07]', async () => {
    const tenant = await TenantModel.create({ name: 'TAC synthetic demo', slug: 'tac', plan: 'paid' });
    const user = await UserModel.create({
      firebaseUid: `dev:${identity.email}`,
      email: identity.email,
      name: identity.name,
      role: identity.role,
      tenantId: tenant._id,
      status: 'disabled',
    });
    const before = validState({
      demoTenant: { id: String(tenant._id), plan: 'paid', publicDemo: false },
      emailUser: {
        id: String(user._id),
        email: user.email,
        tenantId: String(tenant._id),
        role: user.role,
        firebaseUid: user.firebaseUid,
        status: user.status,
        publicDemo: false,
      },
      uidUser: null,
    });

    await SessionModel.create({
      sessionId: 'pre-promotion-standard-session',
      userId: user._id,
      tenantId: tenant._id,
      slot: 0,
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      loginAssurance: { method: 'risk_sense_otp', mfaVerifiedAt: new Date() },
    });

    expect((await reconcileMongoUser(identity, before, String(tenant._id))).action).toBe('updated');
    const linked = (await UserModel.findById(user._id).select('+publicDemo').lean())!;
    expect(linked).toMatchObject({ firebaseUid: `dev:${identity.email}`, status: 'active', publicDemo: true });
    expect(await SessionModel.findOne({ sessionId: 'pre-promotion-standard-session' }).lean()).toMatchObject({
      terminationReason: 'admin',
    });

    const current: DemoMongoState = {
      demoTenant: { id: String(tenant._id), plan: 'paid', publicDemo: true },
      emailUser: {
        id: String(linked._id),
        email: linked.email,
        tenantId: String(linked.tenantId),
        role: linked.role,
        firebaseUid: linked.firebaseUid,
        status: linked.status,
        publicDemo: true,
      },
      uidUser: { id: String(linked._id), email: linked.email },
    };
    await SessionModel.create({
      sessionId: 'session-before-idempotent-reconcile',
      userId: linked._id,
      tenantId: tenant._id,
      slot: 1,
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      loginAssurance: { method: 'public_demo' },
      absoluteExpiresAt: new Date(Date.now() + 60_000),
    });
    expect((await reconcileMongoUser(identity as PublicDemoIdentity, current, String(tenant._id))).action).toBe('unchanged');
    expect(await SessionModel.findOne({ sessionId: 'session-before-idempotent-reconcile' }).lean()).toMatchObject({
      terminationReason: 'admin',
    });
    expect(await AuditLogModel.countDocuments({ action: 'user.updated' })).toBe(1);
  });
});
