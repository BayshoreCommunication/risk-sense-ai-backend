import { Router } from 'express';
import { env, isProd } from '../config/env';
import { AppError } from '../lib/errors';
import { ok } from '../lib/http';
import { logger } from '../lib/logger';
import { audit } from '../modules/audit/service';
import { conformanceService } from '../modules/conformance/service';
import { retentionService } from '../modules/retention/service';

/**
 * Nightly maintenance as an HTTP trigger (DecisionLog 41).
 *
 * On a long-lived host `jobs/scheduler.ts` runs this work on a timer. Serverless functions are frozen
 * between requests, so on Vercel the same work is driven by Vercel Cron, which calls this route with
 * `Authorization: Bearer <CRON_SECRET>`.
 *
 * The route is unauthenticated in the RBAC sense on purpose — a scheduler has no user session — so the
 * shared secret is the only gate and it fails closed: without `CRON_SECRET` the route refuses to run at
 * all in production. The work itself is the same idempotent service code, so a retry is harmless.
 */
export const jobsRouter = Router();

function assertCronCaller(header: string | undefined): void {
  const secret = env.CRON_SECRET;
  if (!secret) {
    // Never let an unprotected maintenance endpoint exist in production.
    if (isProd) throw new AppError('FORBIDDEN', 'CRON_SECRET is not configured; refusing to run scheduled work');
    logger.warn('CRON_SECRET is unset; the nightly route is open in this non-production environment');
    return;
  }
  const expected = `Bearer ${secret}`;
  if (header !== expected) throw new AppError('FORBIDDEN', 'Invalid scheduler credentials');
}

/** GET /jobs/nightly — retention (SEC-06), audit-chain verification (SEC-07), conformance scan (FR-30). */
jobsRouter.get('/nightly', async (req, res) => {
  assertCronCaller(req.header('authorization'));
  const now = new Date();
  const startedAt = Date.now();

  const retention = await retentionService.run({ trigger: 'scheduler', actor: null, now });
  const chains: { tenantId: string; slug: string; ok: boolean; firstBadSeq?: number }[] = [];
  for (const r of retention) {
    const v = await audit.verify(r.tenantId);
    if (!v.ok) logger.error({ tenant: r.slug, firstBadSeq: v.firstBadSeq }, 'AUDIT CHAIN BROKEN');
    chains.push({ tenantId: r.tenantId, slug: r.slug, ok: v.ok, firstBadSeq: v.firstBadSeq });
  }
  const conformance = await conformanceService.scan({ trigger: 'scheduler', actor: null, now });

  const summary = {
    ranAt: now.toISOString(),
    durationMs: Date.now() - startedAt,
    retention: retention.map((r) => ({ tenant: r.slug, flagged: r.flagged, reduced: r.reduced, archived: r.archived })),
    auditChains: chains,
    conformance: conformance.map((r) => ({ tenant: r.slug, scanned: r.scanned, flagged: r.flagged })),
    // Surfaced so an alert can fire on the response instead of only in the logs.
    brokenChains: chains.filter((c) => !c.ok).map((c) => c.slug),
  };
  logger.info(summary, 'nightly maintenance done');
  ok(res, summary);
});
