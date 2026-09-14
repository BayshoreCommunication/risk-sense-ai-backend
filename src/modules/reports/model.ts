import { Schema, model, type InferSchemaType } from 'mongoose';

export const REPORT_CACHE_TTL_SEC = 60 * 60; // W9: results cached for the exact params for 1 h

/** Cached report output (Database.md `reports`). Keyed by a hash of type + params + caller scope. */
const reportSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    type: { type: String, required: true },
    key: { type: String, required: true }, // sha256(canonical(type, params, scope))
    params: { type: Schema.Types.Mixed, default: {} },
    generatedAt: { type: Date, default: Date.now },
    computeMs: { type: Number },
    rows: { type: [Schema.Types.Mixed], default: [] },
    summary: { type: Schema.Types.Mixed },
  },
  { collection: 'reports', versionKey: false },
);
reportSchema.index({ tenantId: 1, key: 1 }, { unique: true });
reportSchema.index({ generatedAt: 1 }, { expireAfterSeconds: REPORT_CACHE_TTL_SEC });

export type Report = InferSchemaType<typeof reportSchema>;
export const ReportModel = model('Report', reportSchema);
