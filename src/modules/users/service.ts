import { AppError } from '../../lib/errors';
import { audit } from '../audit/service';
import { PUBLIC_TENANT_SLUG, TenantModel } from '../tenants/model';
import { UserModel } from './model';

export const usersService = {
  /**
   * FREE self-signup (Overview.md "Product versions"): anyone who authenticates with Firebase and has
   * no `users` document becomes a `requestor` in the shared `public` tenant. Every other role is
   * provisioned by a system administrator (W10) — never created here.
   */
  async provisionSelfSignup(input: { firebaseUid: string; email: string; name?: string; mfa: boolean }) {
    // FR-03: a verified email on a PAID tenant's SSO domain is provisioned into that tenant (just-in-time),
    // otherwise into the shared FREE tenant.
    const domain = input.email.toLowerCase().split('@')[1] ?? '';
    const ssoTenant = domain ? await TenantModel.findOne({ 'features.sso': true, 'sso.domain': domain }).lean() : null;
    const tenant = ssoTenant ?? (await TenantModel.findOne({ slug: PUBLIC_TENANT_SLUG }).lean());
    if (!tenant) throw new AppError('INTERNAL', 'Public tenant is missing — run the seed');

    const existingByEmail = await UserModel.findOne({ email: input.email.toLowerCase() });
    if (existingByEmail) {
      // A pre-provisioned account (e.g. an administrator invited by email) logging in with Firebase
      // for the first time: bind the real uid to it instead of creating a duplicate.
      if (!existingByEmail.firebaseUid.startsWith('dev:')) {
        throw new AppError('CONFLICT', 'Email is already linked to a different identity');
      }
      existingByEmail.firebaseUid = input.firebaseUid;
      if (input.mfa) existingByEmail.mfaEnrolled = true;
      await existingByEmail.save();
      await audit.write({
        tenantId: String(existingByEmail.tenantId),
        category: 'auth',
        action: 'auth.identity_linked',
        actor: { id: String(existingByEmail._id), role: existingByEmail.role },
        entity: { type: 'user', id: String(existingByEmail._id) },
        payload: { email: input.email },
      });
      return existingByEmail;
    }

    const user = await UserModel.create({
      firebaseUid: input.firebaseUid,
      email: input.email.toLowerCase(),
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
  },
};
