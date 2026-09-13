import { z } from 'zod';
import { ConditionSchema } from '../shared/conditions';
import { CLASSIFICATIONS, CONTENT_SECTORS, KEY_REGEX } from '../shared/enums';
import { RULE_STATUSES } from './model';

export const RuleBody = z.object({
  key: z.string().regex(KEY_REGEX),
  name: z.string().min(2).max(160),
  description: z.string().max(2000).optional(),
  trigger: ConditionSchema,
  forcedClassification: z.enum(CLASSIFICATIONS),
  forcedAction: z.string().max(300).optional(),
  priority: z.number().int().min(1).max(1000).default(100),
  sectors: z.array(z.enum(CONTENT_SECTORS)).default([]),
});
export type RuleBody = z.infer<typeof RuleBody>;

export const RulePatch = RuleBody.partial().omit({ key: true });

export const RuleListQuery = z.object({
  status: z.enum(RULE_STATUSES).optional(),
  sector: z.enum(CONTENT_SECTORS).optional(),
});

export const ApproveBody = z.object({ changeRef: z.string().max(200).optional() }).default({});
export const IdParams = z.object({ id: z.string().min(1) });
