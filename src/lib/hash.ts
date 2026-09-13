import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: keys sorted recursively so the same object always hashes the same.
 * Used by the audit hash chain (SEC-07). Dates become ISO strings, undefined is dropped.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object') {
    // Mongoose ObjectId and similar: use their string form.
    const v = value as { toHexString?: () => string; toJSON?: () => unknown };
    if (typeof v.toHexString === 'function') return v.toHexString();
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = sortKeys(inner);
    }
    return out;
  }
  return value;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export const GENESIS_HASH = sha256('risksense-audit-genesis');
