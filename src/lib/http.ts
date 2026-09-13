import type { Response } from 'express';

/** Success envelope (docs/ai/API.md). */
export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ data, meta: { requestId: res.locals.requestId } });
}
