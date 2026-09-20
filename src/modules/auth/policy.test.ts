import { describe, expect, it } from 'vitest';
import type { AuthTenant, AuthUser } from '../../middleware/auth';
import type { Role } from '../users/model';
import {
  allowedSessionAuthenticationMethods,
  allowsNonProductionDemoShortcut,
  mayExposeOtpDevCode,
  requiresCurrentLoginMfa,
} from './policy';

function user(role: Role): AuthUser {
  return {
    id: `user-${role}`,
    firebaseUid: `uid-${role}`,
    email: `${role}@example.test`,
    name: role,
    role,
    tenantId: 'tenant-id',
    departmentIds: [],
    crossDepartmentAccess: false,
    mfaEnrolled: false,
  };
}

function tenant(
  plan: AuthTenant['plan'],
  otpRequired: boolean,
  sso: { enabled: boolean; providerId: string | null } = { enabled: false, providerId: null },
): AuthTenant {
  return {
    id: 'tenant-id',
    slug: `${plan}-tenant`,
    plan,
    sectors: ['financial'],
    features: {
      sso: sso.enabled,
      reviewDashboard: false,
      reports: false,
      fullAudit: false,
      departmentMapping: false,
      blockConcurrentLogin: false,
    },
    sessionPolicy: { idleTimeoutMin: 15, maxConcurrentSessions: 1 },
    authPolicy: { otpRequired },
    sso: { providerId: sso.providerId, domain: sso.providerId ? 'example.test' : null },
  };
}

describe('plan-first current-login MFA policy [FR-02, SEC-03]', () => {
  it('never enables demo authentication shortcuts or plaintext OTP responses in production [FR-01, SEC-03]', () => {
    for (const email of ['admin@dev.local', 'requestor@paid.local', 'audit@tac.local', 'user.demo@example.com']) {
      expect(allowsNonProductionDemoShortcut(email, true), email).toBe(false);
      expect(mayExposeOtpDevCode('resend', email, true), email).toBe(false);
      expect(mayExposeOtpDevCode('console', email, true), email).toBe(false);
    }
  });

  it('limits demo conveniences to recognized non-production identities [FR-01, SEC-03]', () => {
    expect(allowsNonProductionDemoShortcut('admin@dev.local', false)).toBe(true);
    expect(allowsNonProductionDemoShortcut('person@example.com', false)).toBe(false);
    expect(mayExposeOtpDevCode('resend', 'admin@dev.local', false)).toBe(true);
    expect(mayExposeOtpDevCode('resend', 'person@example.com', false)).toBe(false);
    expect(mayExposeOtpDevCode('console', 'person@example.com', false)).toBe(true);
  });

  it('does not require MFA from a FREE requestor when the stored policy is true [FR-02, SEC-03]', () => {
    const requestor = user('requestor');
    const free = tenant('free', true);

    expect(requiresCurrentLoginMfa(requestor, free)).toBe(false);
    expect(allowedSessionAuthenticationMethods(requestor, free)).toEqual([
      'single_factor',
      'firebase_mfa',
      'risk_sense_otp',
    ]);
  });

  it('requires MFA from a PAID requestor when the stored policy is false [SEC-03]', () => {
    const requestor = user('requestor');

    expect(requiresCurrentLoginMfa(requestor, tenant('paid', false))).toBe(true);
    expect(allowedSessionAuthenticationMethods(requestor, tenant('paid', false))).toEqual([
      'risk_sense_otp',
    ]);
    expect(
      allowedSessionAuthenticationMethods(
        requestor,
        tenant('paid', false, { enabled: true, providerId: 'oidc.example' }),
      ),
    ).toEqual(['firebase_mfa', 'risk_sense_otp']);
  });

  it('requires RiskSense OTP from every PAID managed role when the stored policy is false [FR-02, SEC-03]', () => {
    for (const role of ['administrator', 'system_administrator', 'audit'] as const) {
      const managed = user(role);
      const paid = tenant('paid', false, { enabled: true, providerId: 'oidc.example' });
      expect(requiresCurrentLoginMfa(managed, paid), role).toBe(true);
      expect(allowedSessionAuthenticationMethods(managed, paid), role).toEqual(['risk_sense_otp']);
    }
  });
});
