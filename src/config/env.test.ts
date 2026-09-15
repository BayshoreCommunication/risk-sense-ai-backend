import { describe, expect, it } from 'vitest';
import { envSchema } from './env';

const production = {
  NODE_ENV: 'production',
  FIREBASE_SERVICE_ACCOUNT_B64: 'e30=',
  MAIL_PROVIDER: 'smtp',
  SMTP_URL: 'smtp://example.invalid',
  MONGODB_URI: 'mongodb+srv://example.invalid/risksense',
  CORS_ORIGINS: 'https://app.example.invalid',
};

describe('production environment guardrails [FR-08, SEC-04]', () => {
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
});
