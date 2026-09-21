import type { Role } from '../users/model';

export const PUBLIC_DEMO_TENANT_SLUG = 'tac';
export const PUBLIC_DEMO_SESSION_IDLE_MINUTES = 15;
export const PUBLIC_DEMO_SESSION_ABSOLUTE_MINUTES = 60;

export const PUBLIC_DEMO_IDENTITIES = Object.freeze([
  { email: 'requestor@tac.local', name: 'TAC Demo Requestor', role: 'requestor' as const },
  { email: 'admin@dev.local', name: 'Dev Administrator (TAC)', role: 'administrator' as const },
  { email: 'sysadmin@dev.local', name: 'Dev System Administrator (Bayshore)', role: 'system_administrator' as const },
  { email: 'audit@dev.local', name: 'Dev Auditor', role: 'audit' as const },
]);

export type PublicDemoIdentity = { email: string; name: string; role: Role };

export function publicDemoIdentityForRole(role: Role): PublicDemoIdentity | undefined {
  return PUBLIC_DEMO_IDENTITIES.find((identity) => identity.role === role);
}

export function isExactPublicDemoIdentity(email: string, role: Role): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  return PUBLIC_DEMO_IDENTITIES.some(
    (identity) => identity.email === normalizedEmail && identity.role === role,
  );
}

export interface PublicDemoAccountInput {
  configuredTenantId?: string;
  user: { email: string; role: Role; publicDemo?: boolean | null };
  tenant: { id: string; slug: string; publicDemo?: boolean | null };
}

/**
 * Persistent account classification. This intentionally ignores the runtime kill switch: disabling
 * public demo access must invalidate the special session without ever turning this identity back
 * into an ordinary Firebase/development account.
 */
export function isPublicDemoAccount(input: PublicDemoAccountInput): boolean {
  return Boolean(
    input.configuredTenantId &&
    input.user.publicDemo &&
    input.tenant.publicDemo &&
    input.tenant.id === input.configuredTenantId &&
    input.tenant.slug === PUBLIC_DEMO_TENANT_SLUG &&
    isExactPublicDemoIdentity(input.user.email, input.user.role),
  );
}

export function isPublicDemoEligible(input: PublicDemoAccountInput & {
  enabled: boolean;
  trustedPublicDemoFlow: boolean;
}): boolean {
  return input.enabled && input.trustedPublicDemoFlow && isPublicDemoAccount(input);
}
