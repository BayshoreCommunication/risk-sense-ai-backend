/** npm run content:verify -- [--tenant public] [--golden path/to/cases.json] */
import { join } from 'node:path';
import mongoose from 'mongoose';
import { connectDb, disconnectDb } from '../lib/db';
import { contentVerificationService, loadGoldenCases } from '../modules/datasets/content-verify';
import { PUBLIC_TENANT_SLUG, TenantModel } from '../modules/tenants/model';

const argv = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
};

async function main() {
  // This is a read-only release gate; model registration must not create indexes as a side effect.
  mongoose.set('autoIndex', false);
  await connectDb();
  const tenantSlug = value('--tenant', PUBLIC_TENANT_SLUG);
  const tenant = await TenantModel.findOne({ slug: tenantSlug }).select('_id slug').lean();
  if (!tenant) throw new Error(`tenant "${tenantSlug}" not found`);
  const goldenPath = value('--golden', join(process.cwd(), 'src', 'modules', 'scoring', 'golden', 'starter.json'));
  const report = await contentVerificationService.verifyTenant({
    tenantId: String(tenant._id),
    tenantSlug: tenant.slug,
    goldenCases: loadGoldenCases(goldenPath),
  });
  console.log(JSON.stringify({ ...report, goldenPath }, null, 2));
  if (!report.ok) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(disconnectDb);
