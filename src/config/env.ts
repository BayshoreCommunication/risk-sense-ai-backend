import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment is validated once at boot. A missing/invalid value fails fast with a readable
 * message instead of a confusing runtime error later (see DevelopmentGuide.md).
 */
const schema = z
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

    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    // Nightly in-process jobs (retention SEC-06, audit verify SEC-07). Off by default; a Render Cron Job may call the scripts instead.
    JOBS_ENABLED: z
      .string()
      .optional()
      .transform((v) => v === 'true' || v === '1'),
    JOBS_RETENTION_HOUR: z.coerce.number().int().min(0).max(23).default(2),
    RATE_LIMIT_DISABLED: z
      .string()
      .optional()
      .transform((v) => v === 'true' || v === '1'), // load tests only
    LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  })
  .superRefine((v, ctx) => {
    if (v.NODE_ENV === 'production') {
      if (v.AUTH_DEV_BYPASS) {
        ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_BYPASS'], message: 'must be false in production' });
      }
      if (!v.FIREBASE_SERVICE_ACCOUNT_B64) {
        ctx.addIssue({ code: 'custom', path: ['FIREBASE_SERVICE_ACCOUNT_B64'], message: 'required in production' });
      }
      if (v.RATE_LIMIT_DISABLED) {
        ctx.addIssue({ code: 'custom', path: ['RATE_LIMIT_DISABLED'], message: 'must be false in production' });
      }
      if (v.MAIL_PROVIDER === 'console') {
        ctx.addIssue({ code: 'custom', path: ['MAIL_PROVIDER'], message: 'must be resend or smtp in production (OTP emails)' });
      }
    }
  });

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
