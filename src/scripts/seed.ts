/**
 * Idempotent development seed (DevelopmentGuide.md "Seeded test accounts").
 * Creates the shared FREE tenant, one PAID tenant with all features, departments and five users.
 * firebaseUid is a placeholder (`dev:<email>`) until real Firebase accounts exist; with
 * AUTH_DEV_BYPASS=true the API accepts `X-Dev-User: <email>` for these users.
 */
import { connectDb, disconnectDb } from '../lib/db';
import { logger } from '../lib/logger';
import { DepartmentModel, PUBLIC_TENANT_SLUG, TenantModel } from '../modules/tenants/model';
import { UserModel, type Role } from '../modules/users/model';

async function upsertTenant(input: { name: string; slug: string; plan: 'free' | 'paid'; features?: Record<string, boolean>; sectors?: string[] }) {
  return TenantModel.findOneAndUpdate(
    { slug: input.slug },
    { $set: { name: input.name, plan: input.plan, features: input.features ?? {}, sectors: input.sectors ?? [] } },
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
  const acme = await upsertTenant({
    name: 'Acme Financial (PAID demo)',
    slug: 'acme',
    plan: 'paid',
    sectors: ['financial'],
    features: { sso: true, reviewDashboard: true, reports: true, fullAudit: true, departmentMapping: true, blockConcurrentLogin: false },
  });

  const finance = await DepartmentModel.findOneAndUpdate(
    { tenantId: acme._id, name: 'Finance' },
    { $setOnInsert: { personaIds: [] } },
    { upsert: true, new: true },
  );
  const it = await DepartmentModel.findOneAndUpdate({ tenantId: acme._id, name: 'IT' }, { $setOnInsert: { personaIds: [] } }, { upsert: true, new: true });

  const users = [
    { email: 'requestor@dev.local', name: 'Dev Requestor', role: 'requestor' as Role, tenantId: publicTenant._id },
    { email: 'admin@dev.local', name: 'Dev Administrator (TAC)', role: 'administrator' as Role, tenantId: publicTenant._id, mfaEnrolled: true },
    { email: 'sysadmin@dev.local', name: 'Dev System Administrator (Bayshore)', role: 'system_administrator' as Role, tenantId: publicTenant._id, mfaEnrolled: true },
    { email: 'audit@dev.local', name: 'Dev Auditor', role: 'audit' as Role, tenantId: publicTenant._id },
    { email: 'requestor@paid.local', name: 'Acme Finance Requestor', role: 'requestor' as Role, tenantId: acme._id, departmentIds: [finance._id] },
    { email: 'itlead@paid.local', name: 'Acme IT Lead', role: 'requestor' as Role, tenantId: acme._id, departmentIds: [it._id] },
  ];
  for (const u of users) await upsertUser(u);

  return { tenants: 2, departments: 2, users: users.length };
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
