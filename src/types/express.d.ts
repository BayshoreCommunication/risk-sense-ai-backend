import type { AuthUser, AuthTenant } from '../middleware/auth';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      tenant?: AuthTenant;
      sessionId?: string;
    }
  }
}

export {};
