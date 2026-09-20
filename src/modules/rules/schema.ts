import { z } from 'zod';
import { ConditionSchema } from '../shared/conditions';
import { CLASSIFICATIONS, KEY_REGEX, SECTOR_KEY_REGEX } from '../shared/enums';
import { RULE_STATUSES } from './model';

const SectorKey = z.string().regex(SECTOR_KEY_REGEX, 'lowercase snake_case sector key, 2–64 chars');

export const RuleBody = z.object({
  key: z.string().regex(KEY_REGEX),
  name: z.string().min(2).max(160),
  description: z.string().max(2000).optional(),
  trigger: ConditionSchema,
  forcedClassification: z.enum(CLASSIFICATIONS),
  forcedAction: z.string().max(300).optional(),
  priority: z.number().int().min(1).max(1000).default(100),
  sectors: z.array(SectorKey).default([]),
});
export type RuleBody = z.infer<typeof RuleBody>;

export const RulePatch = RuleBody.partial().omit({ key: true });

export const RuleListQuery = z.object({
  status: z.enum(RULE_STATUSES).optional(),
  sector: SectorKey.optional(),
});

export const ApproveBody = z.object({ changeRef: z.string().trim().min(1).max(200) }).strict();
export const IdParams = z.object({ id: z.string().min(1) });
