import { env, isProd } from '../config/env';
import { AppError } from './errors';
import { logger } from './logger';

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Resend's sandbox identity can deliver only to its owning account. Keep the local redirect useful
 * for non-production demos, but fail closed if production configuration ever bypasses env validation.
 */
export function resolveResendRecipient(
  recipient: string,
  sender: string,
  production = isProd,
): string {
  const isSandboxSender = /onboarding@resend\.dev\b/i.test(sender);
  if (!isSandboxSender) return recipient;
  if (production) {
    throw new AppError('MAIL_SEND_FAILED', 'Resend sandbox sender is forbidden in production');
  }
  return recipient === 'coderaise247@gmail.com' ? recipient : 'coderaise247@gmail.com';
}

/**
 * Minimal mail transport behind one function so the OTP flow (T-016) does not depend on a vendor.
 *   MAIL_PROVIDER=console → log only (development/test)
 *   MAIL_PROVIDER=resend  → Resend REST API (RESEND_API_KEY, MAIL_FROM)
 *   MAIL_PROVIDER=smtp    → nodemailer over SMTP_URL (loaded lazily)
 */
export async function sendMail(mail: Mail): Promise<{ provider: string; id?: string }> {
  switch (env.MAIL_PROVIDER) {
    case 'resend': {
      if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
      const targetRecipient = resolveResendRecipient(mail.to, env.MAIL_FROM);
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: [targetRecipient],
          subject: targetRecipient !== mail.to ? `[Demo for ${mail.to}] ${mail.subject}` : mail.subject,
          text: targetRecipient !== mail.to ? `Demo user: ${mail.to}\n\n${mail.text}` : mail.text,
          html: mail.html,
        }),
      });
      if (!res.ok) {
        let detail = await res.text();
        try {
          detail = (JSON.parse(detail) as { message?: string }).message ?? detail;
        } catch {
          /* keep raw text */
        }
        logger.error({ status: res.status, detail }, 'resend send failed');
        throw new AppError('MAIL_SEND_FAILED', `Email could not be sent: ${detail}`);
      }
      const body = (await res.json()) as { id?: string };
      return { provider: 'resend', id: body.id };
    }
    case 'smtp': {
      if (!env.SMTP_URL) throw new Error('SMTP_URL is not set');
      const nodemailer = await import('nodemailer');
      const transport = nodemailer.createTransport(env.SMTP_URL);
      try {
        const info = await transport.sendMail({ from: env.MAIL_FROM, ...mail });
        return { provider: 'smtp', id: info.messageId };
      } catch (err) {
        logger.error({ err }, 'smtp send failed');
        throw new AppError('MAIL_SEND_FAILED', `Email could not be sent: ${(err as Error).message}`);
      }
    }
    case 'console':
    default: {
      if (isProd) throw new Error('MAIL_PROVIDER=console is not allowed in production');
      logger.info({ to: mail.to, subject: mail.subject, text: mail.text }, 'mail (console provider)');
      return { provider: 'console' };
    }
  }
}
