import { Router } from 'express';
import type { z } from 'zod';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { IdParams, PersonaBody, PersonaListQuery, PersonaPatch } from './schema';
import { personasService } from './service';
import { activePersonasForUser, contentTenantId } from '../assessments/content';

export const personasRouter = Router();
personasRouter.use(authenticate, requireSession);

const ADMIN = requireRole('administrator');
const READERS = requireRole('requestor', 'administrator', 'system_administrator', 'audit');
const HISTORY_READERS = requireRole('administrator', 'system_administrator', 'audit');

/** GET /personas — requestors see active versions only; administrators see every version by default (FR-09). */
personasRouter.get('/', READERS, validate({ query: PersonaListQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof PersonaListQuery>;
  if (req.user!.role === 'requestor') {
    const contentTenant = await contentTenantId(req.user!.tenantId);
    const allowed = await activePersonasForUser(req.user!, req.tenant!, contentTenant);
    const visible = allowed.filter((persona) => (!q.key || persona.key === q.key) && (!q.sector || persona.sector === q.sector));
    ok(res, visible);
    return;
  }
  ok(res, await personasService.list(req.user!.tenantId, q, req.user!.role === 'administrator'));
});

personasRouter.post('/', ADMIN, validate({ body: PersonaBody }), async (req, res) => {
  ok(res, await personasService.create(req.user!.tenantId, req.body, req.user!), 201);
});

personasRouter.get('/:id', READERS, validate({ params: IdParams }), async (req, res) => {
  ok(res, await personasService.get(req.user!.tenantId, req.params.id as string));
});

personasRouter.get('/:id/history', HISTORY_READERS, validate({ params: IdParams }), async (req, res) => {
  const doc = await personasService.get(req.user!.tenantId, req.params.id as string);
  ok(res, await personasService.history(req.user!.tenantId, String(doc.versionGroupId)));
});

personasRouter.patch('/:id', ADMIN, validate({ params: IdParams, body: PersonaPatch }), async (req, res) => {
  ok(res, await personasService.update(req.user!.tenantId, req.params.id as string, req.body, req.user!));
});

personasRouter.post('/:id/activate', ADMIN, validate({ params: IdParams }), async (req, res) => {
  ok(res, await personasService.activate(req.user!.tenantId, req.params.id as string, req.user!));
});

personasRouter.post('/:id/deactivate', ADMIN, validate({ params: IdParams }), async (req, res) => {
  ok(res, await personasService.deactivate(req.user!.tenantId, req.params.id as string, req.user!));
});
