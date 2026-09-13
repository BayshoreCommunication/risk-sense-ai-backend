import request from 'supertest';
import { createApp } from '../app';
import { seed } from '../scripts/seed';
import { TenantModel } from '../modules/tenants/model';

export const app = createApp();

export async function seeded() {
  await seed();
  const publicTenant = (await TenantModel.findOne({ slug: 'public' }))!;
  const acme = (await TenantModel.findOne({ slug: 'acme' }))!;
  return { publicTenant, acme };
}

/** Log in via the dev bypass and return headers for subsequent calls. */
export async function login(email: string) {
  const res = await request(app).post('/api/v1/auth/session').set('X-Dev-User', email);
  if (res.status !== 201) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { 'X-Dev-User': email, 'X-Session-Id': res.body.data.sessionId as string };
}
