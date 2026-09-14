import { Router } from 'express';
import type { HydratedDocument } from 'mongoose';
import { AppError } from '../../lib/errors';
import { ok } from '../../lib/http';
import { authenticate } from '../../middleware/auth';
import { requireRole } from '../../middleware/rbac';
import { requireSession } from '../../middleware/session';
import { validate } from '../../middleware/validate';
import { audit } from '../audit/service';
import { TenantModel, type Tenant } from '../tenants/model';
import { TenantPatch } from './schema';

/** System administrator (Bayshore) — tenant configuration. All changes are audited as config changes (FR-25). */
export const systemRouter = Router();
systemRouter.use(authenticate, requireSession, requireRole('system_administrator'));

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
