import type { App } from 'firebase-admin/app';
import { env } from '../config/env';
import { AppError } from './errors';

let app: App | undefined;

/**
 * Lazy Firebase Admin init: only loaded when a real token must be verified, so local dev
 * with AUTH_DEV_BYPASS and tests never require credentials.
 */
async function getApp(): Promise<App> {
  if (app) return app;
  if (!env.FIREBASE_SERVICE_ACCOUNT_B64) {
    throw new AppError('UNAUTHENTICATED', 'Firebase is not configured on this server');
  }
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(Buffer.from(env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
  } catch (e) {
    throw new AppError('INTERNAL', `Firebase service account JSON parse failed: ${(e as Error)?.message}`);
  }
  try {
    app = getApps()[0] ?? initializeApp({ credential: cert(json as Parameters<typeof cert>[0]), projectId: env.FIREBASE_PROJECT_ID ?? (json.project_id as string) });
  } catch (e) {
    throw new AppError('INTERNAL', `Firebase initializeApp failed: ${(e as Error)?.message}`);
  }
  return app;
}

export interface VerifiedToken {
  uid: string;
  email?: string;
  name?: string;
  /** Firebase sets this when the user completed a second factor. Mirrors users.mfaEnrolled (SEC-03). */
  mfa: boolean;
  /** `firebase.sign_in_provider`: `password`, `google.com`, `microsoft.com`, `oidc.<id>`, `saml.<id>` … (FR-03 SSO). */
  signInProvider?: string;
}

export async function verifyIdToken(idToken: string): Promise<VerifiedToken> {
  const { getAuth } = await import('firebase-admin/auth');
  const a = await getApp();
  try {
    const decoded = await getAuth(a).verifyIdToken(idToken, true);
    if (!decoded.email || decoded.email_verified !== true) {
      throw new AppError('UNAUTHENTICATED', 'A verified email address is required');
    }
    const fb = decoded.firebase as { sign_in_second_factor?: string; sign_in_provider?: string } | undefined;
    return { uid: decoded.uid, email: decoded.email, name: decoded.name as string | undefined, mfa: Boolean(fb?.sign_in_second_factor), signInProvider: fb?.sign_in_provider };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired ID token');
  }
}
