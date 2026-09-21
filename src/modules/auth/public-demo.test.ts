import { describe, expect, it } from 'vitest';
import { isPublicDemoAccount, isPublicDemoEligible, PUBLIC_DEMO_IDENTITIES } from './public-demo';

const account = {
  configuredTenantId: '000000000000000000000001',
  user: { email: 'admin@dev.local', role: 'administrator' as const, publicDemo: true },
  tenant: { id: '000000000000000000000001', slug: 'tac', publicDemo: true },
};

describe('public demo allowlist policy [FR-01, FR-02, SEC-03]', () => {
  it('contains exactly one immutable email-role pair for every supported role', () => {
    expect(PUBLIC_DEMO_IDENTITIES.map(({ email, role }) => ({ email, role }))).toEqual([
      { email: 'requestor@tac.local', role: 'requestor' },
      { email: 'admin@dev.local', role: 'administrator' },
      { email: 'sysadmin@dev.local', role: 'system_administrator' },
      { email: 'audit@dev.local', role: 'audit' },
    ]);
  });

  it('classifies a flagged account independently of the kill switch and requires the exact persisted tuple', () => {
    expect(isPublicDemoAccount(account)).toBe(true);
    expect(isPublicDemoAccount({ ...account, configuredTenantId: '000000000000000000000002' })).toBe(false);
    expect(isPublicDemoAccount({ ...account, tenant: { ...account.tenant, slug: 'lookalike' } })).toBe(false);
    expect(isPublicDemoAccount({ ...account, tenant: { ...account.tenant, publicDemo: false } })).toBe(false);
    expect(isPublicDemoAccount({ ...account, user: { ...account.user, publicDemo: false } })).toBe(false);
    expect(isPublicDemoAccount({ ...account, user: { ...account.user, email: 'admin-lookalike@dev.local' } })).toBe(false);
    expect(isPublicDemoAccount({ ...account, user: { ...account.user, role: 'audit' } })).toBe(false);
  });

  it('requires both the kill switch and trusted server-issued session path for runtime eligibility', () => {
    expect(isPublicDemoEligible({ ...account, enabled: true, trustedPublicDemoFlow: true })).toBe(true);
    expect(isPublicDemoEligible({ ...account, enabled: false, trustedPublicDemoFlow: true })).toBe(false);
    expect(isPublicDemoEligible({ ...account, enabled: true, trustedPublicDemoFlow: false })).toBe(false);
  });
});
