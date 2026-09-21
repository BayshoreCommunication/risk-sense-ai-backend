import type { Role } from '../users/model';

export const PUBLIC_DEMO_TENANT_SLUG = 'tac';
export const PUBLIC_DEMO_SANDBOX_EMAIL_DOMAIN = 'demo.invalid';
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

/**
 * User records created from the shared sandbox are confined to a non-routable namespace. Keeping
 * this check exact prevents a demo visitor from reserving a real customer's global email address.
 */
export function isPublicDemoSandboxEmail(email: string): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  const at = normalizedEmail.lastIndexOf('@');
  return at > 0 && normalizedEmail.slice(at + 1) === PUBLIC_DEMO_SANDBOX_EMAIL_DOMAIN;
}

/** RFC 2606's `.invalid` TLD is safe for synthetic SSO configuration and cannot be customer-owned. */
export function isReservedInvalidDomain(domain: string): boolean {
  return domain.trim().toLowerCase().endsWith('.invalid');
}

export interface PublicDemoAccountInput {
  configuredTenantId?: string;
  user: { email: string; role: Role; publicDemo?: boolean | null };
  tenant: { id: string; slug: string; publicDemo?: boolean | null };
}

export function isPublicDemoTenant(input: {
  configuredTenantId?: string;
  tenant: { id: string; slug: string; publicDemo?: boolean | null };
}): boolean {
  return Boolean(
    input.configuredTenantId &&
    input.tenant.publicDemo &&
    input.tenant.id === input.configuredTenantId &&
    input.tenant.slug === PUBLIC_DEMO_TENANT_SLUG,
  );
}

/**
 * Persistent account classification. This intentionally ignores the runtime kill switch: disabling
 * public demo access must invalidate the special session without ever turning this identity back
 * into an ordinary Firebase/development account.
 */
export function isPublicDemoAccount(input: PublicDemoAccountInput): boolean {
  return Boolean(
    input.user.publicDemo &&
    isPublicDemoTenant(input) &&
    isExactPublicDemoIdentity(input.user.email, input.user.role),
  );
}

export function isPublicDemoEligible(input: PublicDemoAccountInput & {
  enabled: boolean;
  trustedPublicDemoFlow: boolean;
}): boolean {
  return input.enabled && input.trustedPublicDemoFlow && isPublicDemoAccount(input);
}
