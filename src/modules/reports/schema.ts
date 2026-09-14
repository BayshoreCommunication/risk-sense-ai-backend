import { z } from 'zod';
import { KEY_REGEX } from '../shared/enums';

export const REPORT_TYPES = ['volume', 'classification', 'override-rate', 'assessment-time'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const INTERVALS = ['day', 'week', 'month'] as const;
export const TREND_DIMENSIONS = ['department', 'persona', 'scenario'] as const;
export const EXPORT_FORMATS = ['csv', 'pdf'] as const;

const OBJECT_ID = /^[a-f\d]{24}$/i;

/** Common filters for every report (FR-26: date range; DASH-04: department; plus persona/scenario). */
export const ReportQuery = z
  .object({
    from: z.coerce.date().optional(), // default: 12 months back
    to: z.coerce.date().optional(), // default: now
    interval: z.enum(INTERVALS).default('month'),
    departmentId: z.string().regex(OBJECT_ID).optional(),
    personaKey: z.string().regex(KEY_REGEX).optional(),
    scenarioKey: z.string().regex(KEY_REGEX).optional(),
    refresh: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'), // bypass the 1 h cache
  })
  .refine((q) => !(q.from && q.to) || q.from <= q.to, { message: 'from must be before to' });
export type ReportQuery = z.infer<typeof ReportQuery>;

export const ReportParams = z.object({ type: z.enum(REPORT_TYPES) });
export const ExportQuery = ReportQuery.innerType().extend({ format: z.enum(EXPORT_FORMATS).default('csv') });
export type ExportQuery = z.infer<typeof ExportQuery>;

export const TrendsQuery = ReportQuery.innerType().extend({ by: z.enum(TREND_DIMENSIONS).default('department') });
export type TrendsQuery = z.infer<typeof TrendsQuery>;
