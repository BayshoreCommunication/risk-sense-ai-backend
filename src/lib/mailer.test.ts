import { describe, expect, it } from 'vitest';
import { AppError } from './errors';
import { resolveResendRecipient } from './mailer';

describe('production mail safety [FR-01, SEC-03]', () => {
  it('refuses a Resend sandbox sender instead of rerouting a production OTP [FR-01, SEC-03]', () => {
    expect(() =>
      resolveResendRecipient('customer@example.com', 'RiskSense AI <onboarding@resend.dev>', true),
    ).toThrowError(AppError);
  });

  it('keeps sandbox rerouting non-production-only and preserves verified senders [FR-01, SEC-03]', () => {
    expect(resolveResendRecipient('customer@example.com', 'onboarding@resend.dev', false)).toBe(
      'coderaise247@gmail.com',
    );
    expect(resolveResendRecipient('customer@example.com', 'RiskSense AI <otp@risksense.example>', true)).toBe(
      'customer@example.com',
    );
  });
});
