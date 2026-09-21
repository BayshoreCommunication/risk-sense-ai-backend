import type { Request, RequestHandler } from 'express';
import { env, isProd } from '../config/env';
import { AppError } from '../lib/errors';
import { accessModeForAuthenticationMethod } from '../modules/auth/model';
import { sessionService } from '../modules/auth/service';

function requestsTrue(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(requestsTrue);
  return typeof value === 'string' && value.toLowerCase() === 'true';
}

function isSessionLogout(req: Request): boolean {
  if (req.method !== 'DELETE') return false;
  const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, '');
  return path.endsWith('/auth/session');
}

function isAllowedPublicDemoRead(req: Request): boolean {
  const path = `${req.baseUrl}${req.path}`.replace(/\/+$/, '');
  if (requestsTrue(req.query.unmask) || requestsTrue(req.query.refresh)) return false;
  return [
    /^\/api\/v1\/me$/,
    /^\/api\/v1\/assessments(?:\/[^/]+(?:\/messages|\/escalation-targets)?)?$/,
    /^\/api\/v1\/departments$/,
    /^\/api\/v1\/personas(?:\/[^/]+(?:\/history)?)?$/,
    /^\/api\/v1\/scenarios(?:\/[^/]+(?:\/history)?)?$/,
    /^\/api\/v1\/questions(?:\/[^/]+)?$/,
    /^\/api\/v1\/rules(?:\/[^/]+(?:\/history)?)?$/,
    /^\/api\/v1\/scoring-matrices(?:\/[^/]+(?:\/history)?)?$/,
    /^\/api\/v1\/datasets$/,
    /^\/api\/v1\/reports\/[^/]+$/,
    /^\/api\/v1\/analytics\/trends$/,
    /^\/api\/v1\/audit-logs(?:\/archive-manifests)?$/,
    /^\/api\/v1\/system\/(?:users|departments|personas|dr\/status|conformance\/runs|conformance\/flags|tenant|retention\/runs)$/,
  ].some((pattern) => pattern.test(path));
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

  // A public demo account is an intentionally shared viewing identity, not a production operator.
  // Enforce this after authenticating the exact session so the denial is attributable and audited.
  if (req.accessMode === 'public_demo_read_only') {
    const readMethod = req.method === 'GET' || req.method === 'HEAD';
    if ((!readMethod && !isSessionLogout(req)) || (readMethod && !isAllowedPublicDemoRead(req))) {
      throw new AppError('FORBIDDEN', 'Public demo access is read-only');
    }
  }
  next();
};
