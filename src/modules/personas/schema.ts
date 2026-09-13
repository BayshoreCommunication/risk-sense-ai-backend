import { z } from 'zod';
import { CONTENT_SECTORS, KEY_REGEX, VERSION_STATUSES } from '../shared/enums';

export const PersonaBody = z.object({
  key: z.string().regex(KEY_REGEX, 'lowercase snake_case, 2–64 chars'),
  name: z.string().min(2).max(120),
  sector: z.enum(CONTENT_SECTORS),
  description: z.string().min(10).max(2000),
  responsibilities: z.array(z.string().min(1)).default([]),
  activities: z.array(z.string().min(1)).default([]),
  commonRisks: z.array(z.string().min(1)).default([]),
  vocabulary: z.array(z.string().min(1)).default([]),
  policies: z.array(z.string().min(1)).default([]),
  detectHints: z.array(z.string().min(1)).default([]),
  defaultScenarioKey: z.string().regex(KEY_REGEX).optional(),
});
export type PersonaBody = z.infer<typeof PersonaBody>;

export const PersonaPatch = PersonaBody.partial();

export const PersonaListQuery = z.object({
  status: z.enum(VERSION_STATUSES).optional(),
  sector: z.enum(CONTENT_SECTORS).optional(),
  key: z.string().optional(),
  /** `current` (default for non-admins) returns only the active version per key; `all` returns every version. */
  view: z.enum(['current', 'all']).optional(),
});

export const IdParams = z.object({ id: z.string().min(1) });
