import { Schema, model, type InferSchemaType } from 'mongoose';

/** One retention run per tenant (SEC-06, Section 5) — what was flagged / reduced / archived, and why. */
const retentionRunSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    ranAt: { type: Date, default: Date.now },
    dryRun: { type: Boolean, default: false },
    trigger: { type: String, enum: ['scheduler', 'manual', 'script'], required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    policy: { type: Schema.Types.Mixed },
    flagged: { type: Number, default: 0 },
    reduced: { type: Number, default: 0 },
    archived: { type: Number, default: 0 },
    messagesRemoved: { type: Number, default: 0 },
    auditPastRetention: { type: Number, default: 0 }, // never deleted (SEC-07) — reported for archival
    durationMs: { type: Number },
    error: { type: String },
  },
  { collection: 'retentionRuns', versionKey: false },
);
export type RetentionRun = InferSchemaType<typeof retentionRunSchema>;
export const RetentionRunModel = model('RetentionRun', retentionRunSchema);

/** PAID cold storage: the full assessment document + transcript at archive time (Section 5 "archived", FR-26 stays reconstructible). */
const archiveSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    assessmentId: { type: Schema.Types.ObjectId, ref: 'Assessment', required: true, unique: true },
    archivedAt: { type: Date, default: Date.now },
    document: { type: Schema.Types.Mixed, required: true },
    messages: { type: [Schema.Types.Mixed], default: [] },
  },
  { collection: 'assessmentArchives', versionKey: false },
);
export type AssessmentArchive = InferSchemaType<typeof archiveSchema>;
export const AssessmentArchiveModel = model('AssessmentArchive', archiveSchema);
