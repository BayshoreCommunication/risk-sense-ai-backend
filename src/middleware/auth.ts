import type { RequestHandler } from 'express';
import type { Types } from 'mongoose';
import { env, isProd } from '../config/env';
import { AppError } from '../lib/errors';
import { verifyIdToken } from '../lib/firebase';
import { UserModel, type Role } from '../modules/users/model';
import { assertRoleAllowedForPlan } from '../modules/users/plan-policy';
import { usersService } from '../modules/users/service';
import { TenantModel, type TenantFeatures, type TenantPlan } from '../modules/tenants/model';

export interface AuthUser {
  id: string;
  firebaseUid: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string;
  departmentIds: string[];
  crossDepartmentAccess: boolean;
  mfaEnrolled: boolean;
  /** Firebase sign-in provider of this request's token (undefined for the dev bypass). */
  signInProvider?: string;
}

export interface AuthTenant {
  id: string;
  slug: string;
  plan: TenantPlan;
  features: TenantFeatures;
  sessionPolicy: { idleTimeoutMin: number; maxConcurrentSessions: number };
  authPolicy: { otpRequired: boolean };
  sso: { providerId: string | null; domain: string | null }; // FR-03
}

/**
 * Resolves the caller from either
 *   - `Authorization: Bearer <Firebase ID token>` (normal path; unknown users self-provision as FREE requestors), or
 *   - `X-Dev-User: <email>` when AUTH_DEV_BYPASS=true and not production (Sprint 0 convenience).
 * Attaches req.user and req.tenant. Session checks live in ./session.ts.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const header = req.header('authorization');
  const devUser = req.header('x-dev-user');

  let user;
  let tokenMfa = false;
  let signInProvider: string | undefined;
  let verifiedUid: string | undefined;

  if (header?.startsWith('Bearer ')) {
    const token = await verifyIdToken(header.slice('Bearer '.length).trim());
    verifiedUid = token.uid;
    tokenMfa = token.mfa;
    signInProvider = token.signInProvider;
    user = await UserModel.findOne({ firebaseUid: token.uid }).lean();
    if (!user) {
      if (!token.email) throw new AppError('UNAUTHENTICATED', 'Identity has no email');
      const created = await usersService.provisionSelfSignup({
        firebaseUid: token.uid,
        email: token.email,
        name: token.name,
        mfa: token.mfa,
        signInProvider: token.signInProvider,
      });
      user = created.toObject();
    }
  } else if (devUser && env.AUTH_DEV_BYPASS && !isProd) {
    user = await UserModel.findOne({ email: devUser.toLowerCase() }).lean();
  } else {
    throw new AppError('UNAUTHENTICATED', 'Missing bearer token');
  }

  if (!user) throw new AppError('UNAUTHENTICATED', 'User is not provisioned');
  // A disabled identity cannot keep using (or refreshing) an application session. Treat it as an
  // invalid session so every client follows the same secure sign-out path.
  if (user.status !== 'active') throw new AppError('SESSION_INVALID', 'Account is disabled');

  const tenant = await TenantModel.findById(user.tenantId).lean();
  if (!tenant) throw new AppError('UNAUTHENTICATED', 'Tenant missing');
  // FR-02: fail closed for pre-policy/invalid data as well as new provisioning. Re-running the
  // seed moves known development operators; other legacy rows must be demoted or moved by an operator.
  assertRoleAllowedForPlan(tenant.plan, user.role);

  // FR-03: paid requestors/administrators must authenticate through the tenant's configured IdP.
  // Demo accounts on paid tenants authenticate with password and complete the RiskSense-controlled OTP factor.
  const isDemoAccount =
    user.email.endsWith('@dev.local') ||
    user.email.endsWith('@paid.local') ||
    user.email.endsWith('@tac.local') ||
    user.email.includes('.demo@');
  const paidSsoRole = user.role === 'requestor' || user.role === 'administrator';
  if (header && tenant.plan === 'paid' && paidSsoRole && !isDemoAccount) {
    const providerId = tenant.features.sso ? tenant.sso?.providerId : null;
    if (!providerId || signInProvider !== providerId) {
      throw new AppError('SSO_REQUIRED', 'Use your organization\'s configured SSO provider');
    }
  }

  req.user = {
    id: String(user._id),
    // For an invited `dev:` account this is the verified candidate uid. The database binding is
    // finalized only after POST /auth/session completes every required factor.
    firebaseUid: verifiedUid ?? user.firebaseUid,
    email: user.email,
    name: user.name,
    role: user.role,
    tenantId: String(user.tenantId),
    departmentIds: (user.departmentIds as Types.ObjectId[]).map(String),
    crossDepartmentAccess: user.crossDepartmentAccess,
    // A completed second factor on this login also counts (keeps the flag honest after enrollment).
    mfaEnrolled: user.mfaEnrolled || tokenMfa,
    signInProvider,
  };
  // Keep current-login assurance separate from the historical enrollment flag. A prior MFA
  // enrollment must not make a later single-factor PAID SSO login count as MFA.
  req.identityMfa = tokenMfa;
  req.tenant = {
    id: String(tenant._id),
    slug: tenant.slug,
    plan: tenant.plan,
    features: tenant.features,
    sessionPolicy: {
      idleTimeoutMin: tenant.sessionPolicy?.idleTimeoutMin ?? 15,
      maxConcurrentSessions: tenant.sessionPolicy?.maxConcurrentSessions ?? 1,
    },
    // Expose the effective setting, not a legacy stored value that cannot override the tier.
    authPolicy: { otpRequired: tenant.plan === 'paid' },
    sso: { providerId: tenant.sso?.providerId ?? null, domain: tenant.sso?.domain ?? null },
  };
  next();
};
