/**
 * npm run seed:content [path/to/content.json]
 * Loads a content file (template column names) into the tenant through the real dataset flow:
 * upload (validate) → approve by a second administrator (AI-06) → activate (versions + audit).
 * Default file: templates/starter-content.json (built from the BRD question sets; replaced by TAC's data later).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectDb, disconnectDb } from '../lib/db';
import { logger } from '../lib/logger';
import type { AuthUser } from '../middleware/auth';
import { datasetsService } from '../modules/datasets/service';
import { PUBLIC_TENANT_SLUG, TenantModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';

async function actor(email: string): Promise<AuthUser> {
  const u = await UserModel.findOne({ email }).lean();
  if (!u) throw new Error(`user ${email} missing — run npm run seed first`);
  return {
    id: String(u._id),
    firebaseUid: u.firebaseUid,
    email: u.email,
    name: u.name,
    role: u.role,
    tenantId: String(u.tenantId),
    departmentIds: [],
    crossDepartmentAccess: false,
    mfaEnrolled: true,
  };
}

async function main() {
  const file = process.argv[2] ?? join(process.cwd(), 'templates', 'starter-content.json');
  const content = JSON.parse(readFileSync(file, 'utf8'));
  await connectDb();
  const [publicTenant, tacTenant] = await Promise.all([
    TenantModel.findOne({ slug: PUBLIC_TENANT_SLUG }).lean(),
    TenantModel.findOne({ slug: 'tac' }).lean(),
  ]);
  if (!publicTenant || !tacTenant) throw new Error('public/TAC tenant missing — run npm run seed first');
  const author = await actor('admin@dev.local');
  const reviewer = await actor('admin2@dev.local');

  // The PAID TAC operators curate both the shared FREE library and their own demo tenant. This
  // keeps FREE accounts requestor-only while preserving useful requestor and administrator demos.
  for (const tenant of [publicTenant, tacTenant]) {
    const tenantId = String(tenant._id);
    const uploaded = await datasetsService.upload(tenantId, { fileName: file.split('/').pop() ?? 'content.json', json: content }, author);
    if (uploaded.status !== 'validated') {
      logger.error({ tenant: tenant.slug, errors: uploaded.validationErrors }, `dataset rejected with ${uploaded.validationErrors.length} errors`);
      process.exitCode = 2;
      return;
    }
    await datasetsService.approve(tenantId, String(uploaded._id), reviewer);
    const active = await datasetsService.activate(tenantId, String(uploaded._id), author);
    logger.info({ tenant: tenant.slug, seq: active.seq, counts: active.counts, applied: active.applied }, 'content dataset activated');
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'seed:content failed');
    process.exitCode = 1;
  })
  .finally(disconnectDb);
