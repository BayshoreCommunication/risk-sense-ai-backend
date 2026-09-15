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
import { createApp } from '../src/app';
import { connectDb } from '../src/lib/db';
import { logger } from '../src/lib/logger';

const app = createApp();

// One in-flight connection attempt per instance; a failure clears the cache so the next request retries
// instead of inheriting a rejected promise for the life of the instance.
let connecting: Promise<unknown> | null = null;
function ready(): Promise<unknown> {
  if (!connecting) {
    connecting = connectDb().catch((err) => {
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await ready();
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
