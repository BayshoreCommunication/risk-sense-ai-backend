import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validates and *replaces* req.body/query/params with the parsed (typed, defaulted) values.
 * Zod errors are turned into 400 VALIDATION_ERROR by the error middleware.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    if (schemas.body) req.body = schemas.body.parse(req.body);
    if (schemas.query) {
      const parsed = schemas.query.parse(req.query);
      // Express 5 exposes req.query as a getter; keep parsed values reachable via res.locals-free pattern.
      Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
    }
    if (schemas.params) {
      const parsed = schemas.params.parse(req.params);
      Object.defineProperty(req, 'params', { value: parsed, writable: true, configurable: true });
    }
    next();
  };
}
