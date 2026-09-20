import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditLogModel } from '../modules/audit/model';
import { audit } from '../modules/audit/service';
import { TenantModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';
import {
  assertSafeDemoMongoState,
  isFirebaseUserNotFound,
  reconcileMongoUser,
  requireDemoUserPassword,
  type DemoMongoState,
} from './provision-demo-requestor';

const validState = (overrides: Partial<DemoMongoState> = {}): DemoMongoState => ({
  publicTenant: { id: 'public-id', plan: 'free' },
  emailUser: {
    id: 'demo-user-id',
    email: 'requestor@dev.local',
    tenantId: 'public-id',
    role: 'requestor',
    firebaseUid: 'firebase-demo-uid',
    status: 'active',
  },
  uidUser: { id: 'demo-user-id', email: 'requestor@dev.local' },
  ...overrides,
});

describe('shared FREE demo identity operator guards [FR-01, SEC-03, FR-25, SEC-07]', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires an explicit Firebase-compatible password and supplies no default [FR-01, SEC-03]', () => {
    expect(() => requireDemoUserPassword(undefined)).toThrow('DEMO_USER_PASSWORD is required');
    expect(() => requireDemoUserPassword('')).toThrow('DEMO_USER_PASSWORD is required');
    expect(() => requireDemoUserPassword('short')).toThrow('at least 8 characters');
    expect(() => requireDemoUserPassword('            ')).toThrow('not be blank');
    expect(requireDemoUserPassword('valid password')).toBe('valid password');
  });

  it('creates only after Firebase reports the exact missing-user code [FR-01]', () => {
    expect(isFirebaseUserNotFound({ code: 'auth/user-not-found' })).toBe(true);
    expect(isFirebaseUserNotFound({ errorInfo: { code: 'auth/user-not-found' } })).toBe(true);
    expect(isFirebaseUserNotFound({ code: 'auth/internal-error' })).toBe(false);
    expect(isFirebaseUserNotFound(new Error('user not found'))).toBe(false);
  });

  it('accepts the existing public FREE requestor linked to the same UID [FR-01]', () => {
    expect(() => assertSafeDemoMongoState(validState())).not.toThrow();
    expect(() => assertSafeDemoMongoState(validState({ emailUser: null, uidUser: null }))).not.toThrow();
  });

  it('refuses a missing or non-FREE public tenant before provisioning [SEC-03]', () => {
    expect(() => assertSafeDemoMongoState(validState({ publicTenant: null }))).toThrow('is missing');
    expect(() => assertSafeDemoMongoState(validState({
      publicTenant: { id: 'public-id', plan: 'paid' },
    }))).toThrow('must have plan "free"');
  });

  it('refuses to move, change the role of, or steal the UID from another account [SEC-03]', () => {
    expect(() => assertSafeDemoMongoState(validState({
      emailUser: { ...validState().emailUser!, tenantId: 'other-tenant' },
    }))).toThrow('refusing to move');
    expect(() => assertSafeDemoMongoState(validState({
      emailUser: { ...validState().emailUser!, role: 'administrator' },
    }))).toThrow('refusing to change its role');
    expect(() => assertSafeDemoMongoState(validState({
      uidUser: { id: 'other-user-id', email: 'other@example.com' },
    }))).toThrow('belongs to another Mongo user');
  });

  it('commits a changed Mongo identity and its audit evidence together [FR-01, SEC-03, FR-25, SEC-07]', async () => {
    const tenant = await TenantModel.create({ name: 'Public (FREE)', slug: 'public', plan: 'free' });
    const state = validState({
      publicTenant: { id: String(tenant._id), plan: 'free' },
      emailUser: null,
      uidUser: null,
    });

    const created = await reconcileMongoUser(state, 'firebase-demo-uid');
    expect(created.action).toBe('created');
    expect(await UserModel.findOne({ email: 'requestor@dev.local' }).lean()).toMatchObject({
      firebaseUid: 'firebase-demo-uid',
      role: 'requestor',
      status: 'active',
    });
    expect(await AuditLogModel.findOne({ action: 'user.provisioned' }).lean()).toMatchObject({
      tenantId: tenant._id,
      payload: { email: 'requestor@dev.local', identityLinked: true },
    });
  });

  it('rolls the Mongo identity back when its audit evidence fails [FR-01, SEC-03, FR-25, SEC-07]', async () => {
    const tenant = await TenantModel.create({ name: 'Public (FREE)', slug: 'public', plan: 'free' });
    const state = validState({
      publicTenant: { id: String(tenant._id), plan: 'free' },
      emailUser: null,
      uidUser: null,
    });
    vi.spyOn(audit, 'write').mockRejectedValueOnce(new Error('forced audit failure'));

    await expect(reconcileMongoUser(state, 'firebase-demo-uid')).rejects.toThrow('forced audit failure');
    expect(await UserModel.findOne({ email: 'requestor@dev.local' })).toBeNull();
    expect(await AuditLogModel.countDocuments()).toBe(0);
  });

  it('relinks the fixed placeholder once and leaves an already-current Mongo row unchanged [FR-01, SEC-03, FR-25, SEC-07]', async () => {
    const tenant = await TenantModel.create({ name: 'Public (FREE)', slug: 'public', plan: 'free' });
    const user = await UserModel.create({
      firebaseUid: 'dev:requestor@dev.local',
      email: 'requestor@dev.local',
      name: 'Dev Requestor',
      role: 'requestor',
      tenantId: tenant._id,
      status: 'disabled',
    });
    const before = validState({
      publicTenant: { id: String(tenant._id), plan: 'free' },
      emailUser: {
        id: String(user._id),
        email: user.email,
        tenantId: String(tenant._id),
        role: user.role,
        firebaseUid: user.firebaseUid,
        status: user.status,
      },
      uidUser: null,
    });

    expect((await reconcileMongoUser(before, 'firebase-demo-uid')).action).toBe('updated');
    const linked = (await UserModel.findById(user._id).lean())!;
    expect(linked).toMatchObject({ firebaseUid: 'firebase-demo-uid', status: 'active' });
    expect(await AuditLogModel.countDocuments({ action: 'user.updated' })).toBe(1);

    const current = validState({
      publicTenant: { id: String(tenant._id), plan: 'free' },
      emailUser: {
        id: String(linked._id),
        email: linked.email,
        tenantId: String(linked.tenantId),
        role: linked.role,
        firebaseUid: linked.firebaseUid,
        status: linked.status,
      },
      uidUser: { id: String(linked._id), email: linked.email },
    });
    expect((await reconcileMongoUser(current, 'firebase-demo-uid')).action).toBe('unchanged');
    expect(await AuditLogModel.countDocuments()).toBe(1);
  });
});
