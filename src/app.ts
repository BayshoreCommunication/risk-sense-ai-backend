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
import { usersRouter } from './modules/users/routes';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1); // Render sits behind a proxy; needed for req.ip and rate limiting
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.locals.requestId = req.header('x-request-id') ?? randomUUID();
    res.setHeader('x-request-id', res.locals.requestId);
    next();
  });
  if (!isTest) app.use(pinoHttp({ logger, genReqId: (_req, res) => res.locals.requestId }));

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()),
      credentials: true,
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Session-Id', 'X-Request-Id', 'X-Dev-User'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 60,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: () => isTest,
      message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
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
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
