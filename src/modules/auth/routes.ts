import { Router } from 'express';
import { z } from 'zod';
import { withMongoTransaction } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireSession } from '../../middleware/session';
import { sessionLimiter } from '../../middleware/limits';
import { validate } from '../../middleware/validate';
import { TenantModel } from '../tenants/model';
import { audit } from '../audit/service';
import { usersService } from '../users/service';
import { otpService } from './otp.service';
import { requiresCurrentLoginMfa } from './policy';
import { ConcurrentSessionBlockedError, sessionService } from './service';

export const authRouter = Router();

export const CreateSessionBody = z.object({ otpCode: z.string().regex(/^\d{6}$/).optional() }).default({});
export const SsoLookupQuery = z.object({ email: z.string().email().max(254) });

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
  ok(
    res,
    {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      user: req.user,
      tenant: req.tenant,
    },
    201,
  );
});

/** DELETE /auth/session — logout. */
authRouter.delete('/session', authenticate, requireSession, async (req, res) => {
  await sessionService.terminate(req.sessionId!, 'logout', req.user);
  ok(res, { loggedOut: true });
});
