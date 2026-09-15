import request from 'supertest';
import { createApp } from '../app';
import type { AuthUser } from '../middleware/auth';
import { datasetsService } from '../modules/datasets/service';
import { seed } from '../scripts/seed';
import { TenantModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';

export const app = createApp();

export async function seeded() {
  await seed();
  const publicTenant = (await TenantModel.findOne({ slug: 'public' }))!;
  const tac = (await TenantModel.findOne({ slug: 'tac' }))!;
  const acme = (await TenantModel.findOne({ slug: 'acme' }))!;
  return { publicTenant, tac, acme };
}

/** Log in via the dev bypass and return headers for subsequent calls. */
export async function login(email: string) {
  const res = await request(app).post('/api/v1/auth/session').set('X-Dev-User', email);
  if (res.status !== 201) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { 'X-Dev-User': email, 'X-Session-Id': res.body.data.sessionId as string };
}

/** Trusted test/operator path for publishing reviewed starter content into the shared namespace. */
export async function publishReviewedContent(tenantId: string, content: unknown) {
  const actor = async (email: string): Promise<AuthUser> => {
    const user = (await UserModel.findOne({ email }).lean())!;
    return {
      id: String(user._id),
      firebaseUid: user.firebaseUid,
      email: user.email,
      name: user.name,
      role: user.role,
      tenantId: String(user.tenantId),
      departmentIds: user.departmentIds.map(String),
      crossDepartmentAccess: user.crossDepartmentAccess,
      mfaEnrolled: user.mfaEnrolled,
    };
  };
  const [author, reviewer] = await Promise.all([actor('admin@dev.local'), actor('admin2@dev.local')]);
  const dataset = await datasetsService.upload(tenantId, { fileName: 'starter-shared.json', json: content }, author);
  await datasetsService.approve(tenantId, String(dataset._id), reviewer);
  return datasetsService.activate(tenantId, String(dataset._id), author);
}
