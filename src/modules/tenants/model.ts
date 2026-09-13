import { Schema, model, type InferSchemaType } from 'mongoose';

export const TENANT_PLANS = ['free', 'paid'] as const;
export type TenantPlan = (typeof TENANT_PLANS)[number];

export const SECTORS = ['financial', 'healthcare', 'it'] as const;
export type Sector = (typeof SECTORS)[number];

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
    sectors: { type: [String], enum: SECTORS, default: [] },
    // FR-01: second factor (email OTP) on every Firebase login; privileged roles ignore this and always need it (SEC-03).
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
