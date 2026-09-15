import type { AuthTenant, AuthUser } from '../../middleware/auth';
import type { SessionAuthenticationMethod } from './model';

/**
 * Whether this account must prove a second factor for the application session being used now.
 * Historical `users.mfaEnrolled` is deliberately not part of this decision: it describes the
 * account, not the assurance of the current login (SEC-03).
 */
export function requiresCurrentLoginMfa(_user: AuthUser, tenant: AuthTenant): boolean {
  // FR-02/SEC-03: the commercial tier is authoritative. `authPolicy.otpRequired` remains in the
  // persisted/API shape for backwards compatibility, but it cannot add MFA to FREE requestors or
  // remove current-login MFA from PAID accounts. Invalid managed FREE identities are rejected by
  // `authenticate` before session policy is evaluated.
  return tenant.plan === 'paid';
}

/**
 * Authentication methods that can satisfy the account's current policy. The distinction matters:
 * PAID managed roles must complete the RiskSense-controlled OTP, while a PAID requestor may use
 * Firebase-verified MFA on the configured-IdP login or the OTP fallback.
 */
export function allowedSessionAuthenticationMethods(
  user: AuthUser,
  tenant: AuthTenant,
): readonly SessionAuthenticationMethod[] {
  // Managed roles are valid only on PAID and always use the RiskSense-controlled factor.
  if (tenant.plan === 'paid' && user.role !== 'requestor') return ['risk_sense_otp'];

  if (requiresCurrentLoginMfa(user, tenant)) {
    const configuredTenantIdp = tenant.features.sso && Boolean(tenant.sso.providerId);
    return configuredTenantIdp && user.role === 'requestor'
      ? ['firebase_mfa', 'risk_sense_otp']
      : ['risk_sense_otp'];
  }

  // FREE requestors are never required to complete MFA. Previously completed stronger factors
  // remain valid, so an existing stronger session is not needlessly invalidated.
  return ['single_factor', 'firebase_mfa', 'risk_sense_otp'];
}
