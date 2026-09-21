import { Router } from 'express';
import mongoose from 'mongoose';
import { env, isProd, mailDeliveryStatus, type MailDeliveryStatus } from '../../config/env';
import { dbStatus } from '../../lib/db';
import { ok } from '../../lib/http';

export const healthRouter = Router();

export function aggregateHealthStatus(
  db: ReturnType<typeof dbStatus>,
  mail: MailDeliveryStatus,
): { status: 'ok' | 'degraded'; statusCode: 200 | 503 } {
  const healthy = db === 'connected' && mail === 'available';
  return { status: healthy ? 'ok' : 'degraded', statusCode: healthy ? 200 : 503 };
}

/** GET /health — unauthenticated aggregate liveness/readiness for deployment probes (NFR-05). */
healthRouter.get('/', (_req, res) => {
  const db = dbStatus();
  const mail = mailDeliveryStatus(env.MAIL_PROVIDER, env.MAIL_FROM, isProd);
  const aggregate = aggregateHealthStatus(db, mail);
  const body = {
    status: aggregate.status,
    db,
    openai: env.OPENAI_API_KEY ? 'configured' : 'not_configured',
    auth: env.FIREBASE_SERVICE_ACCOUNT_B64 ? 'firebase' : env.AUTH_DEV_BYPASS ? 'dev_bypass' : 'not_configured',
    mail: mail === 'available' ? env.MAIL_PROVIDER : mail,
    otpDelivery: mail,
    version: process.env.npm_package_version ?? '0.0.0',
    uptimeSec: Math.round(process.uptime()),
  };
  ok(res, body, aggregate.statusCode);
});

/** GET /health/live — process is up (no dependencies); suitable for platform or external liveness probes. */
healthRouter.get('/live', (_req, res) => {
  ok(res, { status: 'ok', uptimeSec: Math.round(process.uptime()) });
});

/** GET /health/ready — database reachable (actual ping, not just the driver state); use for readiness probes. */
healthRouter.get('/ready', async (_req, res) => {
  const t0 = Date.now();
  try {
    await mongoose.connection.db!.admin().ping();
    ok(res, { status: 'ok', db: 'connected', dbPingMs: Date.now() - t0 });
  } catch {
    ok(res, { status: 'degraded', db: dbStatus(), dbPingMs: Date.now() - t0 }, 503);
  }
});
