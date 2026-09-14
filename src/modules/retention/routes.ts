import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { retentionService } from './service';

/** System administrator: run / inspect retention enforcement for the caller's tenant (SEC-06). */
export const retentionRouter = Router();
retentionRouter.use(authenticate, requireSession, requireRole('system_administrator'));

export const RunBody = z.object({ dryRun: z.boolean().default(true) }).default({ dryRun: true });

retentionRouter.post('/run', validate({ body: RunBody }), async (req, res) => {
  const { dryRun } = req.body as z.infer<typeof RunBody>;
  const [result] = await retentionService.run({ dryRun, trigger: 'manual', actor: req.user!, tenantId: req.user!.tenantId });
  ok(res, result);
});

retentionRouter.get('/runs', async (req, res) => {
  ok(res, await retentionService.runs(req.user!.tenantId));
});
