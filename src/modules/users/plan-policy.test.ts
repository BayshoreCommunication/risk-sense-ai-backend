import { describe, expect, it } from 'vitest';
import { assertRoleAllowedForPlan } from './plan-policy';

describe('tenant plan role policy [FR-02, SEC-01]', () => {
  it('allows only requestors on FREE and allows managed roles on PAID [FR-02]', () => {
    expect(() => assertRoleAllowedForPlan('free', 'requestor')).not.toThrow();
    for (const role of ['requestor', 'administrator', 'system_administrator', 'audit'] as const) {
      expect(() => assertRoleAllowedForPlan('paid', role)).not.toThrow();
    }
    for (const role of ['administrator', 'system_administrator', 'audit'] as const) {
      try {
        assertRoleAllowedForPlan('free', role);
        throw new Error(`${role} unexpectedly allowed`);
      } catch (error) {
        expect(error).toMatchObject({ code: 'FEATURE_DISABLED' });
      }
    }
  });
});
