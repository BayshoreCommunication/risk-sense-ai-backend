import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { TenantModel } from '../tenants/model';
import { PRIVILEGED_ROLES } from '../users/model';
import { otpService } from './otp.service';
import { sessionService } from './service';

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
 * OTP is required for every Firebase login when the tenant policy says so (default true, FR-01) and
 * always for administrator / system_administrator (SEC-03). The dev bypass skips it.
 */
authRouter.post('/session', authenticate, validate({ body: CreateSessionBody }), async (req, res) => {
  const viaFirebase = Boolean(req.header('authorization'));
  // FR-03: a login through the tenant's configured SSO provider brings the IdP's own MFA, so the email OTP is
  // skipped — except for privileged roles, which always complete our second factor (SEC-03, DecisionLog 15).
  const t = req.tenant!;
  const viaSso = viaFirebase && t.features.sso && Boolean(t.sso.providerId) && req.user!.signInProvider === t.sso.providerId;
  const privileged = PRIVILEGED_ROLES.includes(req.user!.role);
  const otpRequired = viaFirebase && (privileged || (t.authPolicy.otpRequired && !viaSso));
  if (otpRequired) {
    const { otpCode } = req.body as z.infer<typeof CreateSessionBody>;
    if (!otpCode) throw new AppError('OTP_REQUIRED', 'A verification code is required to sign in');
    await otpService.verify(req.user!, otpCode);
    req.user!.mfaEnrolled = true;
  }

  const session = await sessionService.create(req.user!, req.tenant!, {
    userAgent: req.header('user-agent'),
    ip: req.ip,
    signInProvider: req.user!.signInProvider ?? (viaFirebase ? 'firebase' : 'dev'),
  });
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
