import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { app, seeded } from '../tests/helpers';
import { AuditLogModel } from '../modules/audit/model';
import { RetentionRunModel } from '../modules/retention/model';

/**
 * The Vercel Cron trigger for nightly maintenance (DecisionLog 41). The same work the in-process
 * scheduler runs on a long-lived host: retention (SEC-06), audit-chain verification (SEC-07) and the
 * conformance scan (FR-30).
 */
describe('nightly maintenance route [SEC-06, SEC-07, FR-30]', () => {
  const secret = 'test-cron-secret-value-0123456789';
  const original = env.CRON_SECRET;

  beforeEach(async () => {
    await seeded();
    (env as { CRON_SECRET?: string }).CRON_SECRET = secret;
  });
  afterEach(() => {
    (env as { CRON_SECRET?: string }).CRON_SECRET = original;
  });

  const call = (auth?: string) => {
    const r = request(app).get('/api/v1/jobs/nightly');
    return auth === undefined ? r : r.set('Authorization', auth);
  };

  it('refuses callers without the scheduler secret and never runs the work [SEC-06]', async () => {
    for (const auth of [undefined, 'Bearer wrong', secret, 'Basic ' + secret]) {
      const res = await call(auth);
      expect(res.status, String(auth)).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    // nothing ran: no retention run was recorded for any tenant
    expect(await RetentionRunModel.countDocuments()).toBe(0);
  });

  it('runs retention, verifies every tenant chain and reports a summary the scheduler can alert on', async () => {
    const res = await call(`Bearer ${secret}`);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.ranAt).toBeTruthy();
    expect(data.durationMs).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(data.retention)).toBe(true);
    expect(data.retention.length).toBeGreaterThan(0);
    // one chain verification per tenant touched by retention, all intact on seeded data
    expect(data.auditChains.length).toBe(data.retention.length);
    expect(data.auditChains.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(data.brokenChains).toEqual([]);
    expect(Array.isArray(data.conformance)).toBe(true);
    // the run is persisted like any other retention run, so it shows in /system/retention/runs
    expect(await RetentionRunModel.countDocuments()).toBe(data.retention.length);
    const run = await RetentionRunModel.findOne().lean();
    expect(run!.trigger).toBe('scheduler');
  });

  it('is idempotent: a retry adds runs without changing already-enforced records [SEC-06]', async () => {
    await call(`Bearer ${secret}`);
    const auditAfterFirst = await AuditLogModel.countDocuments({ category: 'retention' });
    const second = await call(`Bearer ${secret}`);
    expect(second.status).toBe(200);
    // seeded data has nothing past its window, so a second pass flags and reduces nothing new
    expect(second.body.data.retention.every((r: { flagged: number; reduced: number }) => r.flagged === 0 && r.reduced === 0)).toBe(true);
    expect(await AuditLogModel.countDocuments({ category: 'retention' })).toBe(auditAfterFirst);
  });
});
