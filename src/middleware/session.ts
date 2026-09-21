import type { RequestHandler } from 'express';
import { env, isProd } from '../config/env';
import { AppError } from '../lib/errors';
import { accessModeForAuthenticationMethod } from '../modules/auth/model';
import { sessionService } from '../modules/auth/service';

function requestsTrue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(requestsTrue);
  return typeof value === 'string' && value.toLowerCase() === 'true';
}

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
  const session = await sessionService.touch(sessionId, req.user, req.tenant, {
    allowDevelopmentBypass,
    allowPublicDemo: req.publicDemoEligible === true,
    requirePublicDemo: req.publicDemoAccount === true,
  });
  req.sessionId = sessionId;
  req.accessMode = accessModeForAuthenticationMethod(session.loginAssurance.method);
  if (req.accessMode === 'public_demo_sandbox' && requestsTrue(req.query.unmask)) {
    throw new AppError('FORBIDDEN', 'Public demo sessions cannot unmask sensitive data');
  }
  // Sandbox demo sessions intentionally enter the same route-level RBAC, feature, ownership and
  // tenant-scope checks as standard sessions. The credential path never grants a role or scope.
  next();
};
