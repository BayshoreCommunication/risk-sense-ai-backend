import { randomInt } from 'node:crypto';
import { env, isProd } from '../../config/env';
import { AppError } from '../../lib/errors';
import { sha256 } from '../../lib/hash';
import { sendMail } from '../../lib/mailer';
import type { AuthUser } from '../../middleware/auth';
import { audit } from '../audit/service';
import { UserModel } from '../users/model';
import { OtpCodeModel } from './otp.model';

const RESEND_COOLDOWN_MS = 60_000;
const MAX_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;

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

    await OtpCodeModel.updateMany({ userId: user.id, consumedAt: null, supersededAt: null }, { $set: { supersededAt: new Date(now) } });

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresAt = new Date(now + env.OTP_TTL_MIN * 60 * 1000);

    // Send first: if the provider rejects the mail, nothing is stored and the cooldown does not start.
    const mail = await sendMail({
      to: user.email,
      subject: `${code} is your RiskSense AI sign-in code`,
      text: `Your RiskSense AI verification code is ${code}. It expires in ${env.OTP_TTL_MIN} minutes. If you did not try to sign in, ignore this email.`,
    });
    await OtpCodeModel.create({ userId: user.id, tenantId: user.tenantId, codeHash: sha256(code), expiresAt, sentTo: user.email });
    await audit.write({
      tenantId: user.tenantId,
      category: 'auth',
      action: 'auth.otp_sent',
      actor: user,
      entity: { type: 'user', id: user.id },
      payload: { provider: mail.provider, sentTo: maskEmail(user.email) },
    });

    return {
      sentTo: maskEmail(user.email),
      expiresAt,
      ...(mail.provider === 'console' && !isProd ? { devCode: code } : {}),
    };
  },

  /** Consumes the active code for the user; marks the user MFA-enrolled on success (SEC-03). */
  async verify(user: AuthUser, code: string) {
    const active = await OtpCodeModel.findOne({ userId: user.id, consumedAt: null, supersededAt: null }).sort({ createdAt: -1 });
    if (!active) throw new AppError('OTP_INVALID', 'No active code; request a new one');
    if (active.expiresAt.getTime() <= Date.now()) {
      throw new AppError('OTP_EXPIRED', 'The code has expired; request a new one');
    }
    if (active.attempts >= MAX_ATTEMPTS) {
      throw new AppError('OTP_INVALID', 'Too many incorrect attempts; request a new code');
    }
    if (active.codeHash !== sha256(code.trim())) {
      active.attempts += 1;
      await active.save();
      await audit.write({
        tenantId: user.tenantId,
        category: 'auth',
        action: 'auth.otp_failed',
        actor: user,
        entity: { type: 'user', id: user.id },
        payload: { attempts: active.attempts },
      });
      throw new AppError('OTP_INVALID', 'Incorrect code');
    }
    active.consumedAt = new Date();
    await active.save();
    await UserModel.updateOne({ _id: user.id }, { $set: { mfaEnrolled: true, lastMfaAt: new Date() } });
    await audit.write({
      tenantId: user.tenantId,
      category: 'auth',
      action: 'auth.otp_verified',
      actor: user,
      entity: { type: 'user', id: user.id },
      payload: {},
    });
    return true;
  },
};
