import { Router } from 'express';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { DecisionBody, IdParams, ListQuery, MessageBody, PersonaBody, StartBody } from './schema';
import { assessmentsService } from './service';

export const assessmentsRouter = Router();
assessmentsRouter.use(authenticate, requireSession);

const REQUESTOR = requireRole('requestor');
const READERS = requireRole('requestor', 'administrator', 'system_administrator', 'audit');

/** POST /assessments — start an intake (persona given, or inferred from the description). */
assessmentsRouter.post('/', REQUESTOR, validate({ body: StartBody }), async (req, res) => {
  ok(res, await assessmentsService.start(req.user!, req.tenant!, req.body), 201);
});

assessmentsRouter.get('/', READERS, validate({ query: ListQuery }), async (req, res) => {
  ok(res, await assessmentsService.list(req.user!, req.tenant!, req.query as unknown as ListQuery));
});

assessmentsRouter.get('/:id', READERS, validate({ params: IdParams }), async (req, res) => {
  ok(res, await assessmentsService.get(req.user!, req.params.id as string));
});

assessmentsRouter.get('/:id/messages', READERS, validate({ params: IdParams }), async (req, res) => {
  ok(res, await assessmentsService.messages(req.user!, req.params.id as string));
});

assessmentsRouter.post('/:id/persona', REQUESTOR, validate({ params: IdParams, body: PersonaBody }), async (req, res) => {
  ok(res, await assessmentsService.setPersona(req.user!, req.tenant!, req.params.id as string, (req.body as { personaKey: string }).personaKey));
});

assessmentsRouter.post('/:id/messages', REQUESTOR, validate({ params: IdParams, body: MessageBody }), async (req, res) => {
  ok(res, await assessmentsService.answer(req.user!, req.tenant!, req.params.id as string, req.body));
});

assessmentsRouter.post('/:id/submit', REQUESTOR, validate({ params: IdParams }), async (req, res) => {
  ok(res, await assessmentsService.submit(req.user!, req.tenant!, req.params.id as string));
});

/** T-061: reviewers this assessment can be escalated to (PAID routing; empty list on FREE). */
assessmentsRouter.get('/:id/escalation-targets', REQUESTOR, validate({ params: IdParams }), async (req, res) => {
  ok(res, await assessmentsService.escalationTargets(req.user!, req.tenant!, req.params.id as string));
});

assessmentsRouter.post('/:id/decision', REQUESTOR, validate({ params: IdParams, body: DecisionBody }), async (req, res) => {
  ok(res, await assessmentsService.decide(req.user!, req.tenant!, req.params.id as string, req.body));
});
