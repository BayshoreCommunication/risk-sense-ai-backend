import { Router } from 'express';
import { Types, type HydratedDocument } from 'mongoose';
import { withMongoTransaction } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { audit } from '../audit/service';
import { conformanceService } from '../conformance/service';
import { TenantModel, type Tenant } from '../tenants/model';
import { ConformanceFlagsQuery, DrStatusPatch, SystemDepartmentCreate, SystemDepartmentPatch, SystemIdParams, SystemUserCreate, SystemUserPatch, TenantPatch } from './schema';
import { directoryService } from './directory.service';
import { DrStatusModel, FIXED_DR_TARGETS } from './dr.model';

/** System administrator (Bayshore) — tenant configuration. All changes are audited as config changes (FR-25). */
export const systemRouter = Router();
systemRouter.use(authenticate, requireSession, requireRole('system_administrator'));

systemRouter.get('/users', async (req, res) => {
  ok(res, await directoryService.users(req.user!.tenantId));
});

systemRouter.post('/users', validate({ body: SystemUserCreate }), async (req, res) => {
  ok(res, await directoryService.createUser(req.user!.tenantId, req.body as SystemUserCreate, req.user!), 201);
});

systemRouter.patch('/users/:id', validate({ params: SystemIdParams, body: SystemUserPatch }), async (req, res) => {
  ok(res, await directoryService.updateUser(req.user!.tenantId, String(req.params.id), req.body as SystemUserPatch, req.user!));
});

systemRouter.get('/departments', async (req, res) => {
  ok(res, await directoryService.departments(req.user!.tenantId));
});

systemRouter.get('/personas', async (req, res) => {
  ok(res, await directoryService.personas(req.user!.tenantId));
});

systemRouter.post('/departments', validate({ body: SystemDepartmentCreate }), async (req, res) => {
  ok(res, await directoryService.createDepartment(req.user!.tenantId, req.body as SystemDepartmentCreate, req.user!), 201);
});

systemRouter.patch('/departments/:id', validate({ params: SystemIdParams, body: SystemDepartmentPatch }), async (req, res) => {
  ok(res, await directoryService.updateDepartment(req.user!.tenantId, String(req.params.id), req.body as SystemDepartmentPatch, req.user!));
});

const drView = (status: InstanceType<typeof DrStatusModel> | null, plan: Tenant['plan']) => {
  const targets = {
    ...FIXED_DR_TARGETS,
    ...(plan === 'paid'
      ? {
          rpoHours: status?.targets?.rpoHours ?? FIXED_DR_TARGETS.rpoHours,
          rtoHours: status?.targets?.rtoHours ?? FIXED_DR_TARGETS.rtoHours,
        }
      : {}),
  };
  const backupFresh = Boolean(status?.backupsEnabled && status.lastBackupAt && status.lastBackupAt.getTime() >= Date.now() - targets.backupFrequencyHours * 60 * 60 * 1_000);
  const drillCurrent = Boolean(status?.lastRestoreDrillOutcome === 'passed' && status.lastRestoreDrillAt && status.lastRestoreDrillAt.getTime() >= Date.now() - targets.drillFrequencyDays * 24 * 60 * 60 * 1_000);
  return {
    provider: status?.provider ?? null,
    backupsEnabled: status?.backupsEnabled ?? false,
    lastBackupAt: status?.lastBackupAt ?? null,
    lastRestoreDrillAt: status?.lastRestoreDrillAt ?? null,
    lastRestoreDrillOutcome: status?.lastRestoreDrillOutcome ?? null,
    evidenceRef: status?.evidenceRef ?? null,
    targets,
    targetsConfigurable: plan === 'paid',
    checks: { backupFresh, drillCurrent, externalEvidenceRecorded: Boolean(status?.evidenceRef) },
    readiness: backupFresh && drillCurrent && status?.evidenceRef ? 'ready' : 'attention_required',
    updatedAt: (status as unknown as { updatedAt?: Date } | null)?.updatedAt ?? null,
  };
};

/** GET/PATCH /system/dr/status — records external backup/PITR evidence; it never fabricates provider state. */
systemRouter.get('/dr/status', async (req, res) => {
  const [status, tenant] = await Promise.all([DrStatusModel.findOne({ tenantId: req.user!.tenantId }), TenantModel.findById(req.user!.tenantId).select('plan')]);
  if (!tenant) throw new AppError('NOT_FOUND', 'tenant');
  ok(res, drView(status, tenant.plan));
});

systemRouter.patch('/dr/status', validate({ body: DrStatusPatch }), async (req, res) => {
  const body = req.body as DrStatusPatch;
  const after = await withMongoTransaction(async () => {
    const tenant = await TenantModel.findById(req.user!.tenantId).select('plan');
    if (!tenant) throw new AppError('NOT_FOUND', 'tenant');
    if (body.targets && tenant.plan !== 'paid') throw new AppError('FEATURE_DISABLED', 'Custom recovery targets require a PAID tenant');
    const status = (await DrStatusModel.findOne({ tenantId: req.user!.tenantId })) ?? new DrStatusModel({ tenantId: req.user!.tenantId });
    const before = drView(status.isNew ? null : status, tenant.plan);
    const evidenceChanged = Object.keys(body).some((key) => key !== 'targets');
    for (const [key, value] of Object.entries(body)) if (key !== 'targets') status.set(key, value ?? undefined);
    if (body.targets) {
      if (body.targets.rpoHours !== undefined) status.set('targets.rpoHours', body.targets.rpoHours);
      if (body.targets.rtoHours !== undefined) status.set('targets.rtoHours', body.targets.rtoHours);
    }
    if (evidenceChanged) status.recordedBy = new Types.ObjectId(req.user!.id);
    // `updatedAt` is the evidence-register timestamp exposed by drView. A policy-only target edit
    // has its own audit actor/time and must not rewrite the prior evidence recorder or timestamp.
    await status.save({ timestamps: evidenceChanged });
    const view = drView(status, tenant.plan);
    await audit.write({ tenantId: req.user!.tenantId, category: 'config', action: 'dr.status_recorded', actor: req.user!, entity: { type: 'dr_status', id: String(status._id) }, payload: { before, after: view, changed: Object.keys(body) } });
    return view;
  });
  ok(res, after);
});

systemRouter.post('/conformance/run', async (req, res) => {
  const [result] = await conformanceService.scan({ tenantId: req.user!.tenantId, trigger: 'manual', actor: req.user! });
  ok(res, result);
});

systemRouter.get('/conformance/runs', async (req, res) => {
  ok(res, await conformanceService.runs(req.user!.tenantId));
});

systemRouter.get('/conformance/flags', validate({ query: ConformanceFlagsQuery }), async (req, res) => {
  const { includeResolved } = req.query as unknown as { includeResolved: boolean };
  ok(res, await conformanceService.flags(req.user!.tenantId, includeResolved));
});

const view = (t: HydratedDocument<Tenant>) => ({
  _id: String(t._id),
  name: t.name,
  slug: t.slug,
  plan: t.plan,
  features: t.features,
  sso: { providerId: t.sso?.providerId ?? null, domain: t.sso?.domain ?? null },
  authPolicy: { otpRequired: t.authPolicy?.otpRequired ?? true },
  sessionPolicy: { idleTimeoutMin: t.sessionPolicy?.idleTimeoutMin ?? 15, maxConcurrentSessions: t.sessionPolicy?.maxConcurrentSessions ?? 1 },
  retentionPolicy: t.retentionPolicy,
  updatedAt: (t as unknown as { updatedAt?: Date }).updatedAt,
});

/** GET /system/tenant — the caller's tenant settings. */
systemRouter.get('/tenant', async (req, res) => {
  const t = await TenantModel.findById(req.user!.tenantId);
  if (!t) throw new AppError('NOT_FOUND', 'tenant');
  ok(res, view(t));
});

/**
 * PATCH /system/tenant — SSO (FR-03), auth/session policy (SEC-02), retention policy (SEC-06), plan/features.
 * Enabling SSO requires both provider id and domain; the email domain must be unique across tenants.
 */
systemRouter.patch('/tenant', validate({ body: TenantPatch }), async (req, res) => {
  const body = req.body as TenantPatch;
  const t = await TenantModel.findById(req.user!.tenantId);
  if (!t) throw new AppError('NOT_FOUND', 'tenant');
  const before = view(t);
  if (body.name) t.name = body.name;
  if (body.plan) t.plan = body.plan;
  if (body.features) Object.assign(t.features, body.features);
  if (body.sso) {
    if (body.sso.domain) {
      const clash = await TenantModel.findOne({ _id: { $ne: t._id }, 'sso.domain': body.sso.domain.toLowerCase() }).lean();
      if (clash) throw new AppError('CONFLICT', `domain ${body.sso.domain} is already claimed by another tenant`);
    }
    t.set('sso', { providerId: body.sso.providerId ?? undefined, domain: body.sso.domain?.toLowerCase() ?? undefined });
  }
  if (body.authPolicy) t.set('authPolicy.otpRequired', body.authPolicy.otpRequired);
  if (body.sessionPolicy) for (const [k, v] of Object.entries(body.sessionPolicy)) if (v !== undefined) t.set(`sessionPolicy.${k}`, v);
  if (body.retentionPolicy) for (const [k, v] of Object.entries(body.retentionPolicy)) if (v !== undefined) t.set(`retentionPolicy.${k}`, v);
  const wantsSso = (body.features?.sso ?? t.features.sso) === true;
  if (wantsSso && !(t.sso?.providerId && t.sso?.domain)) throw new AppError('VALIDATION_ERROR', 'enabling SSO needs sso.providerId and sso.domain');
  await t.save();
  const after = view(t);
  await audit.write({ tenantId: req.user!.tenantId, category: 'config', action: 'tenant.updated', actor: req.user!, entity: { type: 'tenant', id: String(t._id) }, payload: { before, after, changed: Object.keys(body) } });
  ok(res, after);
});
