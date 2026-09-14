import rateLimit from 'express-rate-limit';
import { env, isTest } from '../config/env';

/**
 * SEC-04 / API.md "Rate limits": per-user limits on the expensive or abusable routes, on top of the global
 * 60 req/min per IP in app.ts. Keyed by session (an authenticated caller) and falling back to IP.
 * Tests skip limits unless RATE_LIMIT_TEST=1 (limits.test.ts).
 */
const key = (req: { header(name: string): string | undefined; ip?: string }) => req.header('x-session-id') ?? req.header('x-dev-user') ?? req.ip ?? 'anonymous';
// RATE_LIMIT_DISABLED=true is for load tests behind one IP (refused in production by config/env.ts).
const skip = () => env.RATE_LIMIT_DISABLED || (isTest && process.env.RATE_LIMIT_TEST !== '1');
const message = (what: string) => ({ error: { code: 'RATE_LIMITED', message: `Too many ${what}; try again in a minute` } });
const base = { standardHeaders: 'draft-7' as const, legacyHeaders: false, skip, keyGenerator: key };

/** 20/min per user on chat turns (each free-text turn may call the model). */
export const messagesLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 20, message: message('answers') });
/** 5/min per user on dataset uploads (parsing + validation is CPU heavy). */
export const datasetsLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 5, message: message('uploads') });
/** 10/min per IP on session creation (credential stuffing / OTP guessing is also throttled by the OTP service). */
// Keyed by IP; the dev-bypass identity (never accepted in production) gets its own key so local e2e runs that sign in
// many seeded accounts from 127.0.0.1 are not throttled as one client.
export const sessionLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 10, keyGenerator: (req) => (isTest || !env.AUTH_DEV_BYPASS ? (req.ip ?? 'anonymous') : (req.header('x-dev-user') ?? req.ip ?? 'anonymous')), message: message('sign-in attempts') });
/** 10/min per user on report generation and exports (aggregations over a year of data). */
export const reportsLimiter = rateLimit({ ...base, windowMs: 60_000, limit: 10, message: message('report requests') });
