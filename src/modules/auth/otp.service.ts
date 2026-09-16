import { randomInt, randomUUID } from 'node:crypto';
import { env, isProd } from '../../config/env';
import { withMongoTransaction } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { sha256 } from '../../lib/hash';
import { sendMail } from '../../lib/mailer';
import type { AuthUser } from '../../middleware/auth';
import { audit } from '../audit/service';
import { UserModel } from '../users/model';
import { OtpCodeModel, OtpIssueLockModel } from './otp.model';

const RESEND_COOLDOWN_MS = 60_000;
const MAX_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const ISSUE_LOCK_TTL_MS = 5 * 60_000;

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: number }).code === 11000;
}

async function acquireIssueLock(user: AuthUser): Promise<{ id: string; token: string }> {
  const id = `login:${user.id}`;
  const token = randomUUID();
  try {
    await OtpIssueLockModel.create({
      _id: id,
      userId: user.id,
      purpose: 'login',
      token,
      expiresAt: new Date(Date.now() + ISSUE_LOCK_TTL_MS),
    });
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new AppError('OTP_RATE_LIMITED', 'Another code request is already in progress');
    }
    throw err;
  }
  return { id, token };
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  const shown = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${shown}${'*'.repeat(Math.max(1, local.length - shown!.length))}@${domain}`;
}

export const otpService = {
  /**
   * Generates a 6-digit code, stores its hash, emails it. Cooldown 60 s, max 5/hour per user.
   * In non-production with the console mail provider the code is also returned (`devCode`) so the
   * flow can be exercised without a mailbox.
   */
  async request(user: AuthUser) {
    const issueLock = await acquireIssueLock(user);
    try {
      // The database lock serializes these checks and the successful write across API instances,
      // so concurrent callers cannot all pass the cooldown or hourly quota.
      const now = Date.now();
      const recent = await OtpCodeModel.find({ userId: user.id, createdAt: { $gte: new Date(now - 60 * 60 * 1000) } })
        .sort({ createdAt: -1 })
        .lean();
      if (recent[0] && now - new Date(recent[0].createdAt as Date).getTime() < RESEND_COOLDOWN_MS) {
        throw new AppError('OTP_RATE_LIMITED', 'Please wait a minute before requesting another code');
      }
      if (recent.length >= MAX_PER_HOUR) {
        throw new AppError('OTP_RATE_LIMITED', 'Too many codes requested; try again later');
      }

      const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

      // Send first: if the provider rejects the mail, no code/cooldown is stored, and finally
      // releases the transient issuance reservation so the caller can retry.
      const mail = await sendMail({
        to: user.email,
        subject: `${code} is your RiskSense AI sign-in code`,
        text: `Your RiskSense AI verification code is ${code}. It expires in ${env.OTP_TTL_MIN} minutes. If you did not try to sign in, ignore this email.`,
      });
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + env.OTP_TTL_MIN * 60 * 1000);

      // Readers see either the prior code or the replacement, never two usable active codes.
      await withMongoTransaction(async () => {
        await OtpCodeModel.updateMany(
          { userId: user.id, consumedAt: null, supersededAt: null },
          { $set: { supersededAt: issuedAt }, $unset: { activeSlot: 1 } },
        );
        await OtpCodeModel.create({
          userId: user.id,
          tenantId: user.tenantId,
          purpose: 'login',
          codeHash: sha256(code),
          expiresAt,
          sentTo: user.email,
          activeSlot: 0,
        });
        await audit.write({
          tenantId: user.tenantId,
          category: 'auth',
          action: 'auth.otp_sent',
          actor: user,
          entity: { type: 'user', id: user.id },
          payload: { provider: mail.provider, sentTo: maskEmail(user.email) },
        });
      });

      const isDemoUser =
        user.email.endsWith('@dev.local') ||
        user.email.endsWith('@paid.local') ||
        user.email.endsWith('@tac.local') ||
        user.email.includes('.demo@');

      return {
        sentTo: maskEmail(user.email),
        expiresAt,
        ...((mail.provider === 'console' && !isProd) || isDemoUser ? { devCode: code } : {}),
      };
    } finally {
      // Match the token as well as the deterministic id so an expired/replaced lock can never be
      // deleted by its former owner.
      await OtpIssueLockModel.deleteOne({ _id: issueLock.id, token: issueLock.token });
    }
  },

  /** Consumes the active code for the user; marks the user MFA-enrolled on success (SEC-03). */
  async verify(user: AuthUser, code: string) {
    return withMongoTransaction(async () => {
      const now = new Date();
      const active = await OtpCodeModel.findOne({ userId: user.id, consumedAt: null, supersededAt: null }).sort({ createdAt: -1 });
      if (!active) throw new AppError('OTP_INVALID', 'No active code; request a new one');
      if (active.expiresAt <= now) {
        throw new AppError('OTP_EXPIRED', 'The code has expired; request a new one');
      }
      if (active.attempts >= MAX_ATTEMPTS) {
        throw new AppError('OTP_INVALID', 'Too many incorrect attempts; request a new code');
      }
      if (active.codeHash !== sha256(code.trim())) {
        const failed = await OtpCodeModel.findOneAndUpdate(
          { _id: active._id, consumedAt: null, supersededAt: null, expiresAt: { $gt: now }, attempts: { $lt: MAX_ATTEMPTS } },
          { $inc: { attempts: 1 } },
          { new: true },
        );
        if (!failed) throw new AppError('OTP_INVALID', 'The code is no longer active');
        await audit.write({
          tenantId: user.tenantId,
          category: 'auth',
          action: 'auth.otp_failed',
          actor: user,
          entity: { type: 'user', id: user.id },
          payload: { attempts: failed.attempts },
        });
        // The route maps false to OTP_INVALID only after the transaction commits the attempt + audit.
        return false;
      }
      const consumed = await OtpCodeModel.findOneAndUpdate(
        { _id: active._id, codeHash: active.codeHash, consumedAt: null, supersededAt: null, expiresAt: { $gt: now }, attempts: { $lt: MAX_ATTEMPTS } },
        { $set: { consumedAt: now }, $unset: { activeSlot: 1 } },
        { new: true },
      );
      if (!consumed) throw new AppError('OTP_INVALID', 'The code is no longer active');
      await UserModel.updateOne({ _id: user.id }, { $set: { mfaEnrolled: true, lastMfaAt: now } });
      await audit.write({
        tenantId: user.tenantId,
        category: 'auth',
        action: 'auth.otp_verified',
        actor: user,
        entity: { type: 'user', id: user.id },
        payload: {},
      });
      return true;
    });
  },
};
