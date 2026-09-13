import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/firebase', () => ({
  verifyIdToken: async (token: string) => {
    if (!token.startsWith('uid:')) {
      const { AppError } = await import('../../lib/errors');
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired ID token');
    }
    const [, uid, email] = token.split(':');
    return { uid, email, name: 'Firebase User', mfa: false };
  },
}));

import { app, seeded } from '../../tests/helpers';
import { AuditLogModel } from '../audit/model';
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { OtpCodeModel } from './otp.model';

const bearer = (uid: string, email: string) => ({ Authorization: `Bearer uid:${uid}:${email}` });

async function requestCode(h: Record<string, string>) {
  const res = await request(app).post('/api/v1/auth/otp/request').set(h);
  expect(res.status).toBe(200);
  return res.body.data as { sentTo: string; expiresAt: string; devCode?: string };
}

describe('email OTP second factor', () => {
  beforeEach(async () => {
    await seeded();
  });

  it('Firebase login without a code is refused with OTP_REQUIRED [FR-01]', async () => {
    const res = await request(app).post('/api/v1/auth/session').set(bearer('u1', 'one@x.com'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('OTP_REQUIRED');
  });

  it('stores only a hash, masks the address, and returns devCode outside production', async () => {
    const data = await requestCode(bearer('u1', 'one@x.com'));
    expect(data.sentTo).toBe('on*@x.com');
    expect(data.devCode).toMatch(/^\d{6}$/);
    const row = await OtpCodeModel.findOne({ sentTo: 'one@x.com' }).lean();
    expect(row?.codeHash).not.toContain(data.devCode);
    expect(await AuditLogModel.countDocuments({ action: 'auth.otp_sent' })).toBe(1);
  });

  it('wrong code → OTP_INVALID and attempts increment; right code → session + mfaEnrolled [FR-01, SEC-03]', async () => {
    const h = bearer('u1', 'one@x.com');
    const { devCode } = await requestCode(h);
    const wrong = devCode === '000000' ? '111111' : '000000';
    const bad = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: wrong });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('OTP_INVALID');
    expect((await OtpCodeModel.findOne({ sentTo: 'one@x.com' }))?.attempts).toBe(1);

    const good = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    expect(good.status).toBe(201);
    expect(good.body.data.user.mfaEnrolled).toBe(true);
    expect((await UserModel.findOne({ email: 'one@x.com' }))?.mfaEnrolled).toBe(true);
    expect(await AuditLogModel.countDocuments({ action: 'auth.otp_verified' })).toBe(1);
  });

  it('a code cannot be reused', async () => {
    const h = bearer('u1', 'one@x.com');
    const { devCode } = await requestCode(h);
    await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    const again = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe('OTP_INVALID');
  });

  it('expired code → OTP_EXPIRED', async () => {
    const h = bearer('u1', 'one@x.com');
    const { devCode } = await requestCode(h);
    await OtpCodeModel.updateMany({ sentTo: 'one@x.com' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('locks after 5 wrong attempts', async () => {
    const h = bearer('u1', 'one@x.com');
    const { devCode } = await requestCode(h);
    const wrong = devCode === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: wrong });
    const res = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/Too many/);
  });

  it('second request within 60 s is rate limited and a new request supersedes the old code', async () => {
    const h = bearer('u1', 'one@x.com');
    const first = await requestCode(h);
    const limited = await request(app).post('/api/v1/auth/otp/request').set(h);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('OTP_RATE_LIMITED');
    // createdAt is immutable through Mongoose (timestamps); age the row directly in the collection.
    await mongoose.connection.db!.collection('otpCodes').updateMany({ sentTo: 'one@x.com' }, { $set: { createdAt: new Date(Date.now() - 120_000) } });
    const second = await requestCode(h);
    const res = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: first.devCode });
    expect(res.status).toBe(401); // old code superseded
    const okRes = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: second.devCode });
    expect(okRes.status).toBe(201);
  });

  it('administrator must pass OTP even when the tenant policy disables it [SEC-03]', async () => {
    await TenantModel.updateOne({ slug: 'public' }, { $set: { 'authPolicy.otpRequired': false } });
    const requestor = await request(app).post('/api/v1/auth/session').set(bearer('u9', 'nine@x.com'));
    expect(requestor.status).toBe(201); // policy off → requestor may skip
    const admin = await request(app).post('/api/v1/auth/session').set(bearer('adm', 'admin@dev.local'));
    expect(admin.status).toBe(401);
    expect(admin.body.error.code).toBe('OTP_REQUIRED');
  });

  it('dev bypass login does not need OTP', async () => {
    const res = await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'requestor@dev.local');
    expect(res.status).toBe(201);
  });
});
