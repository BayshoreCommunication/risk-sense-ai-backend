import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      MAIL_PROVIDER: 'resend',
      MAIL_FROM: 'RiskSense AI <onboarding@resend.dev>',
      RESEND_API_KEY: 'test-resend-key',
    },
    isProd: true,
  };
});

import { AppError } from './errors';
import { resolveResendRecipient, sendMail } from './mailer';

describe('production mail safety [FR-01, SEC-03]', () => {
  it('refuses a Resend sandbox sender instead of rerouting a production OTP [FR-01, SEC-03]', () => {
    expect(() =>
      resolveResendRecipient('customer@example.com', 'RiskSense AI <onboarding@resend.dev>', true),
    ).toThrowError(AppError);
  });

  it('blocks production delivery before calling Resend [FR-01, SEC-03]', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(
      sendMail({ to: 'customer@example.com', subject: 'Your verification code', text: 'Code: 123456' }),
    ).rejects.toMatchObject({ code: 'MAIL_SEND_FAILED' });
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
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
