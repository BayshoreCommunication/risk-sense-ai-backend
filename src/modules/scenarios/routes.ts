import { Router } from 'express';
import type { z } from 'zod';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { IdParams, ScenarioBody, ScenarioListQuery, ScenarioPatch } from './schema';
import { scenariosService } from './service';

export const scenariosRouter = Router();
scenariosRouter.use(authenticate, requireSession);

const ADMIN = requireRole('administrator');
const READERS = requireRole('administrator', 'system_administrator', 'audit');

scenariosRouter.get('/', READERS, validate({ query: ScenarioListQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof ScenarioListQuery>;
  ok(res, await scenariosService.list(req.user!.tenantId, q, req.user!.role === 'administrator'));
});

scenariosRouter.post('/', ADMIN, validate({ body: ScenarioBody }), async (req, res) => {
  ok(res, await scenariosService.create(req.user!.tenantId, req.body, req.user!), 201);
});

scenariosRouter.get('/:id', READERS, validate({ params: IdParams }), async (req, res) => {
  ok(res, await scenariosService.get(req.user!.tenantId, req.params.id as string));
});

scenariosRouter.get('/:id/history', READERS, validate({ params: IdParams }), async (req, res) => {
  const doc = await scenariosService.get(req.user!.tenantId, req.params.id as string);
  ok(res, await scenariosService.history(req.user!.tenantId, String(doc.versionGroupId)));
});

scenariosRouter.patch('/:id', ADMIN, validate({ params: IdParams, body: ScenarioPatch }), async (req, res) => {
  ok(res, await scenariosService.update(req.user!.tenantId, req.params.id as string, req.body, req.user!));
});

scenariosRouter.post('/:id/activate', ADMIN, validate({ params: IdParams }), async (req, res) => {
  ok(res, await scenariosService.activate(req.user!.tenantId, req.params.id as string, req.user!));
});

scenariosRouter.post('/:id/deactivate', ADMIN, validate({ params: IdParams }), async (req, res) => {
  ok(res, await scenariosService.deactivate(req.user!.tenantId, req.params.id as string, req.user!));
});
