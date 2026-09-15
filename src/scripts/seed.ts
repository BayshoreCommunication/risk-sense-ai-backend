/**
 * Idempotent development seed (DevelopmentGuide.md "Seeded test accounts").
 * Creates the shared requestor-only FREE tenant, a TAC PAID operator tenant, and one PAID customer demo.
 * firebaseUid is a placeholder (`dev:<email>`) until real Firebase accounts exist; with
 * AUTH_DEV_BYPASS=true the API accepts `X-Dev-User: <email>` for these users.
 */
import { connectDb, disconnectDb } from '../lib/db';
import { logger } from '../lib/logger';
import { DepartmentModel, PUBLIC_TENANT_SLUG, TenantModel } from '../modules/tenants/model';
import { UserModel, type Role } from '../modules/users/model';

async function upsertTenant(input: { name: string; slug: string; plan: 'free' | 'paid'; features?: Record<string, boolean>; sectors?: string[]; retentionPolicy?: Record<string, number> }) {
  return TenantModel.findOneAndUpdate(
    { slug: input.slug },
    { $set: { name: input.name, plan: input.plan, features: input.features ?? {}, sectors: input.sectors ?? [], ...(input.retentionPolicy ? { retentionPolicy: input.retentionPolicy } : {}) } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function upsertUser(input: { email: string; name: string; role: Role; tenantId: unknown; departmentIds?: unknown[]; mfaEnrolled?: boolean }) {
  return UserModel.findOneAndUpdate(
    { email: input.email },
    {
      $set: {
        name: input.name,
        role: input.role,
        tenantId: input.tenantId,
        departmentIds: input.departmentIds ?? [],
        mfaEnrolled: input.mfaEnrolled ?? false,
        status: 'active',
      },
      $setOnInsert: { firebaseUid: `dev:${input.email}` },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

export async function seed() {
  const publicTenant = await upsertTenant({ name: 'Public (FREE)', slug: PUBLIC_TENANT_SLUG, plan: 'free', sectors: ['financial', 'healthcare', 'it'] });
  const tac = await upsertTenant({
    name: 'TAC Solutions (PAID operator demo)',
    slug: 'tac',
    plan: 'paid',
    sectors: ['financial', 'healthcare', 'it'],
    features: { reviewDashboard: true, reports: true, fullAudit: true, blockConcurrentLogin: false },
    retentionPolicy: { assessmentDays: 365 * 7, auditDays: 365 * 7, evidenceDays: 365 * 7, datasetHistoryDays: 365 * 10 },
  });
  const acme = await upsertTenant({
    name: 'Acme Financial (PAID demo)',
    slug: 'acme',
    plan: 'paid',
    sectors: ['financial'],
    features: { sso: true, reviewDashboard: true, reports: true, fullAudit: true, departmentMapping: true, blockConcurrentLogin: false },
    retentionPolicy: { assessmentDays: 365 * 7, auditDays: 365 * 7, evidenceDays: 365 * 7, datasetHistoryDays: 365 * 10 }, // BusinessRules §12 #3 (PAID: 7 years)
  });

  const finance = await DepartmentModel.findOneAndUpdate(
    { tenantId: acme._id, name: 'Finance' },
    { $setOnInsert: { personaIds: [] } },
    { upsert: true, new: true },
  );
  const it = await DepartmentModel.findOneAndUpdate({ tenantId: acme._id, name: 'IT' }, { $setOnInsert: { personaIds: [] } }, { upsert: true, new: true });

  const users = [
    { email: 'requestor@dev.local', name: 'Dev Requestor', role: 'requestor' as Role, tenantId: publicTenant._id },
    { email: 'requestor@tac.local', name: 'TAC Demo Requestor', role: 'requestor' as Role, tenantId: tac._id },
    { email: 'admin@dev.local', name: 'Dev Administrator (TAC)', role: 'administrator' as Role, tenantId: tac._id, mfaEnrolled: true },
    { email: 'admin2@dev.local', name: 'Dev Administrator 2 (TAC reviewer)', role: 'administrator' as Role, tenantId: tac._id, mfaEnrolled: true },
    { email: 'sysadmin@dev.local', name: 'Dev System Administrator (Bayshore)', role: 'system_administrator' as Role, tenantId: tac._id, mfaEnrolled: true },
    { email: 'audit@dev.local', name: 'Dev Auditor', role: 'audit' as Role, tenantId: tac._id, mfaEnrolled: true },
    { email: 'requestor@paid.local', name: 'Acme Finance Requestor', role: 'requestor' as Role, tenantId: acme._id, departmentIds: [finance._id] },
    { email: 'itlead@paid.local', name: 'Acme IT Lead', role: 'requestor' as Role, tenantId: acme._id, departmentIds: [it._id] },
    { email: 'colleague@paid.local', name: 'Acme Finance Colleague', role: 'requestor' as Role, tenantId: acme._id, departmentIds: [finance._id] }, // escalation target (T-061)
    { email: 'admin@paid.local', name: 'Acme Administrator', role: 'administrator' as Role, tenantId: acme._id, mfaEnrolled: true }, // sees the PAID tenant's review queue (AI-03)
  ];
  for (const u of users) await upsertUser(u);

  return { tenants: 3, departments: 2, users: users.length };
}

if (require.main === module) {
  connectDb()
    .then(seed)
    .then((r) => {
      logger.info(r, 'seed complete');
      logger.info('Dev login: send header  X-Dev-User: requestor@dev.local  (AUTH_DEV_BYPASS=true)');
    })
    .catch((err) => {
      logger.error({ err }, 'seed failed');
      process.exitCode = 1;
    })
    .finally(disconnectDb);
}
