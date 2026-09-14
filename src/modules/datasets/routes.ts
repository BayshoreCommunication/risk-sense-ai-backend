import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { datasetsLimiter } from '../../middleware/limits';
import { validate } from '../../middleware/validate';
import { datasetsService } from './service';
import { buildTemplateWorkbook } from './template';

export const datasetsRouter = Router();
datasetsRouter.use(authenticate, requireSession);

const ADMIN = requireRole('administrator');
const READERS = requireRole('administrator', 'system_administrator', 'audit');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

export const IdParams = z.object({ id: z.string().min(1) });
export const JsonUploadBody = z.object({ fileName: z.string().min(1).max(200).default('content.json'), content: z.record(z.unknown()) });

/** GET /datasets/template — the XLSX TAC fills in (T-006). */
datasetsRouter.get('/template', READERS, async (_req, res) => {
  const buf = await buildTemplateWorkbook();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="risksense-content-template.xlsx"');
  res.send(buf);
});

datasetsRouter.get('/', READERS, async (req, res) => {
  ok(res, await datasetsService.list(req.user!.tenantId));
});

/**
 * POST /datasets — multipart `file` (.xlsx) or JSON `{ fileName, content }` (template column names).
 * Always stores a dataset record: `validated` or `rejected` with row errors. Nothing is applied (FR-13).
 */
datasetsRouter.post('/', ADMIN, datasetsLimiter, upload.single('file'), async (req, res) => {
  const tenantId = req.user!.tenantId;
  if (req.file) {
    if (!req.file.originalname.toLowerCase().endsWith('.xlsx')) throw new AppError('VALIDATION_ERROR', 'Only .xlsx files are accepted');
    ok(res, await datasetsService.upload(tenantId, { fileName: req.file.originalname, buffer: req.file.buffer }, req.user!), 201);
    return;
  }
  const body = JsonUploadBody.parse(req.body);
  ok(res, await datasetsService.upload(tenantId, { fileName: body.fileName, json: body.content }, req.user!), 201);
});

datasetsRouter.get('/:id', READERS, validate({ params: IdParams }), async (req, res) => {
  ok(res, await datasetsService.get(req.user!.tenantId, req.params.id as string));
});

datasetsRouter.post('/:id/approve', ADMIN, validate({ params: IdParams }), async (req, res) => {
  ok(res, await datasetsService.approve(req.user!.tenantId, req.params.id as string, req.user!));
});

datasetsRouter.post('/:id/activate', ADMIN, validate({ params: IdParams }), async (req, res) => {
  ok(res, await datasetsService.activate(req.user!.tenantId, req.params.id as string, req.user!));
});
