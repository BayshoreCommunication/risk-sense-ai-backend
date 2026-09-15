import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Firebase Admin is mocked: tests never talk to Google. Token "uid:<x>" → verified identity.
vi.mock('../../lib/firebase', () => ({
  verifyIdToken: async (token: string) => {
    if (!token.startsWith('uid:')) {
      const { AppError } = await import('../../lib/errors');
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired ID token');
    }
    const [, uid, email, mfa] = token.split(':');
    return { uid, email, name: 'Firebase User', mfa: mfa === 'mfa' };
  },
}));

import { app, seeded } from '../../tests/helpers';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { SessionModel } from './model';

describe('Firebase bearer login', () => {
  beforeEach(async () => {
    await seeded();
    // OTP is covered in otp.test.ts; here we test identity → user mapping only.
    await TenantModel.updateOne({ slug: 'public' }, { $set: { 'authPolicy.otpRequired': false } });
  });

  it('rejects an invalid token [FR-01]', async () => {
    const res = await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer garbage');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('self-provisions an unknown Firebase user as a FREE requestor in the public tenant [FR-01, FR-02]', async () => {
    const res = await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer uid:abc123:new.person@gmail.com');
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('requestor');
    expect(res.body.data.tenant.slug).toBe('public');
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
    const res = await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer uid:real-admin-uid:admin@dev.local:mfa');
    expect(res.status).toBe(401); // administrators always need the OTP step (SEC-03)
    expect(res.body.error.code).toBe('OTP_REQUIRED');
    let users = await UserModel.find({ email: 'admin@dev.local' });
    expect(users).toHaveLength(1);
    expect(users[0]!.firebaseUid).toBe('dev:admin@dev.local');

    const requested = await request(app).post('/api/v1/auth/otp/request').set('Authorization', 'Bearer uid:real-admin-uid:admin@dev.local:mfa');
    const login = await request(app)
      .post('/api/v1/auth/session')
      .set('Authorization', 'Bearer uid:real-admin-uid:admin@dev.local:mfa')
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
});
