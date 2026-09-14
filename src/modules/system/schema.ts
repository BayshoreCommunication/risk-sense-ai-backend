import { z } from 'zod';
import { TENANT_PLANS } from '../tenants/model';

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
