import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { withMongoTransaction } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireSession } from '../../middleware/session';
import { sessionLimiter } from '../../middleware/limits';
import { validate } from '../../middleware/validate';
import { TenantModel } from '../tenants/model';
import { UserModel, ROLES } from '../users/model';
import { audit } from '../audit/service';
import { usersService } from '../users/service';
import { otpService } from './otp.service';
import { requiresCurrentLoginMfa } from './policy';
import { ConcurrentSessionBlockedError, sessionService } from './service';
import { accessModeForAuthenticationMethod } from './model';
import { isPublicDemoEligible, publicDemoIdentityForRole, PUBLIC_DEMO_TENANT_SLUG } from './public-demo';

export const authRouter = Router();

export const CreateSessionBody = z.object({ otpCode: z.string().regex(/^\d{6}$/).optional() }).default({});
export const CreatePublicDemoSessionBody = z.object({ role: z.enum(ROLES) });
export const SsoLookupQuery = z.object({ email: z.string().email().max(254) });

function disableSessionResponseCaching(res: { setHeader(name: string, value: string): unknown }): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

/**
 * POST /auth/public-demo/session — exchange a fixed role selector for a short-lived, read-only
 * application session. No public Firebase credential exists: the server resolves the exact
 * allowlisted Mongo identity inside the operator-pinned synthetic TAC tenant.
 */
authRouter.post(
  '/public-demo/session',
  sessionLimiter,
  validate({ body: CreatePublicDemoSessionBody }),
  async (req, res) => {
    const { role } = req.body as z.infer<typeof CreatePublicDemoSessionBody>;
    const identity = publicDemoIdentityForRole(role);
    const tenantId = env.PUBLIC_DEMO_TENANT_ID;
    if (!env.PUBLIC_DEMO_ACCESS_ENABLED || !tenantId || !identity) {
      throw new AppError('FORBIDDEN', 'Public demo access is unavailable');
    }

    const tenant = await TenantModel.findOne({
      _id: tenantId,
      slug: PUBLIC_DEMO_TENANT_SLUG,
      plan: 'paid',
    }).select('+publicDemo').lean();
    const user = tenant
      ? await UserModel.findOne({
          email: identity.email,
          role: identity.role,
          tenantId: tenant._id,
          status: 'active',
        }).select('+publicDemo').lean()
      : null;
    if (
      !tenant ||
      !user ||
      !isPublicDemoEligible({
        enabled: env.PUBLIC_DEMO_ACCESS_ENABLED,
        configuredTenantId: tenantId,
        trustedPublicDemoFlow: true,
        user: { email: user.email, role: user.role, publicDemo: user.publicDemo },
        tenant: { id: String(tenant._id), slug: tenant.slug, publicDemo: tenant.publicDemo },
      })
    ) {
      throw new AppError('FORBIDDEN', 'Public demo access is unavailable');
    }

    const authUser = {
      id: String(user._id),
      firebaseUid: user.firebaseUid,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: String(user.tenantId),
      departmentIds: user.departmentIds.map(String),
      crossDepartmentAccess: user.crossDepartmentAccess,
      mfaEnrolled: user.mfaEnrolled,
    };
    const authTenant = {
      id: String(tenant._id),
      slug: tenant.slug,
      plan: tenant.plan,
      features: tenant.features,
      sectors: tenant.sectors,
      sessionPolicy: {
        idleTimeoutMin: tenant.sessionPolicy?.idleTimeoutMin ?? 15,
        maxConcurrentSessions: tenant.sessionPolicy?.maxConcurrentSessions ?? 1,
      },
      authPolicy: { otpRequired: true },
      sso: { providerId: tenant.sso?.providerId ?? null, domain: tenant.sso?.domain ?? null },
    };
    let session;
    try {
      session = await sessionService.create(authUser, authTenant, {
        authenticationMethod: 'public_demo',
        publicDemoEligible: true,
        userAgent: req.header('user-agent'),
        ip: req.ip,
        signInProvider: 'server_public_demo',
      });
    } catch (error) {
      if (!(error instanceof ConcurrentSessionBlockedError)) throw error;
      await audit.write({
        tenantId: authTenant.id,
        category: 'session',
        action: 'session.rejected_concurrent',
        actor: authUser,
        entity: { type: 'user', id: authUser.id },
        payload: { activeSessions: error.activeSessions, accessMode: 'public_demo_read_only' },
      });
      throw new AppError('CONCURRENT_LOGIN_BLOCKED', error.message);
    }
    disableSessionResponseCaching(res);
    ok(res, {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      accessMode: 'public_demo_read_only' as const,
      user: authUser,
      tenant: authTenant,
    }, 201);
  },
);

/**
 * GET /auth/sso/lookup?email= — public. Tells the login page whether the address belongs to a tenant with SSO
 * (FR-03) and which Firebase provider id to use (`microsoft.com`, `oidc.<id>`, `saml.<id>`). Never reveals
 * whether the user exists.
 */
authRouter.get('/sso/lookup', validate({ query: SsoLookupQuery }), async (req, res) => {
  const email = (req.query as unknown as z.infer<typeof SsoLookupQuery>).email.toLowerCase();
  const domain = email.split('@')[1]!;
  const tenant = await TenantModel.findOne({ 'features.sso': true, 'sso.domain': domain }).select('slug name sso').lean();
  ok(res, tenant?.sso?.providerId ? { providerId: tenant.sso.providerId, tenant: tenant.name } : { providerId: null, tenant: null });
});

/**
 * POST /auth/otp/request — second factor (FR-01, SEC-03). Requires a verified Firebase identity
 * (Bearer) but no session yet: emails a 6-digit code to the account's address.
 */
authRouter.post('/otp/request', authenticate, async (req, res) => {
  if (!req.header('authorization')) throw new AppError('UNAUTHENTICATED', 'OTP requires a bearer token');
  ok(res, await otpService.request(req.user!));
});

/**
 * POST /auth/session — exchange a verified identity (+ OTP when required) for an app session (W1).
 * FREE requestors never require MFA. Every PAID account requires current-login MFA; requestors may
 * satisfy it with a verified Firebase MFA claim from their configured IdP, while managed roles use
 * the RiskSense OTP. The non-production development bypass skips it (FR-02, SEC-03).
 */
authRouter.post('/session', sessionLimiter, authenticate, validate({ body: CreateSessionBody }), async (req, res) => {
  const viaFirebase = Boolean(req.header('authorization'));
  const viaDevelopmentBypass =
    !viaFirebase && Boolean(req.header('x-dev-user')) && env.AUTH_DEV_BYPASS;
  if (req.publicDemoAccount || req.publicDemoEligible || (!viaFirebase && !viaDevelopmentBypass)) {
    throw new AppError('FORBIDDEN', 'This identity is available only through public demo access');
  }
  // Firebase's verified second-factor claim on a configured SSO sign-in satisfies a requestor's
  // second factor. Raw upstream SAML/OIDC attributes are not trusted without a tenant-specific
  // mapping; absent this Firebase claim, PAID requestors fall back to the RiskSense email code.
  // Managed roles always complete the RiskSense-controlled factor (SEC-03, DecisionLog 15).
  const t = req.tenant!;
  const viaSso = viaFirebase && t.features.sso && Boolean(t.sso.providerId) && req.user!.signInProvider === t.sso.providerId;
  const ssoFirebaseMfaSatisfied = viaSso && req.user!.role === 'requestor' && Boolean(req.identityMfa);
  const otpRequired =
    viaFirebase &&
    requiresCurrentLoginMfa(req.user!, t) &&
    !ssoFirebaseMfaSatisfied;
  const { otpCode } = req.body as z.infer<typeof CreateSessionBody>;
  if (otpRequired) {
    if (!otpCode) throw new AppError('OTP_REQUIRED', 'A verification code is required to sign in');
  }

  let session;
  try {
    session = await withMongoTransaction(async () => {
      // A wrong code returns false so its attempts + audit can commit; every thrown later failure
      // aborts successful OTP, identity-link, session, last-login and audit writes together.
      if (otpRequired && !(await otpService.verify(req.user!, otpCode!))) return null;
      if (viaFirebase) await usersService.finalizeIdentityLink(req.user!.id, req.user!.firebaseUid, req.user!);
      return sessionService.create(req.user!, req.tenant!, {
        authenticationMethod: !viaFirebase
          ? 'development_bypass'
          : otpRequired
            ? 'risk_sense_otp'
            : ssoFirebaseMfaSatisfied
              ? 'firebase_mfa'
              : 'single_factor',
        userAgent: req.header('user-agent'),
        ip: req.ip,
        signInProvider: req.user!.signInProvider ?? (viaFirebase ? 'firebase' : 'dev'),
      });
    });
  } catch (error) {
    if (!(error instanceof ConcurrentSessionBlockedError)) throw error;
    // The rejected exchange was rolled back (including any OTP/link writes); denial evidence is
    // appended afterward because throwing from the transaction would roll the audit back as well.
    await audit.write({
      tenantId: t.id,
      category: 'session',
      action: 'session.rejected_concurrent',
      actor: req.user!,
      entity: { type: 'user', id: req.user!.id },
      payload: { activeSessions: error.activeSessions },
    });
    throw new AppError('CONCURRENT_LOGIN_BLOCKED', error.message);
  }

  if (!session) throw new AppError('OTP_INVALID', 'Incorrect code');
  if (otpRequired) req.user!.mfaEnrolled = true;
  disableSessionResponseCaching(res);
  ok(
    res,
    {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      accessMode: accessModeForAuthenticationMethod(session.loginAssurance.method),
      user: req.user,
      tenant: req.tenant,
    },
    201,
  );
});

/** DELETE /auth/session — logout. */
authRouter.delete('/session', authenticate, requireSession, async (req, res) => {
  await sessionService.terminate(req.sessionId!, 'logout', req.user);
  disableSessionResponseCaching(res);
  ok(res, { loggedOut: true });
});
