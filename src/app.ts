import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { env, isTest } from './config/env';
import { logger } from './lib/logger';
import { errorHandler, notFoundHandler } from './middleware/error';
import { auditRouter } from './modules/audit/routes';
import { authRouter } from './modules/auth/routes';
import { healthRouter } from './modules/health/routes';
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
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
