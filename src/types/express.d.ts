import type { AuthUser, AuthTenant } from '../middleware/auth';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      tenant?: AuthTenant;
      sessionId?: string;
      /** True only when the identity token for this request proves a second factor. */
      identityMfa?: boolean;
    }
  }
}

export {};
