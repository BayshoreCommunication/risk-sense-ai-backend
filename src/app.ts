import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { env, isTest } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error';
import { assessmentsRouter } from './modules/assessments/routes';
import { auditRouter } from './modules/audit/routes';
import { datasetsRouter } from './modules/datasets/routes';
import { authRouter } from './modules/auth/routes';
import { healthRouter } from './modules/health/routes';
import { personasRouter } from './modules/personas/routes';
import { questionsRouter } from './modules/questions/routes';
import { rulesRouter } from './modules/rules/routes';
import { matricesRouter, scoringRouter } from './modules/scoring/routes';
import { scenariosRouter } from './modules/scenarios/routes';
import { departmentsRouter } from './modules/tenants/routes';
import { analyticsRouter, reportsRouter } from './modules/reports/routes';
import { systemRouter } from './modules/system/routes';
import { retentionRouter } from './modules/retention/routes';
import { jobsRouter } from './jobs/routes';
import { usersRouter } from './modules/users/routes';
import { createMongoRateLimitStore } from './modules/rate-limits/store';

/**
 * The global limiter runs before authentication, so request headers are not trusted caller
 * identities here. Use the proxy-resolved network address and reserve verified session keys for
 * the route-specific limiters mounted after authentication.
 */
export const globalRateLimitKey = (req: { ip?: string }) => req.ip ?? 'anonymous';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // The deployment proxy forwards the client address used by rate limiting.
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.locals.requestId = req.header('x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', res.locals.requestId);
    next();
  });
  if (!isTest) app.use(pinoHttp({ logger, genReqId: (_req, res) => res.locals.requestId }));

  app.use(
    helmet({
      // API only: no HTML is served, so a strict CSP is fine; HSTS applies once the deployment edge terminates TLS (SEC-04).
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(
    cors({
      // Allowlist only (no wildcard); non-browser callers without Origin are allowed (health checks, scripts).
      origin: (origin, cb) => cb(null, !origin || origins.includes(origin) ? origin ?? true : false),
      credentials: true,
      maxAge: 600,
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Session-Id', 'X-Request-Id', 'X-Dev-User'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(
    rateLimit({
      // API.md "Rate limits": a coarse pre-authentication IP backstop. Unverified X-Session-Id and
      // X-Dev-User headers must not create attacker-controlled buckets. The real protection is the
      // post-authentication per-route limits in middleware/limits.ts.
      //
      // 60/min was below normal single-user traffic and throttled the product against itself: one /admin/reports
      // view costs eight reads (shell /me, departments, personas, four reports, trends), so a few screens in a
      // minute exhausted the budget and the page reported "Too many requests" (DecisionLog 44). 300/min still
      // bounds a runaway client at five requests per second without capping ordinary dashboard browsing.
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: globalRateLimitKey,
      // Liveness/readiness must still describe process/database state when the shared limiter store is
      // unavailable. All application traffic fails closed on a store error.
      skip: (req) => req.path === '/api/v1/health' || req.path.startsWith('/api/v1/health/') || isTest || env.RATE_LIMIT_DISABLED,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
      store: createMongoRateLimitStore('global'),
    }),
  );

  const api = express.Router();
  api.use('/health', healthRouter);
  api.use('/auth', authRouter);
  api.use('/', usersRouter); // GET /me
  api.use('/audit-logs', auditRouter);
  api.use('/personas', personasRouter);
  api.use('/scenarios', scenariosRouter);
  api.use('/questions', questionsRouter);
  api.use('/datasets', datasetsRouter);
  api.use('/rules', rulesRouter);
  api.use('/scoring-matrices', matricesRouter);
  api.use('/scoring', scoringRouter);
  api.use('/assessments', assessmentsRouter);
  api.use('/departments', departmentsRouter);
  api.use('/reports', reportsRouter);
  api.use('/analytics', analyticsRouter);
  api.use('/system', systemRouter);
  api.use('/system/retention', retentionRouter);
  // Not under /system: that prefix is a system_administrator RBAC router, and the scheduler has no user
  // session. jobsRouter carries its own shared-secret gate (DecisionLog 41).
  api.use('/jobs', jobsRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
