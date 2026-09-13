import { Router } from 'express';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireSession } from '../../middleware/session';
import { DepartmentModel } from './model';

export const departmentsRouter = Router();
departmentsRouter.use(authenticate, requireSession);

/**
 * GET /departments — the caller's tenant departments (id + name), any role.
 * Read-only lookup for dashboard filters (DASH-01) and, later, persona ↔ department mapping (FR-10, T-028).
 * Always tenant-scoped (NFR-04); FREE tenants simply have none.
 */
departmentsRouter.get('/', async (req, res) => {
  const items = await DepartmentModel.find({ tenantId: req.user!.tenantId }).sort({ name: 1 }).select('name personaIds').lean();
  ok(
    res,
    items.map((d) => ({ _id: String(d._id), name: d.name, personaIds: (d.personaIds ?? []).map(String) })),
  );
});
