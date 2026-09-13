import { Schema, model, type InferSchemaType } from 'mongoose';

export const DATASET_STATUSES = ['rejected', 'validated', 'approved', 'active', 'failed'] as const;
export type DatasetStatus = (typeof DATASET_STATUSES)[number];

/**
 * One uploaded content file (FR-13, FR-14, AI-04, AI-06).
 *   upload → rejected (row errors) | validated → approve (reviewer ≠ author) → approved → activate → active
 * The normalized bodies are stored so activation applies exactly what was reviewed.
 */
const rowErrorSchema = new Schema(
  { sheet: { type: String, required: true }, row: { type: Number, required: true }, column: { type: String }, message: { type: String, required: true } },
  { _id: false },
);

const datasetSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    seq: { type: Number, required: true }, // per-tenant upload number, shown as "Upload #7"
    fileName: { type: String, required: true },
    format: { type: String, enum: ['xlsx', 'json'], required: true },
    templateVersion: { type: Number, default: 1 },
    status: { type: String, enum: DATASET_STATUSES, required: true, index: true },
    counts: {
      personas: { type: Number, default: 0 },
      scenarios: { type: Number, default: 0 },
      questions: { type: Number, default: 0 },
      scoring: { type: Number, default: 0 },
      skippedRows: { type: Number, default: 0 },
    },
    validationErrors: { type: [rowErrorSchema], default: [] },
    content: { type: Schema.Types.Mixed, required: true }, // ParsedContent minus errors: the exact bodies to apply
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewerId: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    activatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    activatedAt: { type: Date },
    applied: {
      personas: { type: [String], default: [] }, // keys created/updated
      scenarios: { type: [String], default: [] },
      questions: { type: [String], default: [] },
    },
    failure: { type: String },
  },
  { timestamps: true, collection: 'datasets' },
);
datasetSchema.index({ tenantId: 1, seq: 1 }, { unique: true });

export type Dataset = InferSchemaType<typeof datasetSchema>;
export const DatasetModel = model('Dataset', datasetSchema);
