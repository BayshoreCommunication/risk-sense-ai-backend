import { Router } from 'express';
import mongoose from 'mongoose';
import { env } from '../../config/env';
import { dbStatus } from '../../lib/db';
import { ok } from '../../lib/http';

export const healthRouter = Router();

/** GET /health — unauthenticated liveness/readiness (Render health check, NFR-05). */
healthRouter.get('/', (_req, res) => {
  const db = dbStatus();
  const body = {
    status: db === 'connected' ? 'ok' : 'degraded',
    db,
    openai: env.OPENAI_API_KEY ? 'configured' : 'not_configured',
    auth: env.FIREBASE_SERVICE_ACCOUNT_B64 ? 'firebase' : env.AUTH_DEV_BYPASS ? 'dev_bypass' : 'not_configured',
    mail: env.MAIL_PROVIDER,
    version: process.env.npm_package_version ?? '0.0.0',
    uptimeSec: Math.round(process.uptime()),
  };
  ok(res, body, db === 'connected' ? 200 : 503);
});

/** GET /health/live — process is up (no dependencies). Render/UptimeRobot liveness. */
healthRouter.get('/live', (_req, res) => {
  ok(res, { status: 'ok', uptimeSec: Math.round(process.uptime()) });
});

/** GET /health/ready — database reachable (actual ping, not just the driver state). Use as the Render health check path. */
healthRouter.get('/ready', async (_req, res) => {
  const t0 = Date.now();
  try {
    await mongoose.connection.db!.admin().ping();
    ok(res, { status: 'ok', db: 'connected', dbPingMs: Date.now() - t0 });
  } catch {
    ok(res, { status: 'degraded', db: dbStatus(), dbPingMs: Date.now() - t0 }, 503);
  }
});
