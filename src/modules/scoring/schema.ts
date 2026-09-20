import { z } from 'zod';
import { ConditionSchema } from '../shared/conditions';
import { CLASSIFICATIONS, KEY_REGEX, SECTOR_KEY_REGEX } from '../shared/enums';
import { FACTOR_KEYS } from './model';

const SectorKey = z.string().regex(SECTOR_KEY_REGEX, 'lowercase snake_case sector key, 2–64 chars');

const Factor = z.object({
  weight: z.number().min(0).max(100),
  scale: z.object({ min: z.number(), max: z.number() }).default({ min: 1, max: 5 }),
  mapping: z.array(z.object({ when: ConditionSchema, value: z.number() })).default([]),
});
const Range = z.object({ min: z.number().int().min(0).max(100), max: z.number().int().min(0).max(100) });

export const MatrixBody = z
  .object({
    key: z.string().regex(KEY_REGEX),
    name: z.string().min(2).max(160),
    sector: SectorKey.optional(),
    formula: z.literal('weighted_sum').default('weighted_sum'),
    factors: z.object(Object.fromEntries(FACTOR_KEYS.map((k) => [k, Factor])) as Record<(typeof FACTOR_KEYS)[number], typeof Factor>),
    thresholds: z.object(Object.fromEntries(CLASSIFICATIONS.map((c) => [c, Range])) as Record<(typeof CLASSIFICATIONS)[number], typeof Range>),
    confidence: z.object({ professionalConsultBelow: z.number().min(0).max(100).default(60), mandatoryReviewBelow: z.number().min(0).max(100).default(40) }).default({}),
  })
  .superRefine((m, ctx) => {
    const sum = FACTOR_KEYS.reduce((a, k) => a + m.factors[k].weight, 0);
    if (Math.round(sum * 100) / 100 !== 100) ctx.addIssue({ code: 'custom', path: ['factors'], message: `weights sum to ${sum}, expected 100` });
    for (const k of FACTOR_KEYS) {
      const f = m.factors[k];
      if (f.scale.max <= f.scale.min) ctx.addIssue({ code: 'custom', path: ['factors', k, 'scale'], message: 'scale.max must exceed scale.min' });
      for (const [i, mp] of f.mapping.entries()) {
        if (mp.value < f.scale.min || mp.value > f.scale.max) ctx.addIssue({ code: 'custom', path: ['factors', k, 'mapping', i, 'value'], message: `value must be within scale ${f.scale.min}–${f.scale.max}` });
      }
    }
    // Thresholds: four ranges in class order, contiguous, covering 0–100 (FR-19).
    const order = CLASSIFICATIONS.map((c) => m.thresholds[c]);
    let expectedMin = 0;
    order.forEach((r, i) => {
      if (r.min !== expectedMin) ctx.addIssue({ code: 'custom', path: ['thresholds', CLASSIFICATIONS[i]!], message: `range must start at ${expectedMin}` });
      if (r.max < r.min) ctx.addIssue({ code: 'custom', path: ['thresholds', CLASSIFICATIONS[i]!], message: 'max < min' });
      expectedMin = r.max + 1;
    });
    if (order[order.length - 1]!.max !== 100) ctx.addIssue({ code: 'custom', path: ['thresholds', 'issue'], message: 'last range must end at 100' });
  });
export type MatrixBody = z.infer<typeof MatrixBody>;

export const MatrixPatch = MatrixBody.innerType().partial().omit({ key: true });

export const MatrixListQuery = z.object({ view: z.enum(['current', 'all']).optional(), key: z.string().optional() });

export const SimulateBody = z.object({
  facts: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  matrixId: z.string().optional(), // default: current matrix for the sector / "default"
  sector: SectorKey.optional(),
  requiredFactKeys: z.array(z.string()).default([]), // for the confidence estimate
  factConfidences: z.record(z.number().min(0).max(1)).default({}), // per fact, from extraction; defaults to 1
  includeRules: z.boolean().default(true),
});
export type SimulateBody = z.infer<typeof SimulateBody>;

export const ApproveBody = z.object({ changeRef: z.string().trim().min(1).max(200) }).strict();
export const IdParams = z.object({ id: z.string().min(1) });
