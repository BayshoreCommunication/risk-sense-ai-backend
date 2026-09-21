import { Schema, model, type InferSchemaType } from 'mongoose';

export const TENANT_PLANS = ['free', 'paid'] as const;
export type TenantPlan = (typeof TENANT_PLANS)[number];

export const DEFAULT_SECTORS = ['financial', 'healthcare', 'it', 'general'] as const;
export type Sector = string;

const featuresSchema = new Schema(
  {
    sso: { type: Boolean, default: false }, // FR-03
    reviewDashboard: { type: Boolean, default: false }, // FR-21, DASH-01
    reports: { type: Boolean, default: false }, // FR-26..28, DASH-03
    fullAudit: { type: Boolean, default: false }, // FR-25, FR-26
    departmentMapping: { type: Boolean, default: false }, // FR-10
    blockConcurrentLogin: { type: Boolean, default: false }, // FR-04
  },
  { _id: false },
);

export type TenantFeatures = InferSchemaType<typeof featuresSchema>;

const tenantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    plan: { type: String, enum: TENANT_PLANS, required: true, default: 'free' },
    features: { type: featuresSchema, default: () => ({}) },
    // Runtime vocabulary, maintained by a system administrator. Content services enforce membership.
    sectors: { type: [String], default: () => [...DEFAULT_SECTORS] },
    // Internal serialization row for sector-referencing content writes versus vocabulary removal.
    // It is deliberately not exposed through tenant APIs and does not change tenant.updatedAt.
    sectorGuardRevision: { type: Number, default: 0, select: false },
    // Legacy configuration surface retained for compatibility. The plan is authoritative:
    // FREE requestors never require MFA and every PAID account requires it (FR-02, SEC-03).
    authPolicy: {
      otpRequired: { type: Boolean, default: true },
    },
    // SEC-02 defaults; administrator-configurable 5–30 min.
    sessionPolicy: {
      idleTimeoutMin: { type: Number, default: 15, min: 5, max: 30 },
      maxConcurrentSessions: { type: Number, default: 1, min: 1, max: 10 },
    },
    // Section 5 / SEC-06 — working defaults until Bayshore confirms (BusinessRules §12).
    retentionPolicy: {
      assessmentDays: { type: Number, default: 90 },
      auditDays: { type: Number, default: 365 * 7 },
      evidenceDays: { type: Number, default: 90 },
      datasetHistoryDays: { type: Number, default: 365 * 10 },
    },
    sso: {
      providerId: { type: String },
      domain: { type: String },
    },
    // Internal marker for an isolated synthetic public-demo tenant. Normal tenant settings cannot
    // read or mutate it; the guarded demo provisioner is the owner of this bit.
    publicDemo: { type: Boolean, default: false, select: false },
  },
  { timestamps: true, collection: 'tenants' },
);

export type Tenant = InferSchemaType<typeof tenantSchema>;
export const TenantModel = model('Tenant', tenantSchema);

/** The shared FREE tenant every self-signup user belongs to. */
export const PUBLIC_TENANT_SLUG = 'public';

const departmentSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name: { type: String, required: true, trim: true },
    personaIds: { type: [Schema.Types.ObjectId], ref: 'Persona', default: [] }, // FR-10
  },
  { timestamps: true, collection: 'departments' },
);
departmentSchema.index({ tenantId: 1, name: 1 }, { unique: true });

export type Department = InferSchemaType<typeof departmentSchema>;
export const DepartmentModel = model('Department', departmentSchema);
