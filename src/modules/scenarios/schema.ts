import { z } from 'zod';
import { CLASSIFICATIONS, KEY_REGEX, VERSION_STATUSES } from '../shared/enums';

const Action = z.object({ decisionRecommendation: z.string().min(2), nextSteps: z.array(z.string().min(1)).default([]) });

export const ScenarioBody = z.object({
  key: z.string().regex(KEY_REGEX),
  personaKey: z.string().regex(KEY_REGEX),
  name: z.string().min(2).max(160),
  description: z.string().min(10).max(4000),
  businessContext: z.string().min(5).max(4000),
  learningObjective: z.string().max(2000).optional(),
  riskIndicators: z.array(z.string().min(1)).default([]),
  conversationFlow: z
    .array(
      z.object({
        questionKey: z.string().regex(KEY_REGEX),
        showIf: z.object({ factKey: z.string().regex(KEY_REGEX), equals: z.union([z.string(), z.number(), z.boolean()]) }).optional(),
      }),
    )
    .default([]),
  requiredFactKeys: z.array(z.string().regex(KEY_REGEX)).default([]),
  expectedClassification: z.enum(CLASSIFICATIONS).optional(),
  reasoningExample: z.string().max(4000).optional(),
  recommendedActions: z
    .object({ monitor_only: Action.optional(), risk: Action.optional(), elevated_risk: Action.optional(), issue: Action.optional() })
    .default({}),
});
export type ScenarioBody = z.infer<typeof ScenarioBody>;

export const ScenarioPatch = ScenarioBody.partial().omit({ key: true });

export const ScenarioListQuery = z.object({
  personaKey: z.string().optional(),
  status: z.enum(VERSION_STATUSES).optional(),
  key: z.string().optional(),
  view: z.enum(['current', 'all']).optional(),
});

export const IdParams = z.object({ id: z.string().min(1) });
