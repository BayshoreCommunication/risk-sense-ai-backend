import { z } from 'zod';
import { CLASSIFICATIONS, KEY_REGEX } from '../shared/enums';
import { ASSESSMENT_STATUSES, DECISION_TYPES } from './model';

export const StartBody = z
  .object({
    personaKey: z.string().regex(KEY_REGEX).optional(),
    text: z.string().max(4000).optional(), // opening description; used for persona inference and scenario selection
  })
  .refine((b) => b.personaKey || (b.text && b.text.trim().length >= 10), { message: 'give a personaKey or describe the incident in at least 10 characters' });
export type StartBody = z.infer<typeof StartBody>;

export const PersonaBody = z.object({ personaKey: z.string().regex(KEY_REGEX) });

export const MessageBody = z
  .object({
    questionKey: z.string().regex(KEY_REGEX).optional(), // defaults to the current question
    value: z.union([z.string(), z.number(), z.boolean()]).optional(), // structured answer (mcq option id / yes-no / number)
    text: z.string().max(4000).optional(), // free-text answer (or the incident description in the describe phase)
  })
  .refine((b) => b.value !== undefined || (b.text && b.text.trim().length > 0), { message: 'send a value or a text' });
export type MessageBody = z.infer<typeof MessageBody>;

export const DecisionBody = z
  .object({
    type: z.enum(DECISION_TYPES),
    reason: z.string().max(4000).optional(),
    overriddenTo: z.enum(CLASSIFICATIONS).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.type === 'override') {
      if (!d.reason || d.reason.trim().length < 25) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'an override needs a documented reason of at least 25 characters (FR-23)' });
      if (!d.overriddenTo) ctx.addIssue({ code: 'custom', path: ['overriddenTo'], message: 'an override must state the new classification' });
    }
  });
export type DecisionBody = z.infer<typeof DecisionBody>;

export const ListQuery = z.object({
  status: z.enum(ASSESSMENT_STATUSES).optional(),
  personaKey: z.string().optional(),
  departmentId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  page: z.coerce.number().int().min(1).default(1),
});

export const IdParams = z.object({ id: z.string().min(1) });
