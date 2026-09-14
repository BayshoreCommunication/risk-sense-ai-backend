import { Router } from 'express';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireFeature, requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { audit } from '../audit/service';
import { toCsv, toPdf } from './export';
import { ExportQuery, ReportParams, ReportQuery, TrendsQuery, type ReportType } from './schema';
import { reportsService } from './service';

/** Reports & analytics [PAID reports] — FR-26..28, DASH-03. Requestors are department-scoped inside the service (DASH-04). */
export const reportsRouter = Router();
export const analyticsRouter = Router();
const READERS = requireRole('requestor', 'administrator', 'system_administrator', 'audit');
for (const r of [reportsRouter, analyticsRouter]) r.use(authenticate, requireSession, requireFeature('reports'), READERS);

const TITLES: Record<ReportType, string> = { volume: 'Assessment volume', classification: 'Classification distribution', 'override-rate': 'Override rate', 'assessment-time': 'Average assessment time' };

reportsRouter.get('/:type', validate({ params: ReportParams, query: ReportQuery }), async (req, res) => {
  ok(res, await reportsService.report(req.user!, req.tenant!, (req.params as { type: ReportType }).type, req.query as unknown as ReportQuery));
});

/** FR-28: CSV/PDF of exactly what the screen shows. Exports are audited (SEC-05: who took data out, and what). */
reportsRouter.get('/:type/export', validate({ params: ReportParams, query: ExportQuery }), async (req, res) => {
  const type = (req.params as { type: ReportType }).type;
  const q = req.query as unknown as ExportQuery;
  const report = await reportsService.report(req.user!, req.tenant!, type, q);
  const stamp = report.range.to.slice(0, 10);
  const name = `risksense-${type}-${stamp}.${q.format}`;
  await audit.write({ tenantId: req.user!.tenantId, category: 'access', action: 'report.exported', actor: req.user!, entity: { type: 'report', id: type }, payload: { format: q.format, params: report.params, rows: report.rows.length } });
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  if (q.format === 'csv') {
    res.type('text/csv; charset=utf-8').send(toCsv(report));
  } else {
    const pdf = await toPdf(report, TITLES[type], { tenant: req.tenant!.slug, generatedBy: req.user!.email });
    res.type('application/pdf').send(pdf);
  }
});

analyticsRouter.get('/trends', validate({ query: TrendsQuery }), async (req, res) => {
  ok(res, await reportsService.trends(req.user!, req.tenant!, req.query as unknown as TrendsQuery));
});
