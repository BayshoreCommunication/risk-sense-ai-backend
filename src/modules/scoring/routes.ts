import { Router } from 'express';
import type { z } from 'zod';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { ApproveBody, IdParams, MatrixBody, MatrixListQuery, MatrixPatch, SimulateBody } from './schema';
import { scoringService } from './service';

const ADMIN = requireRole('administrator');
const READERS = requireRole('administrator', 'system_administrator', 'audit');

/** /scoring-matrices — versioned + approval-gated (FR-18, FR-19, AI-05). */
export const matricesRouter = Router();
matricesRouter.use(authenticate, requireSession);
matricesRouter.get('/', READERS, validate({ query: MatrixListQuery }), async (req, res) => {
  ok(res, await scoringService.list(req.user!.tenantId, req.query as unknown as z.infer<typeof MatrixListQuery>, req.user!.role === 'administrator'));
});
matricesRouter.post('/', ADMIN, validate({ body: MatrixBody }), async (req, res) => {
  ok(res, await scoringService.create(req.user!.tenantId, req.body, req.user!), 201);
});
matricesRouter.get('/:id', READERS, validate({ params: IdParams }), async (req, res) => {
  ok(res, await scoringService.get(req.user!.tenantId, req.params.id as string));
});
matricesRouter.get('/:id/history', READERS, validate({ params: IdParams }), async (req, res) => {
  const doc = await scoringService.get(req.user!.tenantId, req.params.id as string);
  ok(res, await scoringService.history(req.user!.tenantId, String(doc.versionGroupId)));
});
matricesRouter.patch('/:id', ADMIN, validate({ params: IdParams, body: MatrixPatch }), async (req, res) => {
  ok(res, await scoringService.update(req.user!.tenantId, req.params.id as string, req.body, req.user!));
});
matricesRouter.post('/:id/approve', ADMIN, validate({ params: IdParams, body: ApproveBody }), async (req, res) => {
  ok(res, await scoringService.approve(req.user!.tenantId, req.params.id as string, req.user!, (req.body as { changeRef: string }).changeRef));
});
matricesRouter.post('/:id/activate', ADMIN, validate({ params: IdParams }), async (req, res) => {
  ok(res, await scoringService.activate(req.user!.tenantId, req.params.id as string, req.user!));
});
matricesRouter.post('/:id/deactivate', ADMIN, validate({ params: IdParams }), async (req, res) => {
  ok(res, await scoringService.deactivate(req.user!.tenantId, req.params.id as string, req.user!));
});

/** /scoring/simulate — the FR-18 test harness. */
export const scoringRouter = Router();
scoringRouter.use(authenticate, requireSession);
scoringRouter.post('/simulate', ADMIN, validate({ body: SimulateBody }), async (req, res) => {
  ok(res, await scoringService.simulate(req.user!.tenantId, req.body));
});
