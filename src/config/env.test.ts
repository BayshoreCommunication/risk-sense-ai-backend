import { describe, expect, it } from 'vitest';
import { envSchema, mailDeliveryStatus } from './env';

const production = {
  NODE_ENV: 'production',
  FIREBASE_SERVICE_ACCOUNT_B64: 'e30=',
  MAIL_PROVIDER: 'smtp',
  SMTP_URL: 'smtp://example.invalid',
  MONGODB_URI: 'mongodb+srv://example.invalid/risksense',
  CORS_ORIGINS: 'https://app.example.invalid',
  CRON_SECRET: 'test-cron-secret-12345',
};

describe('production environment guardrails [FR-01, FR-08, SEC-03, SEC-04]', () => {
  it('requires an exact immutable tenant id whenever public demo access is enabled [SEC-03]', () => {
    const missing = envSchema.safeParse({ PUBLIC_DEMO_ACCESS_ENABLED: 'true' });
    expect(missing.success).toBe(false);
    const malformed = envSchema.safeParse({ PUBLIC_DEMO_ACCESS_ENABLED: 'true', PUBLIC_DEMO_TENANT_ID: 'tac' });
    expect(malformed.success).toBe(false);
    const configured = envSchema.safeParse({
      PUBLIC_DEMO_ACCESS_ENABLED: 'true',
      PUBLIC_DEMO_TENANT_ID: 'abcdefabcdefabcdefabcdef',
    });
    expect(configured.success).toBe(true);
  });

  it('rejects mock AI and a missing OpenAI credential in production', () => {
    const result = envSchema.safeParse({ ...production, AI_PROVIDER: 'mock' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(expect.arrayContaining(['AI_PROVIDER', 'OPENAI_API_KEY']));
  });

  it('accepts an explicitly configured production OpenAI provider', () => {
    const result = envSchema.safeParse({ ...production, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' });
    expect(result.success).toBe(true);
  });

  it('rejects local infrastructure, insecure origins, and missing mail-provider credentials', () => {
    const result = envSchema.safeParse({
      ...production,
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/risksense',
      CORS_ORIGINS: 'http://localhost:3000,*',
      SMTP_URL: undefined,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['MONGODB_URI', 'CORS_ORIGINS', 'SMTP_URL']),
    );
  });

  it('rejects malformed production endpoints and whitespace-only secrets', () => {
    const result = envSchema.safeParse({
      ...production,
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: '   ',
      FIREBASE_SERVICE_ACCOUNT_B64: '   ',
      MONGODB_URI: 'https://database.example.invalid/risksense',
      CORS_ORIGINS: 'https://,https://app.example.invalid/path',
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining(['OPENAI_API_KEY', 'FIREBASE_SERVICE_ACCOUNT_B64', 'MONGODB_URI', 'CORS_ORIGINS']),
    );
  });

  it('rejects the Resend sandbox sender in production [FR-01, SEC-03]', () => {
    const result = envSchema.safeParse({
      ...production,
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      MAIL_PROVIDER: 'resend',
      MAIL_FROM: 'RiskSense AI <onboarding@resend.dev>',
      RESEND_API_KEY: 'test-resend-key',
      SMTP_URL: undefined,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('MAIL_FROM');
  });

  it('allows an explicit demo-only startup override without making sandbox delivery valid [FR-01, SEC-03, NFR-05]', () => {
    const result = envSchema.safeParse({
      ...production,
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-key',
      MAIL_PROVIDER: 'resend',
      MAIL_FROM: 'RiskSense AI <onboarding@resend.dev>',
      RESEND_API_KEY: 'test-resend-key',
      SMTP_URL: undefined,
      ALLOW_RESEND_SANDBOX_STARTUP: 'true',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ALLOW_RESEND_SANDBOX_STARTUP).toBe(true);
    expect(mailDeliveryStatus(result.data.MAIL_PROVIDER, result.data.MAIL_FROM, true)).toBe(
      'blocked_sandbox_sender',
    );
  });

  it('requires a nonblank 16+ character nightly-job credential in production [SEC-06, SEC-07]', () => {
    for (const CRON_SECRET of [undefined, '', 'too-short', '                ', 'valid-length-but\nunsafe', 'development-cron-secret-change-me']) {
      const result = envSchema.safeParse({ ...production, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', CRON_SECRET });
      expect(result.success, JSON.stringify(CRON_SECRET)).toBe(false);
      if (result.success) continue;
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('CRON_SECRET');
    }
  });
});
