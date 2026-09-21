import rateLimit from 'express-rate-limit';
import { env, isTest } from '../config/env';
import { createMongoRateLimitStore } from '../modules/rate-limits/store';

/**
 * SEC-04 / API.md "Rate limits": per-user limits on the expensive or abusable routes, on top of the global
 * 300 req/min backstop in app.ts. Keyed by session (an authenticated caller) and falling back to IP.
 * Tests skip limits unless RATE_LIMIT_TEST=1 (limits.test.ts).
 */
const key = (req: { header(name: string): string | undefined; ip?: string }) => req.header('x-session-id') ?? req.header('x-dev-user') ?? req.ip ?? 'anonymous';
// RATE_LIMIT_DISABLED=true is for load tests behind one IP (refused in production by config/env.ts).
const skip = () => env.RATE_LIMIT_DISABLED || (isTest && process.env.RATE_LIMIT_TEST !== '1');
const message = (what: string) => ({ error: { code: 'RATE_LIMITED', message: `Too many ${what}; try again in a minute` } });
const base = (namespace: string) => ({
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  skip,
  keyGenerator: key,
  store: createMongoRateLimitStore(namespace),
});

/** 20/min per user on chat turns (each free-text turn may call the model). */
export const messagesLimiter = rateLimit({ ...base('messages'), windowMs: 60_000, limit: 20, message: message('answers') });

/**
 * One shared public-demo AI budget for the fixed requestor identity, independent of how many
 * short-lived browser sessions or client IPs are opened. A ten-minute window admits roughly ten
 * complete guided assessments while bounding model calls and near-term synthetic data growth.
 */
export const PUBLIC_DEMO_AI_WINDOW_MS = 10 * 60_000;
export const PUBLIC_DEMO_AI_LIMIT = 240;
export const publicDemoAiBudgetKey = (tenantId: string, userId: string) => `${tenantId}:${userId}`;
export const publicDemoAiLimiter = rateLimit({
  ...base('public-demo-ai'),
  windowMs: PUBLIC_DEMO_AI_WINDOW_MS,
  limit: PUBLIC_DEMO_AI_LIMIT,
  skip: (req) => skip() || req.accessMode !== 'public_demo_sandbox' || req.user?.role !== 'requestor',
  keyGenerator: (req) => publicDemoAiBudgetKey(req.tenant!.id, req.user!.id),
  message: { error: { code: 'RATE_LIMITED', message: 'Public demo activity limit reached; try again in ten minutes' } },
});
/** 5/min per user on dataset uploads (parsing + validation is CPU heavy). */
export const datasetsLimiter = rateLimit({ ...base('datasets'), windowMs: 60_000, limit: 5, message: message('uploads') });
/** 10/min per IP on session creation (credential stuffing / OTP guessing is also throttled by the OTP service). */
// Keyed by IP; the dev-bypass identity (never accepted in production) gets its own key so local e2e runs that sign in
// many seeded accounts from 127.0.0.1 are not throttled as one client.
export const sessionLimiter = rateLimit({ ...base('sessions'), windowMs: 60_000, limit: 10, keyGenerator: (req) => (isTest || !env.AUTH_DEV_BYPASS ? (req.ip ?? 'anonymous') : (req.header('x-dev-user') ?? req.ip ?? 'anonymous')), message: message('sign-in attempts') });
/**
 * Report generation and exports. One analytics page load fans out to five report calls plus trends, so a
 * 10/min budget tripped on the second visit within a minute. 60/min still bounds the expensive aggregations
 * while leaving room for normal dashboard use and a manual Refresh.
 */
export const reportsLimiter = rateLimit({ ...base('reports'), windowMs: 60_000, limit: 60, message: message('report requests') });
