import { Types, type PipelineStage } from 'mongoose';
import { AppError } from '../../lib/errors';
import { canonicalJson, sha256 } from '../../lib/hash';
import type { AuthTenant, AuthUser } from '../../middleware/auth';
import { AssessmentModel } from '../assessments/model';
import { CLASSIFICATIONS } from '../shared/enums';
import { DepartmentModel } from '../tenants/model';
import { REPORT_CACHE_TTL_SEC, ReportModel } from './model';
import type { ReportQuery, ReportType, TrendsQuery } from './schema';

/**
 * Reports & analytics (FR-26/27, DASH-03). Every report is an aggregation over `assessments`, scoped to the
 * tenant and — for requestors — to their departments (DASH-04). Results are cached for the exact
 * (type, params, scope) for 1 h (W9). The final classification of an assessment is the human decision when
 * it overrode the AI (`decision.overriddenTo`), otherwise the AI's (`result.classification`).
 */
export type ReportRow = Record<string, string | number | null>;
export interface ReportResult {
  type: string;
  params: Record<string, unknown>;
  range: { from: string; to: string; interval: string };
  generatedAt: string;
  cached: boolean;
  computeMs: number;
  columns: { key: string; label: string; kind: 'text' | 'number' | 'percent' | 'seconds' }[];
  rows: ReportRow[];
  summary: Record<string, string | number | null>;
}

const DAY = 24 * 3600 * 1000;
const FINAL_CLASS = { $ifNull: ['$decision.overriddenTo', '$result.classification'] };

function range(q: ReportQuery) {
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - 365 * DAY);
  return { from, to };
}

/** Tenant + role scope (DASH-04) + optional filters; shared by every report. */
function baseMatch(user: AuthUser, q: ReportQuery) {
  const { from, to } = range(q);
  const m: Record<string, unknown> = { tenantId: new Types.ObjectId(user.tenantId), createdAt: { $gte: from, $lte: to } };
  if (user.role === 'requestor') {
    const me = new Types.ObjectId(user.id);
    if (!user.crossDepartmentAccess) m.$or = user.departmentIds.length ? [{ requestorId: me }, { departmentId: { $in: user.departmentIds.map((d) => new Types.ObjectId(d)) } }] : [{ requestorId: me }];
  }
  if (q.departmentId) m.departmentId = new Types.ObjectId(q.departmentId);
  if (q.personaKey) m.personaKey = q.personaKey;
  if (q.scenarioKey) m.scenarioKey = q.scenarioKey;
  return m;
}

/** `$dateTrunc` bucket for the interval, as an ISO date string key (UTC). */
const periodExpr = (interval: string, field = '$createdAt') => ({ $dateToString: { format: interval === 'month' ? '%Y-%m' : '%Y-%m-%d', date: { $dateTrunc: { date: field, unit: interval, ...(interval === 'week' ? { startOfWeek: 'monday' } : {}) } } } });

/** Every period between from and to, so charts show zero months instead of gaps. */
function periods(interval: string, from: Date, to: Date): string[] {
  const out: string[] = [];
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), interval === 'month' ? 1 : from.getUTCDate()));
  if (interval === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  while (d <= to && out.length < 800) {
    out.push(interval === 'month' ? d.toISOString().slice(0, 7) : d.toISOString().slice(0, 10));
    if (interval === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
    else d.setUTCDate(d.getUTCDate() + (interval === 'week' ? 7 : 1));
  }
  return out;
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const round = (n: unknown) => (typeof n === 'number' ? Math.round(n) : null);

type Computed = Pick<ReportResult, 'columns' | 'rows' | 'summary'>;

async function computeVolume(user: AuthUser, q: ReportQuery): Promise<Computed> {
  const { from, to } = range(q);
  const grouped = await AssessmentModel.aggregate<{ _id: string; started: number; closed: number; escalated: number; errorReview: number; inProgress: number }>([
    { $match: baseMatch(user, q) },
    { $group: { _id: periodExpr(q.interval), started: { $sum: 1 }, closed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } }, escalated: { $sum: { $cond: [{ $eq: ['$status', 'escalated'] }, 1, 0] } }, errorReview: { $sum: { $cond: [{ $eq: ['$status', 'error_review'] }, 1, 0] } }, inProgress: { $sum: { $cond: [{ $in: ['$status', ['in_progress', 'intake_complete']] }, 1, 0] } } } },
  ]);
  const by = new Map(grouped.map((g) => [g._id, g]));
  const rows: ReportRow[] = periods(q.interval, from, to).map((p) => {
    const g = by.get(p);
    return { period: p, started: g?.started ?? 0, closed: g?.closed ?? 0, escalated: g?.escalated ?? 0, errorReview: g?.errorReview ?? 0, inProgress: g?.inProgress ?? 0 };
  });
  const total = (k: string) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  return {
    columns: [{ key: 'period', label: 'Period', kind: 'text' }, { key: 'started', label: 'Started', kind: 'number' }, { key: 'closed', label: 'Closed', kind: 'number' }, { key: 'escalated', label: 'Escalated', kind: 'number' }, { key: 'errorReview', label: 'Error review', kind: 'number' }, { key: 'inProgress', label: 'In progress', kind: 'number' }],
    rows,
    summary: { started: total('started'), closed: total('closed'), escalated: total('escalated'), errorReview: total('errorReview'), inProgress: total('inProgress') },
  };
}

async function computeClassification(user: AuthUser, q: ReportQuery): Promise<Computed> {
  const grouped = await AssessmentModel.aggregate<{ _id: string; count: number; ruleDriven: number; professionalConsult: number; overriddenInto: number; avgScore: number; avgConfidence: number }>([
    { $match: { ...baseMatch(user, q), 'result.computedAt': { $exists: true } } },
    { $group: { _id: FINAL_CLASS, count: { $sum: 1 }, ruleDriven: { $sum: { $cond: ['$result.ruleDriven', 1, 0] } }, professionalConsult: { $sum: { $cond: ['$result.professionalConsult', 1, 0] } }, overriddenInto: { $sum: { $cond: [{ $in: ['$decision.overriddenTo', CLASSIFICATIONS] }, 1, 0] } }, avgScore: { $avg: '$result.score' }, avgConfidence: { $avg: '$result.confidence' } } },
  ]);
  const by = new Map(grouped.map((g) => [g._id, g]));
  const total = grouped.reduce((n, g) => n + g.count, 0);
  const rows: ReportRow[] = CLASSIFICATIONS.map((c) => {
    const g = by.get(c);
    return { classification: c, count: g?.count ?? 0, share: pct(g?.count ?? 0, total), ruleDriven: g?.ruleDriven ?? 0, professionalConsult: g?.professionalConsult ?? 0, overriddenInto: g?.overriddenInto ?? 0, avgScore: round(g?.avgScore), avgConfidence: round(g?.avgConfidence) };
  });
  return {
    columns: [{ key: 'classification', label: 'Classification', kind: 'text' }, { key: 'count', label: 'Assessments', kind: 'number' }, { key: 'share', label: 'Share', kind: 'percent' }, { key: 'ruleDriven', label: 'Rule-driven', kind: 'number' }, { key: 'professionalConsult', label: 'Professional consult', kind: 'number' }, { key: 'overriddenInto', label: 'Set by override', kind: 'number' }, { key: 'avgScore', label: 'Avg score', kind: 'number' }, { key: 'avgConfidence', label: 'Avg confidence', kind: 'percent' }],
    rows,
    summary: { scored: total, ruleDriven: rows.reduce((n, r) => n + Number(r.ruleDriven), 0), professionalConsult: rows.reduce((n, r) => n + Number(r.professionalConsult), 0) },
  };
}

async function computeOverrideRate(user: AuthUser, q: ReportQuery): Promise<Computed> {
  const { from, to } = range(q);
  const grouped = await AssessmentModel.aggregate<{ _id: string; decided: number; accepted: number; overridden: number; escalated: number; up: number; down: number }>([
    { $match: { ...baseMatch(user, q), 'decision.type': { $exists: true } } },
    { $addFields: { _ai: { $indexOfArray: [CLASSIFICATIONS, '$result.classification'] }, _human: { $indexOfArray: [CLASSIFICATIONS, '$decision.overriddenTo'] } } },
    { $group: { _id: periodExpr(q.interval, '$decision.decidedAt'), decided: { $sum: 1 }, accepted: { $sum: { $cond: [{ $eq: ['$decision.type', 'accept'] }, 1, 0] } }, overridden: { $sum: { $cond: [{ $eq: ['$decision.type', 'override'] }, 1, 0] } }, escalated: { $sum: { $cond: [{ $eq: ['$decision.type', 'escalate'] }, 1, 0] } }, up: { $sum: { $cond: [{ $and: [{ $eq: ['$decision.type', 'override'] }, { $gt: ['$_human', '$_ai'] }] }, 1, 0] } }, down: { $sum: { $cond: [{ $and: [{ $eq: ['$decision.type', 'override'] }, { $lt: ['$_human', '$_ai'] }] }, 1, 0] } } } },
  ]);
  const by = new Map(grouped.map((g) => [g._id, g]));
  const rows: ReportRow[] = periods(q.interval, from, to).map((p) => {
    const g = by.get(p);
    const decided = g?.decided ?? 0;
    return { period: p, decided, accepted: g?.accepted ?? 0, overridden: g?.overridden ?? 0, escalated: g?.escalated ?? 0, overrideRate: pct(g?.overridden ?? 0, (g?.accepted ?? 0) + (g?.overridden ?? 0)), acceptRate: pct(g?.accepted ?? 0, (g?.accepted ?? 0) + (g?.overridden ?? 0)), overriddenUp: g?.up ?? 0, overriddenDown: g?.down ?? 0 };
  });
  const sum = (k: string) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  const accepted = sum('accepted');
  const overridden = sum('overridden');
  // FR-23: override reasons are retrievable in reports (latest 50 in range)
  const reasons = await AssessmentModel.find({ ...baseMatch(user, q), 'decision.type': 'override' }).sort({ 'decision.decidedAt': -1 }).limit(50).select('decision.reason decision.overriddenTo decision.decidedAt result.classification personaKey scenarioKey').lean();
  return {
    columns: [{ key: 'period', label: 'Period', kind: 'text' }, { key: 'decided', label: 'Decided', kind: 'number' }, { key: 'accepted', label: 'Accepted', kind: 'number' }, { key: 'overridden', label: 'Overridden', kind: 'number' }, { key: 'escalated', label: 'Escalated', kind: 'number' }, { key: 'overrideRate', label: 'Override rate', kind: 'percent' }, { key: 'acceptRate', label: 'Accept rate (accuracy proxy)', kind: 'percent' }, { key: 'overriddenUp', label: 'Overridden up', kind: 'number' }, { key: 'overriddenDown', label: 'Overridden down', kind: 'number' }],
    rows,
    summary: {
      decided: sum('decided'), accepted, overridden, escalated: sum('escalated'), overrideRate: pct(overridden, accepted + overridden), acceptRate: pct(accepted, accepted + overridden),
      reasons: JSON.stringify(reasons.map((r) => ({ at: r.decision?.decidedAt, from: r.result?.classification ?? null, to: r.decision?.overriddenTo ?? null, reason: r.decision?.reason ?? null, personaKey: r.personaKey ?? null, scenarioKey: r.scenarioKey ?? null }))),
    },
  };
}

async function computeAssessmentTime(user: AuthUser, q: ReportQuery): Promise<Computed> {
  const { from, to } = range(q);
  const stages: PipelineStage[] = [
    { $match: { ...baseMatch(user, q), 'timing.intakeCompletedAt': { $exists: true } } },
    { $addFields: { intakeSec: { $divide: [{ $subtract: ['$timing.intakeCompletedAt', '$timing.startedAt'] }, 1000] }, decisionSec: { $cond: [{ $and: ['$timing.closedAt', '$timing.submittedAt'] }, { $divide: [{ $subtract: ['$timing.closedAt', '$timing.submittedAt'] }, 1000] }, null] }, totalSec: '$timing.durationSec' } },
    { $group: { _id: periodExpr(q.interval), n: { $sum: 1 }, closed: { $sum: { $cond: ['$timing.closedAt', 1, 0] } }, avgIntake: { $avg: '$intakeSec' }, avgDecision: { $avg: '$decisionSec' }, avgTotal: { $avg: '$totalSec' }, totals: { $push: '$totalSec' } } },
  ];
  const grouped = await AssessmentModel.aggregate<{ _id: string; n: number; closed: number; avgIntake: number; avgDecision: number | null; avgTotal: number | null; totals: (number | null)[] }>(stages);
  const by = new Map(grouped.map((g) => [g._id, g]));
  const quantile = (xs: number[], p: number) => (xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : null);
  const rows: ReportRow[] = periods(q.interval, from, to).map((p) => {
    const g = by.get(p);
    const totals = (g?.totals ?? []).filter((x): x is number => typeof x === 'number');
    return { period: p, assessments: g?.n ?? 0, closed: g?.closed ?? 0, avgIntakeSec: round(g?.avgIntake), avgDecisionSec: round(g?.avgDecision), avgTotalSec: round(g?.avgTotal), medianTotalSec: quantile(totals, 0.5), p95TotalSec: quantile(totals, 0.95) };
  });
  const all = grouped.flatMap((g) => g.totals.filter((x): x is number => typeof x === 'number'));
  const n = grouped.reduce((s, g) => s + g.n, 0);
  return {
    columns: [{ key: 'period', label: 'Period', kind: 'text' }, { key: 'assessments', label: 'Intakes completed', kind: 'number' }, { key: 'closed', label: 'Closed', kind: 'number' }, { key: 'avgIntakeSec', label: 'Avg intake', kind: 'seconds' }, { key: 'avgDecisionSec', label: 'Avg time to decision', kind: 'seconds' }, { key: 'avgTotalSec', label: 'Avg total', kind: 'seconds' }, { key: 'medianTotalSec', label: 'Median total', kind: 'seconds' }, { key: 'p95TotalSec', label: 'p95 total', kind: 'seconds' }],
    rows,
    summary: { assessments: n, avgIntakeSec: n ? round(grouped.reduce((s, g) => s + g.avgIntake * g.n, 0) / n) : null, avgTotalSec: all.length ? round(all.reduce((a, b) => a + b, 0) / all.length) : null, medianTotalSec: quantile([...all], 0.5), p95TotalSec: quantile([...all], 0.95) },
  };
}

const COMPUTE: Record<ReportType, (u: AuthUser, q: ReportQuery) => Promise<Computed>> = {
  volume: computeVolume,
  classification: computeClassification,
  'override-rate': computeOverrideRate,
  'assessment-time': computeAssessmentTime,
};

function scopeKey(user: AuthUser) {
  return user.role === 'requestor' && !user.crossDepartmentAccess ? { role: 'requestor', user: user.id, departments: [...user.departmentIds].sort() } : { role: 'tenant' };
}

function publicParams(q: ReportQuery | TrendsQuery) {
  const { from, to } = range(q);
  const p: Record<string, unknown> = { from: from.toISOString(), to: to.toISOString(), interval: q.interval };
  if (q.departmentId) p.departmentId = q.departmentId;
  if (q.personaKey) p.personaKey = q.personaKey;
  if (q.scenarioKey) p.scenarioKey = q.scenarioKey;
  if ('by' in q) p.by = q.by;
  return p;
}

/** Cache wrapper: exact (type, params, scope) → 1 h (W9). `refresh=true` recomputes. */
async function cached(user: AuthUser, tenant: AuthTenant, type: string, q: ReportQuery | TrendsQuery, compute: () => Promise<Computed>): Promise<ReportResult> {
  if (!tenant.features.reports) throw new AppError('FEATURE_DISABLED', 'reports are a PAID feature');
  const params = publicParams(q);
  const key = sha256(canonicalJson({ type, params, scope: scopeKey(user) }));
  const { from, to } = range(q);
  if (!q.refresh) {
    const hit = await ReportModel.findOne({ tenantId: user.tenantId, key, generatedAt: { $gte: new Date(Date.now() - REPORT_CACHE_TTL_SEC * 1000) } }).lean();
    if (hit) return { type, params, range: { from: from.toISOString(), to: to.toISOString(), interval: q.interval }, generatedAt: hit.generatedAt.toISOString(), cached: true, computeMs: hit.computeMs ?? 0, columns: (hit.summary as { columns: ReportResult['columns'] }).columns, rows: hit.rows as ReportRow[], summary: (hit.summary as { summary: ReportResult['summary'] }).summary };
  }
  const t0 = Date.now();
  const out = await compute();
  const computeMs = Date.now() - t0;
  const generatedAt = new Date();
  await ReportModel.findOneAndUpdate({ tenantId: user.tenantId, key }, { $set: { type, params, generatedAt, computeMs, rows: out.rows, summary: { columns: out.columns, summary: out.summary } } }, { upsert: true });
  return { type, params, range: { from: from.toISOString(), to: to.toISOString(), interval: q.interval }, generatedAt: generatedAt.toISOString(), cached: false, computeMs, ...out };
}

export const reportsService = {
  async report(user: AuthUser, tenant: AuthTenant, type: ReportType, q: ReportQuery) {
    return cached(user, tenant, type, q, () => COMPUTE[type](user, q));
  },

  /** FR-27 / DASH-03: per-period counts and average score per department | persona | scenario (top 8, rest → "other"). */
  async trends(user: AuthUser, tenant: AuthTenant, q: TrendsQuery) {
    return cached(user, tenant, `trends:${q.by}`, q, async () => {
      const { from, to } = range(q);
      const dim = q.by === 'department' ? '$departmentId' : q.by === 'persona' ? '$personaKey' : '$scenarioKey';
      const grouped = await AssessmentModel.aggregate<{ _id: { period: string; group: unknown }; count: number; avgScore: number | null; issues: number; elevated: number }>([
        { $match: baseMatch(user, q) },
        { $group: { _id: { period: periodExpr(q.interval), group: dim }, count: { $sum: 1 }, avgScore: { $avg: '$result.score' }, issues: { $sum: { $cond: [{ $eq: [FINAL_CLASS, 'issue'] }, 1, 0] } }, elevated: { $sum: { $cond: [{ $eq: [FINAL_CLASS, 'elevated_risk'] }, 1, 0] } } } },
      ]);
      const names = new Map<string, string>();
      if (q.by === 'department') for (const d of await DepartmentModel.find({ tenantId: user.tenantId }).select('name').lean()) names.set(String(d._id), d.name);
      const label = (g: unknown) => (g == null ? '(none)' : q.by === 'department' ? (names.get(String(g)) ?? String(g)) : String(g));
      const totals = new Map<string, number>();
      for (const g of grouped) totals.set(label(g._id.group), (totals.get(label(g._id.group)) ?? 0) + g.count);
      const ordered = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      const top = ordered.slice(0, 8);
      const series = ordered.length > 8 ? [...top, 'other'] : top;
      const fold = (k: string) => (top.includes(k) ? k : 'other');
      const cells = new Map<string, { count: number; scoreSum: number; scored: number; issues: number; elevated: number }>();
      for (const g of grouped) {
        const key = `${g._id.period}|${fold(label(g._id.group))}`;
        const c = cells.get(key) ?? { count: 0, scoreSum: 0, scored: 0, issues: 0, elevated: 0 };
        c.count += g.count;
        if (g.avgScore != null) { c.scoreSum += g.avgScore * g.count; c.scored += g.count; }
        c.issues += g.issues;
        c.elevated += g.elevated;
        cells.set(key, c);
      }
      const rows: ReportRow[] = [];
      for (const p of periods(q.interval, from, to)) for (const s of series) {
        const c = cells.get(`${p}|${s}`);
        rows.push({ period: p, group: s, count: c?.count ?? 0, avgScore: c && c.scored ? Math.round(c.scoreSum / c.scored) : null, issues: c?.issues ?? 0, elevatedRisk: c?.elevated ?? 0 });
      }
      return {
        columns: [{ key: 'period', label: 'Period', kind: 'text' }, { key: 'group', label: q.by[0]!.toUpperCase() + q.by.slice(1), kind: 'text' }, { key: 'count', label: 'Assessments', kind: 'number' }, { key: 'avgScore', label: 'Avg score', kind: 'number' }, { key: 'issues', label: 'Issue', kind: 'number' }, { key: 'elevatedRisk', label: 'Elevated risk', kind: 'number' }],
        rows,
        summary: { by: q.by, series: series.join('|'), total: grouped.reduce((n, g) => n + g.count, 0) },
      };
    });
  },
};
