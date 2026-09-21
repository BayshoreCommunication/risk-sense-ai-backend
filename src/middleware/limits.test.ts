import express from 'express';
import rateLimit, { type Options } from 'express-rate-limit';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../tests/helpers';
import { RateLimitCounterModel } from '../modules/rate-limits/model';
import { createMongoRateLimitStore } from '../modules/rate-limits/store';
import { globalRateLimitKey } from '../app';
import { env } from '../config/env';
import { PersonaModel } from '../modules/personas/model';
import { TenantModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';
import {
  PUBLIC_DEMO_AI_LIMIT,
  PUBLIC_DEMO_AI_WINDOW_MS,
  publicDemoAiBudgetKey,
} from './limits';

/** SEC-04 / API.md rate limits — enabled in tests only with RATE_LIMIT_TEST=1 (limits.ts). */
describe('rate limits and security headers [SEC-04, NFR-03]', () => {
  beforeAll(() => { process.env.RATE_LIMIT_TEST = '1'; });
  afterAll(() => { delete process.env.RATE_LIMIT_TEST; });
  beforeEach(async () => { await seeded(); });

  it('does not trust a rotating session header before authentication [SEC-04]', async () => {
    const instance = express();
    instance.use(
      rateLimit({
        windowMs: 60_000,
        limit: 2,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator: globalRateLimitKey,
        store: createMongoRateLimitStore('test-global-untrusted-header'),
      }),
    );
    instance.get('/limited', (_req, res) => res.json({ ok: true }));

    expect((await request(instance).get('/limited').set('X-Session-Id', 'attacker-bucket-1')).status).toBe(200);
    expect((await request(instance).get('/limited').set('X-Session-Id', 'attacker-bucket-2')).status).toBe(200);
    expect((await request(instance).get('/limited').set('X-Session-Id', 'attacker-bucket-3')).status).toBe(429);
  });

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

  it('applies the same 10/min/IP throttle to public-demo session creation [SEC-04]', async () => {
    const tenant = (await TenantModel.findOneAndUpdate(
      { slug: 'tac' },
      { $set: { publicDemo: true } },
      { new: true },
    ).select('+publicDemo'))!;
    env.PUBLIC_DEMO_TENANT_ID = String(tenant._id);
    await UserModel.updateOne({ email: 'audit@dev.local', tenantId: tenant._id }, { $set: { publicDemo: true } });

    for (let i = 0; i < 10; i++) {
      expect((await request(app)
        .post('/api/v1/auth/public-demo/session')
        .set('X-Forwarded-For', '203.0.113.17')
        .send({ role: 'audit' })).status).toBe(201);
    }
    const limited = await request(app)
      .post('/api/v1/auth/public-demo/session')
      .set('X-Forwarded-For', '203.0.113.17')
      .send({ role: 'audit' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('shares one bounded AI/start budget across public-demo requestor sessions without limiting standard sessions [SEC-04]', async () => {
    const { publicTenant } = await seeded();
    const tenant = (await TenantModel.findOneAndUpdate(
      { slug: 'tac' },
      { $set: { publicDemo: true } },
      { new: true },
    ).select('+publicDemo'))!;
    env.PUBLIC_DEMO_TENANT_ID = String(tenant._id);
    const demoUser = (await UserModel.findOneAndUpdate(
      { email: 'requestor@tac.local', tenantId: tenant._id },
      { $set: { publicDemo: true } },
      { new: true },
    ).select('+publicDemo'))!;

    for (const [tenantId, key, name] of [
      [tenant._id, 'demo_quota_persona', 'Demo Quota Persona'],
      [publicTenant._id, 'standard_quota_persona', 'Standard Quota Persona'],
    ] as const) {
      await PersonaModel.create({
        tenantId,
        key,
        name,
        sector: 'financial',
        description: 'Active persona used to verify rate-limit scope without invoking the model.',
        versionGroupId: tenantId,
        version: 1,
        status: 'active',
        isCurrent: true,
      });
    }

    const first = await request(app).post('/api/v1/auth/public-demo/session').send({ role: 'requestor' });
    const second = await request(app).post('/api/v1/auth/public-demo/session').send({ role: 'requestor' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const store = createMongoRateLimitStore('public-demo-ai');
    store.init({ windowMs: PUBLIC_DEMO_AI_WINDOW_MS } as Options);
    const budgetKey = publicDemoAiBudgetKey(String(tenant._id), String(demoUser._id));
    for (let hit = 1; hit < PUBLIC_DEMO_AI_LIMIT; hit++) await store.increment(budgetKey);

    const allowed = await request(app)
      .post('/api/v1/assessments')
      .set('X-Session-Id', first.body.data.sessionId as string)
      .send({ personaKey: 'demo_quota_persona' });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);

    const limited = await request(app)
      .post('/api/v1/assessments')
      .set('X-Session-Id', second.body.data.sessionId as string)
      .send({ personaKey: 'demo_quota_persona' });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');

    const standard = await login('requestor@dev.local');
    const standardStart = await request(app)
      .post('/api/v1/assessments')
      .set(standard)
      .send({ personaKey: 'standard_quota_persona' });
    expect(standardStart.status, JSON.stringify(standardStart.body)).toBe(201);
  });

  it('throttles report requests per user after 60 per minute, leaving room for one dashboard load', async () => {
    const h = await login('admin@paid.local');
    // The analytics page issues five report calls plus trends on every load; a tighter budget tripped on the
    // second visit within a minute.
    for (let i = 0; i < 6; i++) expect((await request(app).get('/api/v1/reports/volume').set(h)).status).toBe(200);
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await request(app).get('/api/v1/reports/volume').set(h)).status;
    expect(last).toBe(429);
    const other = await login('requestor@paid.local');
    expect((await request(app).get('/api/v1/reports/volume').set(other)).status).toBe(200);
  });

  it('shares one atomic request budget across independent app and store instances [SEC-04, NFR-03]', async () => {
    const makeApp = () => {
      const instance = express();
      instance.use(
        rateLimit({
          windowMs: 60_000,
          limit: 2,
          standardHeaders: 'draft-7',
          legacyHeaders: false,
          keyGenerator: () => 'shared-caller',
          store: createMongoRateLimitStore('test-cross-app'),
          message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
        }),
      );
      instance.get('/limited', (_req, res) => res.json({ ok: true }));
      return instance;
    };

    // These are separate Express applications with separate store objects, matching two warm API
    // processes. The third request is rejected because both stores allocate from the Mongo row.
    const firstInstance = makeApp();
    const secondInstance = makeApp();
    expect((await request(firstInstance).get('/limited')).status).toBe(200);
    expect((await request(secondInstance).get('/limited')).status).toBe(200);
    const limited = await request(firstInstance).get('/limited');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });

    const stored = await RateLimitCounterModel.findOne({ namespace: 'test-cross-app' }).lean();
    expect(stored).toMatchObject({ hits: 3 });
    expect(stored!.keyHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain('shared-caller');
  });

  it('does not lose concurrent increments from separate store instances [SEC-04, NFR-03]', async () => {
    const first = createMongoRateLimitStore('test-concurrent');
    const second = createMongoRateLimitStore('test-concurrent');
    first.init({ windowMs: 60_000 } as Options);
    second.init({ windowMs: 60_000 } as Options);

    const increments = await Promise.all(
      Array.from({ length: 24 }, (_, index) => (index % 2 === 0 ? first : second).increment('same-budget')),
    );
    expect(increments.map((entry) => entry.totalHits).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect((await first.get('same-budget'))?.totalHits).toBe(24);
  });

  it('resets expired windows atomically and provisions unique plus TTL indexes [SEC-04]', async () => {
    const store = createMongoRateLimitStore('test-expired');
    store.init({ windowMs: 60_000 } as Options);
    await store.increment('expired-budget');
    await RateLimitCounterModel.updateOne(
      { namespace: 'test-expired' },
      { $set: { hits: 99, resetAt: new Date(Date.now() - 1_000) } },
    );

    const incremented = await store.increment('expired-budget');
    expect(incremented.totalHits).toBe(1);
    expect(incremented.resetTime.getTime()).toBeGreaterThan(Date.now());

    const indexes = await RateLimitCounterModel.collection.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { namespace: 1, keyHash: 1 }, unique: true }),
        expect.objectContaining({ key: { resetAt: 1 }, expireAfterSeconds: 0 }),
      ]),
    );
  });

  it('does not throttle one user browsing several dashboard screens in a minute [SEC-04]', async () => {
    const h = await login('admin@paid.local');
    // A /admin/reports view alone costs eight reads (shell /me, departments, personas, four reports, trends).
    // Three screens' worth of mixed reads must stay inside the coarse per-caller backstop: the product must not
    // rate-limit itself during ordinary browsing. Expensive routes keep their own tighter budgets.
    for (let i = 0; i < 8; i++) {
      expect((await request(app).get('/api/v1/me').set(h)).status).toBe(200);
      expect((await request(app).get('/api/v1/personas').set(h)).status).toBe(200);
      expect((await request(app).get('/api/v1/scenarios').set(h)).status).toBe(200);
    }
    expect((await request(app).get('/api/v1/me').set(h)).status).toBe(200);
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
