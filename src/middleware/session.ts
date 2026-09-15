import type { RequestHandler } from 'express';
import { env, isProd } from '../config/env';
import { AppError } from '../lib/errors';
import { sessionService } from '../modules/auth/service';

/**
 * Application session check (SEC-02). Firebase tokens live ~1h and know nothing about idle time
 * or concurrent logins, so we keep our own session record and require `X-Session-Id` on every
 * authenticated request except session creation.
 */
export const requireSession: RequestHandler = async (req, _res, next) => {
  const sessionId = req.header('x-session-id');
  if (!sessionId) throw new AppError('SESSION_INVALID', 'Missing X-Session-Id header');
  if (!req.user || !req.tenant) throw new AppError('UNAUTHENTICATED');
  const allowDevelopmentBypass =
    !req.header('authorization') &&
    Boolean(req.header('x-dev-user')) &&
    env.AUTH_DEV_BYPASS &&
    !isProd;
  await sessionService.touch(sessionId, req.user, req.tenant, {
    allowDevelopmentBypass,
  });
  req.sessionId = sessionId;
  next();
};
