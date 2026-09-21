import { Router } from 'express';
import { z } from 'zod';
import { canonicalJson, sha256 } from '../../lib/hash';
import { ok } from '../../lib/http';
import { AppError } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireFeature, requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { maskAuditPayload } from '../../lib/sensitive';
import { AUDIT_CATEGORIES, AuditLogModel } from './model';
import { audit, redactAuditEntrySecrets } from './service';
import { AuditArchiveManifestModel } from './archive.model';
import { withMongoTransaction } from '../../lib/db';

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
  unmask: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const ArchiveAuditBody = z
  .object({ from: z.coerce.date(), to: z.coerce.date(), maxRecords: z.number().int().min(1).max(10_000).default(5_000) })
  .strict()
  .refine((value) => value.from <= value.to, { message: 'from must be before or equal to to', path: ['to'] });

/** GET /audit-logs — read only (administrator, system_administrator, audit). */
auditRouter.get('/', requireRole('administrator', 'system_administrator', 'audit'), validate({ query: ListAuditQuery }), async (req, res) => {
  const q = req.query as unknown as z.infer<typeof ListAuditQuery>;
  const filter: Record<string, unknown> = { tenantId: req.user!.tenantId };
  if (q.category) filter.category = q.category;
  if (q.entityType) filter['entity.type'] = q.entityType;
  if (q.entityId) filter['entity.id'] = q.entityId;
  if (q.from || q.to) filter.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  if (q.cursorSeq) filter.seq = { $lt: q.cursorSeq };
  const storedItems = await AuditLogModel.find(filter).sort({ seq: -1 }).limit(q.limit).lean();
  const items = storedItems.map(redactAuditEntrySecrets);
  if (q.unmask) {
    await audit.write({
      tenantId: req.user!.tenantId,
      category: 'access',
      action: 'access.unmasked',
      actor: req.user!,
      entity: { type: 'audit_log_query', id: q.entityId ?? `cursor:${q.cursorSeq ?? 'latest'}` },
      payload: { what: 'audit payloads', itemCount: items.length, category: q.category ?? null, entityType: q.entityType ?? null },
    });
  }
  const visible = q.unmask ? items : items.map((item) => ({ ...item, payload: maskAuditPayload(item.payload), payloadMasked: true }));
  ok(res, { items: visible, nextCursorSeq: items.length === q.limit ? items[items.length - 1]!.seq : null });
});

/** GET /audit-logs/verify — recompute the hash chain (system_administrator, audit). */
auditRouter.get('/verify', requireRole('system_administrator', 'audit'), async (req, res) => {
  ok(res, await audit.verify(req.user!.tenantId));
});

/**
 * POST /audit-logs/archive — streams a bounded immutable range to an authorized operator and records an
 * immutable manifest/hash. Logs remain untouched; the returned records are what the operator stores in the
 * tenant's approved cold-storage system (SEC-06, SEC-07).
 */
auditRouter.post(
  '/archive',
  requireRole('system_administrator'),
  requireFeature('fullAudit'),
  validate({ body: ArchiveAuditBody }),
  async (req, res) => {
    if (req.accessMode === 'public_demo_sandbox') {
      throw new AppError('FORBIDDEN', 'Public demo sessions cannot export raw audit records');
    }
    const body = req.body as z.infer<typeof ArchiveAuditBody>;
    const range = { $gte: body.from, $lte: body.to };
    const count = await AuditLogModel.countDocuments({ tenantId: req.user!.tenantId, createdAt: range });
    if (count === 0) throw new AppError('NOT_FOUND', 'No audit records exist in that range');
    if (count > body.maxRecords) {
      throw new AppError('VALIDATION_ERROR', `Range contains ${count} records; narrow it or raise maxRecords up to 10000`, { count, maxRecords: body.maxRecords });
    }
    const storedRecords = await AuditLogModel.find({ tenantId: req.user!.tenantId, createdAt: range }).sort({ seq: 1 }).lean();
    // Historical session events may contain a bearer-equivalent id. Archive output is a sanitized,
    // consistently hashed view; the database hash-chain remains verified against its stored form.
    const records = storedRecords.map(redactAuditEntrySecrets);
    const exportHash = sha256(canonicalJson(records));
    const manifest = await withMongoTransaction(async () => {
      const created = await AuditArchiveManifestModel.create({
        tenantId: req.user!.tenantId,
        from: body.from,
        to: body.to,
        firstSeq: records[0]!.seq,
        lastSeq: records[records.length - 1]!.seq,
        recordCount: records.length,
        exportHash,
        actorUserId: req.user!.id,
      });
      await audit.write({
        tenantId: req.user!.tenantId,
        category: 'retention',
        action: 'audit.archive_created',
        actor: req.user!,
        entity: { type: 'audit_archive_manifest', id: String(created._id) },
        payload: { from: body.from, to: body.to, firstSeq: records[0]!.seq, lastSeq: records[records.length - 1]!.seq, recordCount: records.length, exportHash },
      });
      return created;
    });
    ok(res, { manifest: manifest.toObject(), records }, 201);
  },
);

auditRouter.get('/archive-manifests', requireRole('system_administrator', 'audit'), requireFeature('fullAudit'), async (req, res) => {
  const items = await AuditArchiveManifestModel.find({ tenantId: req.user!.tenantId }).sort({ createdAt: -1 }).limit(100).lean();
  ok(res, items);
});
