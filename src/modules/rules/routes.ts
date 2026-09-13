import { Router } from 'express';
import type { z } from 'zod';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { ApproveBody, IdParams, RuleBody, RuleListQuery, RulePatch } from './schema';
import { rulesService } from './service';

export const rulesRouter = Router();
rulesRouter.use(authenticate, requireSession);

const ADMIN = requireRole('administrator');
const READERS = requireRole('administrator', 'system_administrator', 'audit');

rulesRouter.get('/', READERS, validate({ query: RuleListQuery }), async (req, res) => {
  ok(res, await rulesService.list(req.user!.tenantId, req.query as unknown as z.infer<typeof RuleListQuery>));
});
rulesRouter.post('/', ADMIN, validate({ body: RuleBody }), async (req, res) => {
  ok(res, await rulesService.create(req.user!.tenantId, req.body, req.user!), 201);
});
rulesRouter.get('/:id', READERS, validate({ params: IdParams }), async (req, res) => {
  ok(res, await rulesService.get(req.user!.tenantId, req.params.id as string));
});
rulesRouter.patch('/:id', ADMIN, validate({ params: IdParams, body: RulePatch }), async (req, res) => {
  ok(res, await rulesService.update(req.user!.tenantId, req.params.id as string, req.body, req.user!));
});
rulesRouter.post('/:id/approve', ADMIN, validate({ params: IdParams, body: ApproveBody }), async (req, res) => {
  ok(res, await rulesService.approve(req.user!.tenantId, req.params.id as string, req.user!, (req.body as { changeRef?: string }).changeRef));
});
rulesRouter.post('/:id/activate', ADMIN, validate({ params: IdParams }), async (req, res) => {
  ok(res, await rulesService.activate(req.user!.tenantId, req.params.id as string, req.user!));
});
rulesRouter.post('/:id/retire', ADMIN, validate({ params: IdParams }), async (req, res) => {
  ok(res, await rulesService.retire(req.user!.tenantId, req.params.id as string, req.user!));
});
