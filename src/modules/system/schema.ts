import { z } from 'zod';
import { TENANT_PLANS } from '../tenants/model';
import { ROLES } from '../users/model';
import { FIXED_DR_TARGETS } from './dr.model';

/** System administrator tenant settings (W10, FR-03, SEC-02, SEC-06). Every field optional: PATCH semantics. */
export const TenantPatch = z
  .object({
    name: z.string().min(2).max(120).optional(),
    plan: z.enum(TENANT_PLANS).optional(),
    features: z
      .object({
        sso: z.boolean().optional(),
        reviewDashboard: z.boolean().optional(),
        reports: z.boolean().optional(),
        fullAudit: z.boolean().optional(),
        departmentMapping: z.boolean().optional(),
        blockConcurrentLogin: z.boolean().optional(),
      })
      .optional(),
    sso: z
      .object({
        providerId: z.string().regex(/^(microsoft\.com|google\.com|apple\.com|github\.com|oidc\.[a-z0-9-]+|saml\.[a-z0-9-]+)$/i, 'Firebase provider id, e.g. microsoft.com, oidc.acme, saml.acme').nullable(),
        domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'email domain, e.g. acme.com').nullable(),
      })
      .optional(),
    // Compatibility input for older clients. The route normalizes it to the plan-derived value.
    authPolicy: z.object({ otpRequired: z.boolean() }).optional(),
    sessionPolicy: z.object({ idleTimeoutMin: z.number().int().min(5).max(30).optional(), maxConcurrentSessions: z.number().int().min(1).max(10).optional() }).optional(),
    retentionPolicy: z
      .object({
        assessmentDays: z.number().int().min(1).max(3650).optional(),
        auditDays: z.number().int().min(30).max(3650).optional(),
        evidenceDays: z.number().int().min(1).max(3650).optional(),
        datasetHistoryDays: z.number().int().min(30).max(3650).optional(),
      })
      .optional(),
  })
  .strict();
export type TenantPatch = z.infer<typeof TenantPatch>;

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i, 'must be a MongoDB ObjectId');

export const SystemUserCreate = z
  .object({
    email: z.string().email().max(254).transform((value) => value.toLowerCase()),
    name: z.string().min(2).max(120),
    role: z.enum(ROLES),
    departmentIds: z.array(ObjectIdString).max(50).default([]),
    crossDepartmentAccess: z.boolean().default(false),
  })
  .strict();
export type SystemUserCreate = z.infer<typeof SystemUserCreate>;

export const SystemUserPatch = z
  .object({
    name: z.string().min(2).max(120).optional(),
    role: z.enum(ROLES).optional(),
    departmentIds: z.array(ObjectIdString).max(50).optional(),
    crossDepartmentAccess: z.boolean().optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');
export type SystemUserPatch = z.infer<typeof SystemUserPatch>;

export const SystemDepartmentCreate = z
  .object({ name: z.string().min(2).max(120), personaIds: z.array(ObjectIdString).max(100).default([]) })
  .strict();
export type SystemDepartmentCreate = z.infer<typeof SystemDepartmentCreate>;

export const SystemDepartmentPatch = SystemDepartmentCreate.partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');
export type SystemDepartmentPatch = z.infer<typeof SystemDepartmentPatch>;

export const SystemIdParams = z.object({ id: ObjectIdString });

const DrTargetsPatch = z
  .object({
    rpoHours: z.number().finite().positive().max(FIXED_DR_TARGETS.rpoHours).optional(),
    rtoHours: z.number().finite().positive().max(FIXED_DR_TARGETS.rtoHours).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one recovery target is required');

export const DrStatusPatch = z
  .object({
    provider: z.string().min(2).max(120).optional(),
    backupsEnabled: z.boolean().optional(),
    lastBackupAt: z.coerce.date().optional(),
    lastRestoreDrillAt: z.coerce.date().optional(),
    lastRestoreDrillOutcome: z.enum(['passed', 'failed']).optional(),
    evidenceRef: z.string().url().max(2_000).nullable().optional(),
    targets: DrTargetsPatch.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'at least one field is required');
export type DrStatusPatch = z.infer<typeof DrStatusPatch>;

export const ConformanceFlagsQuery = z.object({
  includeResolved: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
