import { z } from 'zod';
import { KEY_REGEX } from './enums';

/**
 * Deterministic condition language shared by hard rules (FR-16/17), scoring mappings (FR-18) and
 * scenario-local decision rules. No LLM involvement anywhere in here (FR-08).
 *
 *   { factKey: 'amount_usd', op: 'gt', value: 100000 }
 *   { all: [ {…}, {…} ] }   { any: [ {…}, {…} ] }
 */
export const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'exists'] as const;
export type Op = (typeof OPS)[number];

export type FactValue = string | number | boolean | null | undefined;
export type Facts = Record<string, FactValue>;

export interface Condition {
  all?: Condition[];
  any?: Condition[];
  factKey?: string;
  op?: Op;
  value?: FactValue | FactValue[];
}

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const Leaf = z
  .object({ factKey: z.string().regex(KEY_REGEX), op: z.enum(OPS), value: z.union([Scalar, z.array(Scalar)]).optional() })
  .strict()
  .superRefine((c, ctx) => {
    if (c.op !== 'exists' && c.value === undefined) ctx.addIssue({ code: 'custom', path: ['value'], message: `op "${c.op}" needs a value` });
    if (c.op === 'in' && !Array.isArray(c.value)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'op "in" needs an array value' });
  });

const group = (inner: z.ZodTypeAny) =>
  z
    .object({ all: z.array(inner).min(1).optional(), any: z.array(inner).min(1).optional() })
    .strict()
    .refine((g) => (g.all ? 1 : 0) + (g.any ? 1 : 0) === 1, { message: 'a group is exactly one of { all: [...] } or { any: [...] }' });

// Recursion is bounded to three nesting levels instead of z.lazy so the schema can be rendered to OpenAPI
// (and three levels is more than any rule TAC has described).
const L1 = z.union([Leaf, group(Leaf)]);
const L2 = z.union([Leaf, group(L1)]);
export const ConditionSchema = z.union([Leaf, group(L2)]) as unknown as z.ZodType<Condition>;

/** yes/no/true/false → boolean, numeric strings → number, else trimmed lowercase string. Same rule as the template parser. */
export function normalizeValue(v: FactValue): FactValue {
  if (v === null || v === undefined) return v;
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  const t = String(v).trim();
  const low = t.toLowerCase();
  if (['yes', 'true'].includes(low)) return true;
  if (['no', 'false'].includes(low)) return false;
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
  return low;
}

function compare(a: FactValue, op: Op, b: FactValue | FactValue[]): boolean {
  const x = normalizeValue(a);
  if (op === 'exists') return x !== null && x !== undefined && x !== '';
  if (x === null || x === undefined) return false;
  if (op === 'in') return Array.isArray(b) && b.map(normalizeValue).some((y) => y === x);
  const y = normalizeValue(Array.isArray(b) ? b[0] : b);
  switch (op) {
    case 'eq':
      return x === y;
    case 'ne':
      return x !== y;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof x !== 'number' || typeof y !== 'number') return false;
      return op === 'gt' ? x > y : op === 'gte' ? x >= y : op === 'lt' ? x < y : x <= y;
    }
  }
}

/** Pure evaluator. Unknown facts never match (except `exists` which is then false). */
export function matches(condition: Condition, facts: Facts): boolean {
  if (condition.all) return condition.all.every((c) => matches(c, facts));
  if (condition.any) return condition.any.some((c) => matches(c, facts));
  if (!condition.factKey || !condition.op) return false;
  return compare(facts[condition.factKey], condition.op, condition.value);
}

/** Fact keys a condition reads — used to validate that questions can produce them. */
export function factKeysOf(condition: Condition): string[] {
  if (condition.all) return condition.all.flatMap(factKeysOf);
  if (condition.any) return condition.any.flatMap(factKeysOf);
  return condition.factKey ? [condition.factKey] : [];
}

const TEXT_OPS: Record<string, Op> = { '=': 'eq', '==': 'eq', '!=': 'ne', '>': 'gt', '>=': 'gte', '<': 'lt', '<=': 'lte' };

/**
 * Parses one template expression `fact_key op value` (e.g. `amount_usd > 100000`, `fraud_confirmed = confirmed`).
 * Returns null when the text is not a well-formed leaf.
 */
export function parseLeaf(text: string): Condition | null {
  const m = text.trim().match(/^([a-z][a-z0-9_]*)\s*(>=|<=|!=|==|=|>|<)\s*(.+)$/);
  if (!m) return null;
  const [, factKey, opText, raw] = m;
  const op = TEXT_OPS[opText!];
  if (!op) return null;
  const value = normalizeValue(raw!.replace(/^["']|["']$/g, ''));
  return { factKey: factKey!, op, value: value as FactValue };
}

const OP_TEXT: Record<Op, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', in: 'in', exists: 'exists' };
/** Human-readable form for explanations and audit payloads, e.g. `amount_usd > 100000`. */
export function conditionText(c: Condition | undefined): string {
  if (!c) return '';
  if (c.all) return c.all.map(conditionText).join(' and ');
  if (c.any) return c.any.map(conditionText).join(' or ');
  const v = Array.isArray(c.value) ? `[${c.value.join(', ')}]` : String(c.value ?? '');
  return c.op === 'exists' ? `${c.factKey} exists` : `${c.factKey} ${OP_TEXT[c.op!]} ${v}`;
}
