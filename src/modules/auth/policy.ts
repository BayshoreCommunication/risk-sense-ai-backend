import type { AuthTenant, AuthUser } from '../../middleware/auth';
import { PRIVILEGED_ROLES } from '../users/model';
import type { SessionAuthenticationMethod } from './model';

/**
 * Whether this account must prove a second factor for the application session being used now.
 * Historical `users.mfaEnrolled` is deliberately not part of this decision: it describes the
 * account, not the assurance of the current login (SEC-03).
 */
export function requiresCurrentLoginMfa(user: AuthUser, tenant: AuthTenant): boolean {
  return (
    PRIVILEGED_ROLES.includes(user.role) ||
    tenant.authPolicy.otpRequired ||
    (tenant.plan === 'paid' && (user.role === 'requestor' || user.role === 'audit'))
  );
}

/**
 * Authentication methods that can satisfy the account's current policy. The distinction matters:
 * administrators and managed auditors must complete the RiskSense-controlled OTP, while a
 * requestor may use Firebase-verified MFA on the configured-IdP login or the OTP fallback.
 */
export function allowedSessionAuthenticationMethods(
  user: AuthUser,
  tenant: AuthTenant,
): readonly SessionAuthenticationMethod[] {
  const riskSenseOtpOnly =
    PRIVILEGED_ROLES.includes(user.role) ||
    (user.role === 'audit' && (tenant.plan === 'paid' || tenant.authPolicy.otpRequired));
  if (riskSenseOtpOnly) return ['risk_sense_otp'];

  if (requiresCurrentLoginMfa(user, tenant)) {
    const configuredTenantIdp = tenant.features.sso && Boolean(tenant.sso.providerId);
    return configuredTenantIdp && user.role === 'requestor'
      ? ['firebase_mfa', 'risk_sense_otp']
      : ['risk_sense_otp'];
  }

  // A previously completed stronger factor remains valid when policy is relaxed.
  return ['single_factor', 'firebase_mfa', 'risk_sense_otp'];
}
