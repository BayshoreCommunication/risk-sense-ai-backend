import { beforeEach, describe, expect, it, vi } from 'vitest';

const verifyToken = vi.hoisted(() => vi.fn());

vi.mock('../config/env', () => ({
  env: {
    FIREBASE_SERVICE_ACCOUNT_B64: 'eyJwcm9qZWN0X2lkIjoidGVzdCJ9',
    FIREBASE_PROJECT_ID: 'test',
  },
}));

vi.mock('firebase-admin/app', () => ({
  cert: vi.fn(() => ({})),
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(() => ({ name: 'test' })),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: vi.fn(() => ({ verifyIdToken: verifyToken })),
}));

import { verifyIdToken } from './firebase';

describe('Firebase ID-token verification [FR-01, SEC-01]', () => {
  beforeEach(() => {
    verifyToken.mockReset();
  });

  it.each([
    { email: undefined, email_verified: true },
    { email: 'person@example.com', email_verified: false },
    { email: 'person@example.com', email_verified: undefined },
  ])('rejects an identity without a Firebase-verified email (%o)', async (claims) => {
    verifyToken.mockResolvedValue({ uid: 'firebase-user', ...claims });

    await expect(verifyIdToken('token')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'A verified email address is required',
    });
  });

  it('returns only the verified identity and authentication factors used by the app', async () => {
    verifyToken.mockResolvedValue({
      uid: 'firebase-user',
      email: 'person@example.com',
      email_verified: true,
      name: 'Verified Person',
      firebase: { sign_in_provider: 'saml.acme', sign_in_second_factor: 'phone' },
    });

    await expect(verifyIdToken('token')).resolves.toEqual({
      uid: 'firebase-user',
      email: 'person@example.com',
      name: 'Verified Person',
      mfa: true,
      signInProvider: 'saml.acme',
    });
  });

  it('does not expose provider verification failures', async () => {
    verifyToken.mockRejectedValue(new Error('provider detail'));

    await expect(verifyIdToken('bad-token')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
      message: 'Invalid or expired ID token',
    });
  });
});
