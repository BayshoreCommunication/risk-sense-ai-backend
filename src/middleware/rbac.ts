import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors';
import { PRIVILEGED_ROLES, type Role } from '../modules/users/model';
import type { TenantFeatures } from '../modules/tenants/model';
import { audit } from '../modules/audit/service';

/**
 * Least-privilege role gate (SEC-01). Denied attempts are audited as `access.denied`.
 * Admin roles must have MFA enrolled to reach anything privileged (SEC-03).
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return async (req, _res, next) => {
    const user = req.user;
    if (!user) throw new AppError('UNAUTHENTICATED');
    if (!roles.includes(user.role)) {
      await audit.write({
        tenantId: user.tenantId,
        category: 'access',
        action: 'access.denied',
        actor: user,
        entity: { type: 'route', id: `${req.method} ${req.baseUrl}${req.path}` },
        payload: { requiredRoles: roles },
      });
      throw new AppError('FORBIDDEN', 'Role not permitted');
    }
    if (PRIVILEGED_ROLES.includes(user.role) && !user.mfaEnrolled) {
      throw new AppError('MFA_REQUIRED', 'Multi-factor authentication must be enrolled for this role');
    }
    next();
  };
}

/** PAID feature gate (Overview.md "Product versions"). */
export function requireFeature(feature: keyof TenantFeatures): RequestHandler {
  return (req, _res, next) => {
    if (!req.tenant?.features[feature]) {
      throw new AppError('FEATURE_DISABLED', `Feature "${feature}" is not enabled for this tenant`);
    }
    next();
  };
}
