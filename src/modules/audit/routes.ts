import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { AUDIT_CATEGORIES, AuditLogModel } from './model';
import { audit } from './service';

export const auditRouter = Router();
auditRouter.use(authenticate, requireSession);

export const ListAuditQuery = z.object({
  category: z.enum(AUDIT_CATEGORIES).optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursorSeq: z.coerce.number().int().optional(), // paginate by seq descending
});

/** GET /audit-logs — read only (administrator, system_administrator, audit). */
auditRouter.get('/', requireRole('administrator', 'system_administrator', 'audit'), validate({ query: ListAuditQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof ListAuditQuery>;
  const filter: Record<string, unknown> = { tenantId: req.user!.tenantId };
  if (q.category) filter.category = q.category;
  if (q.entityType) filter['entity.type'] = q.entityType;
  if (q.entityId) filter['entity.id'] = q.entityId;
  if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.cursorSeq) filter.seq = { $lt: q.cursorSeq };
  const items = await AuditLogModel.find(filter).sort({ seq: -1 }).limit(q.limit).lean();
  ok(res, { items, nextCursorSeq: items.length === q.limit ? items[items.length - 1]!.seq : null });
});

/** GET /audit-logs/verify — recompute the hash chain (system_administrator, audit). */
auditRouter.get('/verify', requireRole('system_administrator', 'audit'), async (req, res) => {
  ok(res, await audit.verify(req.user!.tenantId));
});
