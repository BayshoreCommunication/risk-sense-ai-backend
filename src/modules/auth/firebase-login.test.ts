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
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';

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
    const signup = await AuditLogModel.findOne({ action: 'auth.self_signup' });
    expect(signup).toBeTruthy();
  });

  it('links a pre-provisioned (dev:) account to its real uid on first Firebase login instead of duplicating [FR-02]', async () => {
    const res = await request(app).post('/api/v1/auth/session').set('Authorization', 'Bearer uid:real-admin-uid:admin@dev.local:mfa');
    expect(res.status).toBe(401); // administrators always need the OTP step (SEC-03) — identity is linked regardless
    expect(res.body.error.code).toBe('OTP_REQUIRED');
    const users = await UserModel.find({ email: 'admin@dev.local' });
    expect(users).toHaveLength(1);
    expect(users[0]!.firebaseUid).toBe('real-admin-uid');
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
