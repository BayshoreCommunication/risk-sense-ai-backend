import { env } from '../../config/env';
import { withMongoTransaction } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { audit } from '../audit/service';
import { isPublicDemoSandboxEmail } from '../auth/public-demo';
import { PUBLIC_TENANT_SLUG, TenantModel } from '../tenants/model';
import { UserModel } from './model';

export const usersService = {
  /**
   * FREE self-signup (Overview.md "Product versions"): anyone who authenticates with Firebase and has
   * no `users` document becomes a `requestor` in the shared `public` tenant. Every other role is
   * provisioned by a system administrator (W10) — never created here.
   */
  async provisionSelfSignup(input: { firebaseUid: string; email: string; name?: string; mfa: boolean; signInProvider?: string }) {
    const email = input.email.toLowerCase();
    if (isPublicDemoSandboxEmail(email)) {
      throw new AppError('FORBIDDEN', 'The demo.invalid namespace is reserved for sandbox-only identities');
    }
    // FR-03: a verified email on a PAID tenant's SSO domain is provisioned into that tenant (just-in-time),
    // otherwise into the shared FREE tenant.
    const domain = email.split('@')[1] ?? '';
    const ssoTenant = domain
      ? await TenantModel.findOne({
          'features.sso': true,
          'sso.domain': domain,
          publicDemo: { $ne: true },
          ...(env.PUBLIC_DEMO_TENANT_ID ? { _id: { $ne: env.PUBLIC_DEMO_TENANT_ID } } : {}),
        }).select('+publicDemo').lean()
      : null;
    if (ssoTenant?.sso?.providerId && input.signInProvider !== ssoTenant.sso.providerId) {
      throw new AppError('SSO_REQUIRED', 'Use your organization\'s configured SSO provider');
    }
    const tenant = ssoTenant ?? (await TenantModel.findOne({ slug: PUBLIC_TENANT_SLUG }).select('+publicDemo').lean());
    if (!tenant) throw new AppError('INTERNAL', 'Public tenant is missing — run the seed');

    const existingByEmail = await UserModel.findOne({ email }).select('+publicDemo +publicDemoSandboxOnly');
    if (existingByEmail) {
      if (existingByEmail.publicDemoSandboxOnly) {
        throw new AppError('FORBIDDEN', 'This identity is confined to the public demo sandbox');
      }
      // A pre-provisioned account is resolved by verified email, but the real uid is not linked yet.
      // Linking happens only after the required OTP/SSO checks succeed in POST /auth/session.
      if (!existingByEmail.firebaseUid.startsWith('dev:')) {
        throw new AppError('CONFLICT', 'Email is already linked to a different identity');
      }
      return existingByEmail;
    }

    return withMongoTransaction(async () => {
      const user = await UserModel.create({
        firebaseUid: input.firebaseUid,
        email,
        name: input.name?.trim() || input.email.split('@')[0],
        role: 'requestor',
        tenantId: tenant._id,
        mfaEnrolled: input.mfa,
      });
      await audit.write({
        tenantId: String(tenant._id),
        category: 'auth',
        action: 'auth.self_signup',
        actor: { id: String(user._id), role: user.role },
        entity: { type: 'user', id: String(user._id) },
        payload: { email: user.email, tenant: tenant.slug, viaSso: Boolean(ssoTenant) },
      });
      return user;
    });
  },

  /** Bind a pre-provisioned placeholder only after every login factor has passed. */
  async finalizeIdentityLink(userId: string, firebaseUid: string, actor: { id: string; role: string }) {
    return withMongoTransaction(async () => {
      const user = await UserModel.findById(userId).select('+publicDemoSandboxOnly');
      if (!user) throw new AppError('UNAUTHENTICATED', 'User is not provisioned');
      if (user.publicDemoSandboxOnly || isPublicDemoSandboxEmail(user.email)) {
        throw new AppError('FORBIDDEN', 'Sandbox-only identities cannot be linked to Firebase');
      }
      if (user.firebaseUid === firebaseUid) return user;
      if (!user.firebaseUid.startsWith('dev:')) throw new AppError('CONFLICT', 'Email is already linked to a different identity');
      user.firebaseUid = firebaseUid;
      try {
        await user.save();
      } catch (error) {
        if ((error as { code?: number }).code === 11000) throw new AppError('CONFLICT', 'Identity is already linked to another account');
        throw error;
      }
      await audit.write({
        tenantId: String(user.tenantId),
        category: 'auth',
        action: 'auth.identity_linked',
        actor,
        entity: { type: 'user', id: String(user._id) },
        payload: { email: user.email },
      });
      return user;
    });
  },
};
