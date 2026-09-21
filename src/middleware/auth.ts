import type { RequestHandler } from 'express';
import type { Types } from 'mongoose';
import { env, isProd } from '../config/env';
import { AppError } from '../lib/errors';
import { verifyIdToken } from '../lib/firebase';
import { UserModel, type Role } from '../modules/users/model';
import { assertRoleAllowedForPlan } from '../modules/users/plan-policy';
import { usersService } from '../modules/users/service';
import { allowsNonProductionDemoShortcut } from '../modules/auth/policy';
import { SessionModel } from '../modules/auth/model';
import { isPublicDemoAccount, isPublicDemoEligible, isPublicDemoSandboxEmail } from '../modules/auth/public-demo';
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
  sectors: string[];
  sessionPolicy: { idleTimeoutMin: number; maxConcurrentSessions: number };
  authPolicy: { otpRequired: boolean };
  sso: { providerId: string | null; domain: string | null }; // FR-03
}

/**
 * Resolves the caller from one of three explicit credential paths:
 *   - `Authorization: Bearer <Firebase ID token>` (normal path; unknown users self-provision as FREE requestors), or
 *   - `X-Session-Id` for a server-issued public_demo session (never a Firebase password), or
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
  let trustedPublicDemoFlow = false;

  if (header?.startsWith('Bearer ')) {
    const token = await verifyIdToken(header.slice('Bearer '.length).trim());
    verifiedUid = token.uid;
    tokenMfa = token.mfa;
    signInProvider = token.signInProvider;
    user = await UserModel.findOne({ firebaseUid: token.uid }).select('+publicDemo +publicDemoSandboxOnly').lean();
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
    user = await UserModel.findOne({ email: devUser.toLowerCase() }).select('+publicDemo +publicDemoSandboxOnly').lean();
  } else {
    const sessionId = req.header('x-session-id');
    const publicDemoSession = sessionId
      ? await SessionModel.findOne({
          sessionId,
          terminatedAt: null,
          'loginAssurance.method': 'public_demo',
        }).select('userId').lean()
      : null;
    if (!publicDemoSession) throw new AppError('UNAUTHENTICATED', 'Missing bearer token');
    user = await UserModel.findById(publicDemoSession.userId).select('+publicDemo +publicDemoSandboxOnly').lean();
    trustedPublicDemoFlow = true;
  }

  if (!user) throw new AppError('UNAUTHENTICATED', 'User is not provisioned');
  if (!trustedPublicDemoFlow && (user.publicDemoSandboxOnly || isPublicDemoSandboxEmail(user.email))) {
    throw new AppError('FORBIDDEN', 'This identity is confined to the public demo sandbox');
  }
  // A disabled identity cannot keep using (or refreshing) an application session. Treat it as an
  // invalid session so every client follows the same secure sign-out path.
  if (user.status !== 'active') throw new AppError('SESSION_INVALID', 'Account is disabled');

  const tenant = await TenantModel.findById(user.tenantId).select('+publicDemo').lean();
  if (!tenant) throw new AppError('UNAUTHENTICATED', 'Tenant missing');
  // FR-02: fail closed for pre-policy/invalid data as well as new provisioning. Re-running the
  // seed moves known development operators; other legacy rows must be demoted or moved by an operator.
  assertRoleAllowedForPlan(tenant.plan, user.role);

  // FR-03: paid requestors/administrators must authenticate through the tenant's configured IdP.
  // Seeded demo accounts may use password only outside production. An email naming convention is
  // never a production SSO exemption (FR-01, SEC-03).
  const isDemoAccount = allowsNonProductionDemoShortcut(user.email);
  const publicDemoAccountInput = {
    configuredTenantId: env.PUBLIC_DEMO_TENANT_ID,
    user: { email: user.email, role: user.role, publicDemo: user.publicDemo },
    tenant: { id: String(tenant._id), slug: tenant.slug, publicDemo: tenant.publicDemo },
  };
  const publicDemoAccount = isPublicDemoAccount(publicDemoAccountInput);
  const publicDemoEligible = isPublicDemoEligible({
    ...publicDemoAccountInput,
    enabled: env.PUBLIC_DEMO_ACCESS_ENABLED,
    trustedPublicDemoFlow,
  });
  const paidSsoRole = user.role === 'requestor' || user.role === 'administrator';
  if (header && tenant.plan === 'paid' && paidSsoRole && !isDemoAccount) {
    const sessionId = req.header('x-session-id');
    const revalidatingPromotedDemoSession = publicDemoAccount && sessionId
      ? Boolean(await SessionModel.exists({
          sessionId,
          userId: user._id,
          tenantId: tenant._id,
          terminatedAt: null,
        }))
      : false;
    const providerId = tenant.features.sso ? tenant.sso?.providerId : null;
    if (!revalidatingPromotedDemoSession && (!providerId || signInProvider !== providerId)) {
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
  req.publicDemoAccount = publicDemoAccount;
  req.publicDemoEligible = publicDemoEligible;
  req.tenant = {
    id: String(tenant._id),
    slug: tenant.slug,
    plan: tenant.plan,
    features: tenant.features,
    sectors: tenant.sectors,
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
