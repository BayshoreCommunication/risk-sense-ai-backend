import { z } from 'zod';
import { CONTENT_SECTORS, KEY_REGEX, QUESTION_TYPES } from '../shared/enums';

const FactValue = z.union([z.string(), z.number(), z.boolean()]);

export const QuestionBody = z
  .object({
    key: z.string().regex(KEY_REGEX),
    text: z.string().min(5).max(500),
    type: z.enum(QUESTION_TYPES),
    options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), factValue: FactValue })).default([]),
    factKey: z.string().regex(KEY_REGEX),
    required: z.boolean().default(true),
    tags: z
      .object({
        personaKeys: z.array(z.string().regex(KEY_REGEX)).min(1, 'tag at least one persona (FR-15)'),
        scenarioKeys: z.array(z.string().regex(KEY_REGEX)).default([]),
        sectors: z.array(z.enum(CONTENT_SECTORS)).min(1, 'tag at least one sector (FR-15)'),
        category: z.string().max(80).optional(),
      })
      .strict(),
    branchTrigger: z
      .object({ onValue: FactValue, questionKeys: z.array(z.string().regex(KEY_REGEX)).min(1) })
      .optional(),
    scoringHint: z.string().max(300).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'mcq' && q.options.length < 2) ctx.addIssue({ code: 'custom', path: ['options'], message: 'mcq needs at least 2 options' });
    if (q.type !== 'mcq' && q.options.length > 0) ctx.addIssue({ code: 'custom', path: ['options'], message: 'options are only for mcq' });
    if (q.branchTrigger?.questionKeys.includes(q.key)) ctx.addIssue({ code: 'custom', path: ['branchTrigger'], message: 'a question cannot branch to itself' });
  });
export type QuestionBody = z.infer<typeof QuestionBody>;

export const QuestionPatch = QuestionBody.innerType().partial().omit({ key: true });

export const QuestionListQuery = z.object({
  personaKey: z.string().optional(),
  scenarioKey: z.string().optional(),
  sector: z.enum(CONTENT_SECTORS).optional(),
  status: z.enum(['active', 'retired']).optional(),
  key: z.string().optional(),
});

export const IdParams = z.object({ id: z.string().min(1) });
