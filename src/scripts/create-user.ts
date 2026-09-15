/**
 * npm run user:create -- --email ops@acme.com --name "Ops Lead" --role administrator --tenant acme [--department Finance] [--cross]
 * W10 provisioning until the system-administrator users screen exists: creates (or updates) one account with exactly
 * one role (FR-02). The person then signs in with Firebase using the same email (password/Google/SSO); the backend links
 * the pre-provisioned account instead of self-signing them up as a FREE requestor. Administrators and system
 * administrators always complete the email OTP (SEC-03). Every run is audited as config/user.provisioned.
 */
import mongoose from 'mongoose';
import { connectDb } from '../lib/db';
import { audit } from '../modules/audit/service';
import { DepartmentModel, TenantModel } from '../modules/tenants/model';
import { ROLES, UserModel, type Role } from '../modules/users/model';
import { assertRoleAllowedForPlan } from '../modules/users/plan-policy';

const argv = process.argv.slice(2);
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

async function main() {
  const email = arg('--email')?.toLowerCase();
  const name = arg('--name');
  const role = arg('--role') as Role | undefined;
  const slug = arg('--tenant') ?? 'public';
  const department = arg('--department');
  const cross = argv.includes('--cross');
  if (!email || !name || !role) throw new Error('usage: --email <email> --name <name> --role <requestor|administrator|system_administrator|audit> [--tenant slug] [--department name] [--cross]');
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  await connectDb();
  const tenant = await TenantModel.findOne({ slug });
  if (!tenant) throw new Error(`tenant "${slug}" not found (run npm run seed)`);
  assertRoleAllowedForPlan(tenant.plan, role);
  const dept = department ? await DepartmentModel.findOne({ tenantId: tenant._id, name: department }) : null;
  if (department && !dept) throw new Error(`department "${department}" not found in ${slug}`);
  const existing = await UserModel.findOne({ email });
  const user = await UserModel.findOneAndUpdate(
    { email },
    { $set: { name, role, tenantId: tenant._id, departmentIds: dept ? [dept._id] : [], crossDepartmentAccess: cross, status: 'active' }, $setOnInsert: { firebaseUid: `dev:${email}`, mfaEnrolled: false } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  await audit.write({ tenantId: String(tenant._id), category: 'config', action: existing ? 'user.updated' : 'user.provisioned', actor: null, entity: { type: 'user', id: String(user._id) }, payload: { email, role, tenant: slug, department: dept?.name ?? null, crossDepartmentAccess: cross, via: 'scripts/create-user' } });
  console.log(JSON.stringify({ created: !existing, id: String(user._id), email, role, tenant: slug, department: dept?.name ?? null, next: `sign in at /login with ${email} via Firebase (password, Google or company SSO); the account links on first login` }));
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
