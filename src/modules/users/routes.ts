import { Router } from 'express';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireSession } from '../../middleware/session';

export const usersRouter = Router();

/** GET /me — current user, role, tenant plan/features (used by the frontend to route by role). */
usersRouter.get('/me', authenticate, requireSession, (req, res) => {
  ok(res, { user: req.user, tenant: req.tenant, sessionId: req.sessionId });
});
