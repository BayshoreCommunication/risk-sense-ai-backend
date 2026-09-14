import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../tests/helpers';

/** SEC-04 / API.md rate limits — enabled in tests only with RATE_LIMIT_TEST=1 (limits.ts). */
describe('rate limits and security headers [SEC-04, NFR-03]', () => {
  beforeAll(() => { process.env.RATE_LIMIT_TEST = '1'; });
  afterAll(() => { delete process.env.RATE_LIMIT_TEST; });
  beforeEach(async () => { await seeded(); });

  it('throttles session creation per IP after 10 attempts with a RATE_LIMITED envelope', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'requestor@dev.local').set('X-Forwarded-For', '203.0.113.7')).status;
    expect(last).toBe(429);
    const res = await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'requestor@dev.local').set('X-Forwarded-For', '203.0.113.7');
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.headers['ratelimit']).toBeDefined(); // draft-7 standard header
    // another client is unaffected
    expect((await request(app).post('/api/v1/auth/session').set('X-Dev-User', 'requestor@dev.local').set('X-Forwarded-For', '203.0.113.8')).status).toBe(201);
  });

  it('throttles report requests per user after 10 per minute', async () => {
    const h = await login('admin@paid.local');
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await request(app).get('/api/v1/reports/volume').set(h)).status;
    expect(last).toBe(429);
    const other = await login('requestor@paid.local');
    expect((await request(app).get('/api/v1/reports/volume').set(other)).status).toBe(200);
  });

  it('sets hardened headers and honours the CORS allowlist only', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['strict-transport-security']).toContain('max-age=63072000');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
    const allowed = await request(app).options('/api/v1/health').set('Origin', 'http://localhost:3000').set('Access-Control-Request-Method', 'GET');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const denied = await request(app).options('/api/v1/health').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('readiness pings the database; liveness needs nothing [NFR-05]', async () => {
    const ready = await request(app).get('/api/v1/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data).toMatchObject({ status: 'ok', db: 'connected' });
    expect(ready.body.data.dbPingMs).toBeGreaterThanOrEqual(0);
    const live = await request(app).get('/api/v1/health/live');
    expect(live.body.data.status).toBe('ok');
  });
});
