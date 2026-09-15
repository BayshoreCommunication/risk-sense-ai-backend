import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendMailMock = vi.hoisted(() => vi.fn());

vi.mock('../../lib/mailer', () => ({ sendMail: sendMailMock }));

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
import { AppError } from '../../lib/errors';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { SessionModel } from './model';
import { OtpCodeModel, OtpIssueLockModel } from './otp.model';

const bearer = (uid: string, email: string) => ({ Authorization: `Bearer uid:${uid}:${email}` });
const duplicateKey = (keyPattern: Record<string, number>) => Object.assign(new Error('forced duplicate key'), { code: 11000, keyPattern });

async function requestCode(h: Record<string, string>) {
  const res = await request(app).post('/api/v1/auth/otp/request').set(h);
  expect(res.status).toBe(200);
  return res.body.data as { sentTo: string; expiresAt: string; devCode?: string };
}

describe('email OTP second factor', () => {
  beforeEach(async () => {
    sendMailMock.mockReset();
    sendMailMock.mockResolvedValue({ provider: 'console' });
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
    expect((await SessionModel.findOne({ sessionId: good.body.data.sessionId }).lean())?.loginAssurance).toMatchObject({
      method: 'risk_sense_otp',
      mfaVerifiedAt: expect.any(Date),
    });
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

  it('atomically consumes a code so concurrent verification creates only one session [FR-01, SEC-02]', async () => {
    const h = bearer('u1', 'one@x.com');
    const { devCode } = await requestCode(h);
    const [a, b] = await Promise.all([
      request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode }),
      request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 401]);
    expect(await AuditLogModel.countDocuments({ action: 'auth.otp_verified' })).toBe(1);
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

  it('serializes concurrent issuance at the hourly boundary and leaves one usable code [FR-01, SEC-03]', async () => {
    const h = bearer('u1', 'one@x.com');
    const provisioned = await request(app).post('/api/v1/auth/session').set(h);
    expect(provisioned.body.error.code).toBe('OTP_REQUIRED');
    const user = await UserModel.findOne({ email: 'one@x.com' }).lean();
    const old = new Date(Date.now() - 2 * 60_000);
    await mongoose.connection.db!.collection('otpCodes').insertMany(
      Array.from({ length: 4 }, (_, i) => ({
        userId: user!._id,
        tenantId: user!.tenantId,
        purpose: 'login',
        codeHash: `prior-${i}`,
        expiresAt: new Date(Date.now() + 60_000),
        attempts: 0,
        consumedAt: old,
        sentTo: 'one@x.com',
        createdAt: new Date(old.getTime() - i),
        updatedAt: old,
      })),
    );

    let releaseMail: (() => void) | undefined;
    sendMailMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseMail = () => resolve({ provider: 'console' });
        }),
    );

    const firstPromise = request(app).post('/api/v1/auth/otp/request').set(h).then((res) => res);
    await vi.waitFor(() => expect(releaseMail).toBeTypeOf('function'));
    const concurrent = await request(app).post('/api/v1/auth/otp/request').set(h);
    expect(concurrent.status).toBe(429);
    expect(concurrent.body.error.code).toBe('OTP_RATE_LIMITED');

    releaseMail!();
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(await OtpCodeModel.countDocuments({ userId: user!._id })).toBe(5);
    expect(await OtpCodeModel.countDocuments({ userId: user!._id, consumedAt: null, supersededAt: null })).toBe(1);
    expect(await OtpIssueLockModel.countDocuments()).toBe(0);

    const afterQuota = await request(app).post('/api/v1/auth/otp/request').set(h);
    expect(afterQuota.status).toBe(429);
    expect(afterQuota.body.error.code).toBe('OTP_RATE_LIMITED');
  });

  it('stores no code or cooldown when email delivery rejects, then permits a retry [FR-01]', async () => {
    const h = bearer('u1', 'one@x.com');
    sendMailMock.mockRejectedValueOnce(new AppError('MAIL_SEND_FAILED', 'Email could not be sent'));

    const failed = await request(app).post('/api/v1/auth/otp/request').set(h);
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('MAIL_SEND_FAILED');
    expect(await OtpCodeModel.countDocuments({ sentTo: 'one@x.com' })).toBe(0);
    expect(await OtpIssueLockModel.countDocuments()).toBe(0);

    const retry = await requestCode(h);
    expect(retry.devCode).toMatch(/^\d{6}$/);
    expect(await OtpCodeModel.countDocuments({ sentTo: 'one@x.com' })).toBe(1);
  });

  it('rolls back OTP replacement when otp_sent audit fails, then retries cleanly [FR-01, SEC-03, SEC-07]', async () => {
    const h = bearer('u1', 'one@x.com');
    await requestCode(h);
    const original = (await OtpCodeModel.findOne({ sentTo: 'one@x.com' }).lean())!;
    await mongoose.connection.db!.collection('otpCodes').updateOne({ _id: original._id }, { $set: { createdAt: new Date(Date.now() - 120_000) } });

    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'auth.otp_sent') throw new Error('forced otp_sent audit failure');
      return writeAudit(entry);
    });
    const failed = await request(app).post('/api/v1/auth/otp/request').set(h);
    writeSpy.mockRestore();

    expect(failed.status).toBe(500);
    const preserved = await OtpCodeModel.findById(original._id).lean();
    expect(preserved?.codeHash).toBe(original.codeHash);
    expect(preserved?.supersededAt).toBeUndefined();
    expect(preserved?.activeSlot).toBe(0);
    expect(await OtpCodeModel.countDocuments({ sentTo: 'one@x.com' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'auth.otp_sent' })).toBe(1);
    expect(await OtpIssueLockModel.countDocuments()).toBe(0);

    await requestCode(h);
    expect(await OtpCodeModel.countDocuments({ sentTo: 'one@x.com' })).toBe(2);
    expect(await OtpCodeModel.countDocuments({ sentTo: 'one@x.com', consumedAt: null, supersededAt: null })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'auth.otp_sent' })).toBe(2);
  });

  it('rolls back a failed-attempt increment when otp_failed audit fails, then records both on retry [FR-01, SEC-03, SEC-07]', async () => {
    const h = bearer('u1', 'one@x.com');
    const { devCode } = await requestCode(h);
    const wrong = devCode === '000000' ? '111111' : '000000';
    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'auth.otp_failed') throw new Error('forced otp_failed audit failure');
      return writeAudit(entry);
    });
    const failed = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: wrong });
    writeSpy.mockRestore();

    expect(failed.status).toBe(500);
    expect((await OtpCodeModel.findOne({ sentTo: 'one@x.com' }))?.attempts).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'auth.otp_failed' })).toBe(0);

    const retry = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: wrong });
    expect(retry.status).toBe(401);
    expect(retry.body.error.code).toBe('OTP_INVALID');
    expect((await OtpCodeModel.findOne({ sentTo: 'one@x.com' }))?.attempts).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'auth.otp_failed' })).toBe(1);
  });

  it('rolls back successful OTP consumption and MFA when otp_verified audit fails, then reuses the code [FR-01, SEC-03, SEC-07]', async () => {
    const h = bearer('u1', 'one@x.com');
    const { devCode } = await requestCode(h);
    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'auth.otp_verified') throw new Error('forced otp_verified audit failure');
      return writeAudit(entry);
    });
    const failed = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    writeSpy.mockRestore();

    expect(failed.status).toBe(500);
    const code = await OtpCodeModel.findOne({ sentTo: 'one@x.com' }).lean();
    const user = await UserModel.findOne({ email: 'one@x.com' }).lean();
    expect(code?.consumedAt).toBeUndefined();
    expect(code?.activeSlot).toBe(0);
    expect(user?.mfaEnrolled).toBe(false);
    expect(user?.lastMfaAt).toBeUndefined();
    expect(await SessionModel.countDocuments({ userId: user?._id })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'auth.otp_verified' })).toBe(0);

    const retry = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    expect(retry.status).toBe(201);
    expect((await OtpCodeModel.findOne({ sentTo: 'one@x.com' }))?.consumedAt).toBeTruthy();
    expect((await UserModel.findOne({ email: 'one@x.com' }))?.mfaEnrolled).toBe(true);
  });

  it('rolls back OTP, identity and session writes when session audit fails, then retries the full exchange [FR-01, FR-02, SEC-02, SEC-03, SEC-07]', async () => {
    const h = bearer('real-admin-uid', 'admin@dev.local');
    await UserModel.updateOne(
      { email: 'admin@dev.local' },
      { $set: { mfaEnrolled: false }, $unset: { lastMfaAt: 1, lastLoginAt: 1 } },
    );
    const { devCode } = await requestCode(h);
    const before = (await UserModel.findOne({ email: 'admin@dev.local' }).lean())!;
    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'session.created') throw new Error('forced session audit failure');
      return writeAudit(entry);
    });
    const failed = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    writeSpy.mockRestore();

    expect(failed.status).toBe(500);
    const code = await OtpCodeModel.findOne({ sentTo: 'admin@dev.local' }).lean();
    const rolledBack = await UserModel.findById(before._id).lean();
    expect(code?.consumedAt).toBeUndefined();
    expect(code?.activeSlot).toBe(0);
    expect(rolledBack).toMatchObject({ firebaseUid: 'dev:admin@dev.local', mfaEnrolled: false });
    expect(rolledBack?.lastMfaAt).toBeUndefined();
    expect(rolledBack?.lastLoginAt).toBeUndefined();
    expect(await SessionModel.countDocuments({ userId: before._id })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: { $in: ['auth.otp_verified', 'auth.identity_linked', 'session.created'] } })).toBe(0);

    const retry = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    expect(retry.status).toBe(201);
    const completed = await UserModel.findById(before._id).lean();
    expect(completed).toMatchObject({ firebaseUid: 'real-admin-uid', mfaEnrolled: true });
    expect(completed?.lastMfaAt).toBeTruthy();
    expect(completed?.lastLoginAt).toBeTruthy();
    expect(await SessionModel.countDocuments({ userId: before._id, terminatedAt: null })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: { $in: ['auth.otp_verified', 'auth.identity_linked', 'session.created'] } })).toBe(3);
  });

  it('restarts the full OTP/link/session transaction after its first session audit-sequence collision [FR-01, FR-02, SEC-02, SEC-03, SEC-07]', async () => {
    const h = bearer('collision-admin-uid', 'admin@dev.local');
    await UserModel.updateOne(
      { email: 'admin@dev.local' },
      { $set: { mfaEnrolled: false }, $unset: { lastMfaAt: 1, lastLoginAt: 1 } },
    );
    const { devCode } = await requestCode(h);
    const user = (await UserModel.findOne({ email: 'admin@dev.local' }).lean())!;
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
    const res = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    insertSpy.mockRestore();

    expect(res.status).toBe(201);
    expect(attemptedSessionIds).toHaveLength(2);
    expect(attemptedSessionIds[0]).not.toBe(attemptedSessionIds[1]);
    expect(await SessionModel.findOne({ sessionId: attemptedSessionIds[0] })).toBeNull();
    expect(await SessionModel.countDocuments({ userId: user._id, terminatedAt: null })).toBe(1);
    expect((await OtpCodeModel.findOne({ sentTo: 'admin@dev.local' }).lean())?.consumedAt).toBeTruthy();
    expect(await UserModel.findById(user._id).lean()).toMatchObject({ firebaseUid: 'collision-admin-uid', mfaEnrolled: true });
    expect(await AuditLogModel.countDocuments({ action: 'auth.otp_verified', 'entity.id': String(user._id) })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'auth.identity_linked', 'entity.id': String(user._id) })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'session.created' })).toBe(1);
  });

  it('rolls OTP and identity back when concurrent-session policy rejects the exchange [FR-01, FR-04, SEC-02, SEC-03, SEC-07]', async () => {
    await TenantModel.updateOne({ slug: 'public' }, { $set: { 'features.blockConcurrentLogin': true } });
    const active = await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'admin@dev.local');
    expect(active.status).toBe(201);
    await UserModel.updateOne(
      { email: 'admin@dev.local' },
      { $set: { mfaEnrolled: false }, $unset: { lastMfaAt: 1 } },
    );
    const h = bearer('blocked-admin-uid', 'admin@dev.local');
    const { devCode } = await requestCode(h);

    const blocked = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('CONCURRENT_LOGIN_BLOCKED');
    const code = await OtpCodeModel.findOne({ sentTo: 'admin@dev.local' }).lean();
    const user = await UserModel.findOne({ email: 'admin@dev.local' }).lean();
    expect(code?.consumedAt).toBeUndefined();
    expect(code?.activeSlot).toBe(0);
    expect(user).toMatchObject({ firebaseUid: 'dev:admin@dev.local', mfaEnrolled: false });
    expect(user?.lastMfaAt).toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'auth.otp_verified' })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'auth.identity_linked' })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'session.rejected_concurrent' })).toBe(1);

    const loggedOut = await request(app)
      .delete('/api/v1/auth/session')
      .set('X-Dev-User', 'admin@dev.local')
      .set('X-Session-Id', active.body.data.sessionId);
    expect(loggedOut.status).toBe(200);
    const retry = await request(app).post('/api/v1/auth/session').set(h).send({ otpCode: devCode });
    expect(retry.status).toBe(201);
    expect((await UserModel.findOne({ email: 'admin@dev.local' }).lean())?.firebaseUid).toBe('blocked-admin-uid');
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
