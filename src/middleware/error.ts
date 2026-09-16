import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { isProd } from '../config/env';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
    meta: { requestId: res.locals.requestId },
  });
};

/** Maps every thrown error to the API envelope. Unknown errors are logged and masked. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const requestId = res.locals.requestId;

  if (err instanceof AppError || (err && typeof err === 'object' && (err as { name?: string }).name === 'AppError')) {
    const appErr = err as AppError;
    res.status(appErr.status ?? 500).json({ error: { code: appErr.code ?? 'INTERNAL', message: appErr.message, details: appErr.details }, meta: { requestId } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues },
      meta: { requestId },
    });
    return;
  }
  if (typeof err === 'object' && err && 'type' in err && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body' }, meta: { requestId } });
    return;
  }

  logger.error({ err, requestId }, 'unhandled error');
  const message = isProd ? 'Internal server error' : ((err as Error)?.message ?? String(err));
  res.status(500).json({ error: { code: 'INTERNAL', message }, meta: { requestId } });
};
