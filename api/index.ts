/**
 * Vercel serverless entrypoint (DecisionLog 41).
 *
 * `src/server.ts` stays the Node entrypoint for a long-lived host: it calls `app.listen()` and starts the
 * in-process nightly scheduler. Neither works on Vercel, where every request is a short-lived function
 * invocation, so this file exports the Express app as the request handler instead. `vercel.json` rewrites
 * every path here, and Express keeps routing on the original URL.
 *
 * The database connection is established lazily and reused across invocations on a warm instance:
 * `connectDb()` returns immediately when Mongoose is already connected.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import mongoose from 'mongoose';
import { createApp } from '../src/app';
import { connectDb, createMongoReadinessGate } from '../src/lib/db';
import { logger } from '../src/lib/logger';
import { ensureRateLimitStoreReady } from '../src/modules/rate-limits/store';

const app = createApp();

// Mongoose keeps retrying in the background after a failed connection and emits 'error' on the connection.
// With no listener that surfaces as an unhandled error and the platform reports FUNCTION_INVOCATION_FAILED
// even though this handler already answered 503. Log it and let the per-request path own the response.
mongoose.connection.on('error', (err) => logger.error({ err }, 'mongo connection error'));

// Coalesce only an active attempt. A resolved promise cannot be cached for the life of a warm
// instance because Atlas or the platform may close its idle connection between requests.
const ready = createMongoReadinessGate(async () => {
  await connectDb();
  await ensureRateLimitStoreReady();
});

/**
 * The first request to a cold instance was reliably answering 503 while the next one succeeded: an
 * `mongodb+srv` connect on a cold lambda has to resolve SRV and TXT records, negotiate TLS and
 * authenticate, and that exceeded `serverSelectionTimeoutMS` often enough to be the normal experience
 * of opening the app. Retrying inside the same invocation turns that into the one slow request it
 * always was, instead of an error the visitor has to reload past. `maxDuration` is 60s in vercel.json,
 * so two 10s attempts stay well inside the function budget.
 */
const CONNECT_ATTEMPTS = 2;

async function readyWithRetry(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await ready();
      return;
    } catch (err) {
      if (attempt >= CONNECT_ATTEMPTS) throw err;
      logger.warn({ err, attempt }, 'database connection attempt failed, retrying in this invocation');
    }
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await readyWithRetry();
  } catch (err) {
    // Fail loudly rather than letting Express answer database-backed routes with a confusing 500.
    logger.error({ err }, 'database connection failed for this invocation');
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'DB_UNAVAILABLE', message: 'Database is unavailable' }, meta: { requestId: 'startup' } }));
    return;
  }
  app(req, res);
}
