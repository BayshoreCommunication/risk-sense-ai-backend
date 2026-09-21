import type { AuthUser, AuthTenant } from '../middleware/auth';
import type { AccessMode } from '../modules/auth/model';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      tenant?: AuthTenant;
      sessionId?: string;
      /** True only when the identity token for this request proves a second factor. */
      identityMfa?: boolean;
      /** Exact persisted + environment allowlist result, independent of the presented credential. */
      publicDemoAccount?: boolean;
      /** True only for the server-issued public-demo session credential path. */
      publicDemoEligible?: boolean;
      /** Derived from the validated application session, never from a browser hint. */
      accessMode?: AccessMode;
    }
  }
}

export {};
