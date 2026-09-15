import { Schema, model, type InferSchemaType } from 'mongoose';

const issueSchema = new Schema({ path: { type: String, required: true }, message: { type: String, required: true } }, { _id: false });

/** Persistent flag for a stored assessment that fails the current schema/invariants (FR-30). */
const assessmentConformanceFlagSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    assessmentId: { type: Schema.Types.ObjectId, ref: 'Assessment', required: true },
    issues: { type: [issueSchema], required: true },
    firstDetectedAt: { type: Date, required: true },
    lastDetectedAt: { type: Date, required: true },
    resolvedAt: { type: Date },
  },
  { timestamps: true, collection: 'assessmentConformanceFlags' },
);
assessmentConformanceFlagSchema.index({ tenantId: 1, assessmentId: 1 }, { unique: true });
assessmentConformanceFlagSchema.index({ tenantId: 1, resolvedAt: 1, lastDetectedAt: -1 });
export type AssessmentConformanceFlag = InferSchemaType<typeof assessmentConformanceFlagSchema>;
export const AssessmentConformanceFlagModel = model('AssessmentConformanceFlag', assessmentConformanceFlagSchema);

const conformanceRunSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    ranAt: { type: Date, required: true },
    trigger: { type: String, enum: ['scheduler', 'manual', 'script'], required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    scanned: { type: Number, required: true },
    valid: { type: Number, required: true },
    flagged: { type: Number, required: true },
    resolved: { type: Number, required: true },
    durationMs: { type: Number, required: true },
  },
  { collection: 'conformanceRuns', versionKey: false },
);
export type ConformanceRun = InferSchemaType<typeof conformanceRunSchema>;
export const ConformanceRunModel = model('ConformanceRun', conformanceRunSchema);
