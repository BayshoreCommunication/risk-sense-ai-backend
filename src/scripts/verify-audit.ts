/** npm run audit:verify [tenantSlug]  — walks the audit hash chain for one tenant (default: public). */
import { connectDb, disconnectDb } from '../lib/db';
import { audit } from '../modules/audit/service';
import { PUBLIC_TENANT_SLUG, TenantModel } from '../modules/tenants/model';

async function main() {
  await connectDb();
  const slug = process.argv[2] ?? PUBLIC_TENANT_SLUG;
  const tenant = await TenantModel.findOne({ slug });
  if (!tenant) throw new Error(`tenant ${slug} not found`);
  const result = await audit.verify(String(tenant._id));
  console.log(JSON.stringify({ tenant: slug, ...result }));
  if (!result.ok) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(disconnectDb);
