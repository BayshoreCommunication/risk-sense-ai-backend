import 'dotenv/config';
import { z } from 'zod';

export type MailDeliveryStatus = 'available' | 'blocked_sandbox_sender';

/** A sandbox Resend identity is never an acceptable production OTP transport. */
export function mailDeliveryStatus(
  provider: 'console' | 'resend' | 'smtp',
  sender: string,
  production: boolean,
): MailDeliveryStatus {
  return production && provider === 'resend' && /onboarding@resend\.dev\b/i.test(sender)
    ? 'blocked_sandbox_sender'
    : 'available';
}

/**
 * Environment is validated once at boot. A missing/invalid value fails fast with a readable
 * message instead of a confusing runtime error later (see DevelopmentGuide.md).
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/risksense_dev'),

    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_SERVICE_ACCOUNT_B64: z.string().optional(),
    // Dev-only escape hatch while Firebase credentials are not yet available (DecisionLog 2026-09-13-12).
    AUTH_DEV_BYPASS: z
      .string()
      .optional()
      .transform((v) => v === 'true' || v === '1'),
    // Explicit production-safe gate for server-issued sessions for exact persisted demo identities.
    // This does not publish a Firebase credential or enable X-Dev-User/email-domain shortcuts.
    PUBLIC_DEMO_ACCESS_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === 'true' || v === '1'),
    // Exact immutable Mongo tenant target for the public demo provisioner/runtime allowlist.
    PUBLIC_DEMO_TENANT_ID: z.string().regex(/^[a-f\d]{24}$/i).optional(),

    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
    OPENAI_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
    AI_PROVIDER: z.enum(['auto', 'openai', 'mock']).default('auto'), // mock = deterministic heuristics (tests, dev without key)

    // Second factor (T-016)
    OTP_TTL_MIN: z.coerce.number().int().min(1).max(30).default(10),
    MAIL_PROVIDER: z.enum(['console', 'resend', 'smtp']).default('console'),
    MAIL_FROM: z.string().default('RiskSense AI <no-reply@risksense.local>'),
    RESEND_API_KEY: z.string().optional(),
    SMTP_URL: z.string().optional(),
    // Emergency demo-only availability switch. It never enables sandbox delivery: mailer.ts still
    // rejects every production OTP before a provider request or OTP row is created.
    ALLOW_RESEND_SANDBOX_STARTUP: z
      .string()
      .optional()
      .transform((v) => v === 'true' || v === '1'),

    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    // Optional long-lived-host scheduler. On Vercel this stays off and vercel.json calls the
    // CRON_SECRET-protected HTTP trigger instead (DecisionLog 41).
    JOBS_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === 'true' || v === '1'),
    JOBS_RETENTION_HOUR: z.coerce.number().int().min(0).max(23).default(2),
    // Shared secret for the Vercel Cron trigger of jobs/routes.ts. Required in every production
    // runtime so the maintenance route can never be deployed without its independent credential.
    CRON_SECRET: z.string().min(16).max(512).optional(),
    RATE_LIMIT_DISABLED: z
      .string()
      .optional()
      .transform((v) => v === 'true' || v === '1'), // load tests only
    LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((v, ctx) => {
    if (v.PUBLIC_DEMO_ACCESS_ENABLED && !v.PUBLIC_DEMO_TENANT_ID) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_DEMO_TENANT_ID'],
        message: 'required when PUBLIC_DEMO_ACCESS_ENABLED is true',
      });
    }
    if (v.NODE_ENV === 'production') {
      if (v.AUTH_DEV_BYPASS) {
        ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_BYPASS'], message: 'must be false in production' });
      }
      if (!v.FIREBASE_SERVICE_ACCOUNT_B64?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['FIREBASE_SERVICE_ACCOUNT_B64'], message: 'required in production' });
      }
      if (v.RATE_LIMIT_DISABLED) {
        ctx.addIssue({ code: 'custom', path: ['RATE_LIMIT_DISABLED'], message: 'must be false in production' });
      }
      if (v.MAIL_PROVIDER === 'console') {
        ctx.addIssue({ code: 'custom', path: ['MAIL_PROVIDER'], message: 'must be resend or smtp in production (OTP emails)' });
      }
      if (v.AI_PROVIDER === 'mock') {
        ctx.addIssue({ code: 'custom', path: ['AI_PROVIDER'], message: 'mock AI is forbidden in production' });
      }
      if (!v.OPENAI_API_KEY?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['OPENAI_API_KEY'], message: 'required in production' });
      }
      if (!v.CRON_SECRET?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['CRON_SECRET'], message: 'required in production for the nightly maintenance trigger' });
      } else if (v.CRON_SECRET === 'development-cron-secret-change-me') {
        ctx.addIssue({ code: 'custom', path: ['CRON_SECRET'], message: 'replace the documented development placeholder in production' });
      } else if (!/^[\x21-\x7E]+$/.test(v.CRON_SECRET)) {
        ctx.addIssue({ code: 'custom', path: ['CRON_SECRET'], message: 'must contain only visible ASCII characters valid in an Authorization header' });
      }
      if (!/^mongodb(?:\+srv)?:\/\//i.test(v.MONGODB_URI) || /^mongodb:\/\/(127\.0\.0\.1|localhost)(?::|\/)/i.test(v.MONGODB_URI)) {
        ctx.addIssue({ code: 'custom', path: ['MONGODB_URI'], message: 'a valid non-local MongoDB production URI is required' });
      }
      if (v.MAIL_PROVIDER === 'resend' && !v.RESEND_API_KEY?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'required when MAIL_PROVIDER=resend in production' });
      }
      if (
        mailDeliveryStatus(v.MAIL_PROVIDER, v.MAIL_FROM, true) === 'blocked_sandbox_sender' &&
        !v.ALLOW_RESEND_SANDBOX_STARTUP
      ) {
        ctx.addIssue({ code: 'custom', path: ['MAIL_FROM'], message: 'Resend sandbox sender is forbidden in production' });
      }
      if (v.MAIL_PROVIDER === 'smtp' && !v.SMTP_URL?.trim()) {
        ctx.addIssue({ code: 'custom', path: ['SMTP_URL'], message: 'required when MAIL_PROVIDER=smtp in production' });
      }
      const origins = v.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean);
      const hasInvalidOrigin = origins.some((origin) => {
        try {
          const url = new URL(origin);
          return url.protocol !== 'https:' || url.origin !== origin || Boolean(url.username || url.password);
        } catch {
          return true;
        }
      });
      if (origins.length === 0 || hasInvalidOrigin) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'production origins must be an explicit comma-separated HTTPS allowlist' });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
