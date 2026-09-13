import { Router } from 'express';
import type { z } from 'zod';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { IdParams, QuestionBody, QuestionListQuery, QuestionPatch } from './schema';
import { questionsService } from './service';

export const questionsRouter = Router();
questionsRouter.use(authenticate, requireSession);

const ADMIN = requireRole('administrator');
const READERS = requireRole('administrator', 'system_administrator', 'audit');

questionsRouter.get('/', READERS, validate({ query: QuestionListQuery }), async (req, res) => {
  ok(res, await questionsService.list(req.user!.tenantId, req.query as unknown as z.infer<typeof QuestionListQuery>));
});

questionsRouter.post('/', ADMIN, validate({ body: QuestionBody }), async (req, res) => {
  ok(res, await questionsService.create(req.user!.tenantId, req.body, req.user!), 201);
});

questionsRouter.get('/:id', READERS, validate({ params: IdParams }), async (req, res) => {
  ok(res, await questionsService.get(req.user!.tenantId, req.params.id as string));
});

questionsRouter.patch('/:id', ADMIN, validate({ params: IdParams, body: QuestionPatch }), async (req, res) => {
  ok(res, await questionsService.update(req.user!.tenantId, req.params.id as string, req.body, req.user!));
});

questionsRouter.post('/:id/retire', ADMIN, validate({ params: IdParams }), async (req, res) => {
  ok(res, await questionsService.retire(req.user!.tenantId, req.params.id as string, req.user!));
});
