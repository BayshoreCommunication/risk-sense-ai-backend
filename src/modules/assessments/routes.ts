import { Router, type Request } from 'express';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { messagesLimiter, publicDemoAiLimiter } from '../../middleware/limits';
import { validate } from '../../middleware/validate';
import { DecisionBody, IdParams, ListQuery, MessageBody, PersonaBody, StartBody, UnmaskQuery } from './schema';
import { assessmentsService } from './service';
import { assessmentRequestScope } from './public-demo-scope';

export const assessmentsRouter = Router();
assessmentsRouter.use(authenticate, requireSession);

const REQUESTOR = requireRole('requestor');
const READERS = requireRole('requestor', 'administrator', 'system_administrator', 'audit');
const scope = (req: Request) => assessmentRequestScope(req.accessMode, req.sessionId);

/** POST /assessments — start an intake (persona given, or inferred from the description). */
assessmentsRouter.post('/', REQUESTOR, publicDemoAiLimiter, validate({ body: StartBody }), async (req, res) => {
  ok(res, await assessmentsService.start(req.user!, req.tenant!, req.body, scope(req)), 201);
});

assessmentsRouter.get('/', READERS, validate({ query: ListQuery }), async (req, res) => {
  ok(res, await assessmentsService.list(req.user!, req.tenant!, req.query as unknown as ListQuery, scope(req)));
});

const unmask = (req: { query: unknown }) => (req.query as { unmask?: boolean }).unmask === true;

assessmentsRouter.get('/:id', READERS, validate({ params: IdParams, query: UnmaskQuery }), async (req, res) => {
  ok(res, await assessmentsService.get(req.user!, req.tenant!, req.params.id as string, unmask(req), scope(req)));
});

assessmentsRouter.get('/:id/messages', READERS, validate({ params: IdParams, query: UnmaskQuery }), async (req, res) => {
  ok(res, await assessmentsService.messages(req.user!, req.tenant!, req.params.id as string, unmask(req), scope(req)));
});

assessmentsRouter.post('/:id/persona', REQUESTOR, publicDemoAiLimiter, validate({ params: IdParams, body: PersonaBody }), async (req, res) => {
  ok(res, await assessmentsService.setPersona(req.user!, req.tenant!, req.params.id as string, (req.body as { personaKey: string }).personaKey, scope(req)));
});

assessmentsRouter.post('/:id/messages', REQUESTOR, publicDemoAiLimiter, messagesLimiter, validate({ params: IdParams, body: MessageBody }), async (req, res) => {
  ok(res, await assessmentsService.answer(req.user!, req.tenant!, req.params.id as string, req.body, scope(req)));
});

assessmentsRouter.post('/:id/submit', REQUESTOR, publicDemoAiLimiter, validate({ params: IdParams }), async (req, res) => {
  ok(res, await assessmentsService.submit(req.user!, req.tenant!, req.params.id as string, scope(req)));
});

const AUDITORS = requireRole('administrator', 'system_administrator', 'audit');

/** T-063 / FR-26: lifecycle rebuilt from the audit log alone, with per-entry hash check and conformance diff. */
assessmentsRouter.get('/:id/reconstruct', AUDITORS, validate({ params: IdParams, query: UnmaskQuery }), async (req, res) => {
  ok(res, await assessmentsService.reconstructFromAudit(req.user!, req.tenant!, req.params.id as string, unmask(req), scope(req)));
});

/** T-061: reviewers this assessment can be escalated to (PAID routing; empty list on FREE). */
assessmentsRouter.get('/:id/escalation-targets', REQUESTOR, validate({ params: IdParams }), async (req, res) => {
  ok(res, await assessmentsService.escalationTargets(req.user!, req.tenant!, req.params.id as string, scope(req)));
});

assessmentsRouter.post('/:id/decision', REQUESTOR, validate({ params: IdParams, body: DecisionBody }), async (req, res) => {
  ok(res, await assessmentsService.decide(req.user!, req.tenant!, req.params.id as string, req.body, scope(req)));
});
