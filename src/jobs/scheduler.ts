import { env } from '../config/env';
import { logger } from '../lib/logger';
import { audit } from '../modules/audit/service';
import { conformanceService } from '../modules/conformance/service';
import { retentionService } from '../modules/retention/service';

/**
 * In-process nightly jobs (ISS-015: no Redis/BullMQ needed for one always-on Render instance).
 * Enabled with JOBS_ENABLED=true; runs once per UTC day at JOBS_RETENTION_HOUR (default 02:00 UTC).
 * A Render Cron Job calling `npm run retention` is the alternative for multi-instance deployments.
 */
let timer: NodeJS.Timeout | undefined;
let lastRunDay = '';

export function startScheduler() {
  if (!env.JOBS_ENABLED) return;
  const tick = async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== env.JOBS_RETENTION_HOUR || lastRunDay === day) return;
    lastRunDay = day;
    try {
      const results = await retentionService.run({ trigger: 'scheduler', actor: null, now });
      logger.info({ results: results.map((r) => ({ tenant: r.slug, flagged: r.flagged, reduced: r.reduced, archived: r.archived })) }, 'retention job done');
      // Nightly audit-chain verification (W7) — one entry per tenant is enough for alerting.
      for (const r of results) {
        const v = await audit.verify(r.tenantId);
        if (!v.ok) logger.error({ tenant: r.slug, firstBadSeq: v.firstBadSeq }, 'AUDIT CHAIN BROKEN');
      }
      const conformance = await conformanceService.scan({ trigger: 'scheduler', actor: null, now });
      logger.info({ results: conformance.map((r) => ({ tenant: r.slug, scanned: r.scanned, flagged: r.flagged })) }, 'assessment conformance scan done');
    } catch (err) {
      logger.error({ err }, 'scheduled job failed');
    }
  };
  timer = setInterval(() => void tick(), 5 * 60 * 1000);
  timer.unref();
  logger.info({ hourUtc: env.JOBS_RETENTION_HOUR }, 'scheduler started');
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
}
