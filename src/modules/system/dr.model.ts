import { Schema, model, type InferSchemaType } from 'mongoose';

/** Operator-recorded evidence from the external backup provider; this app never invents backup success. */
const drStatusSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, unique: true },
    provider: { type: String },
    backupsEnabled: { type: Boolean, default: false },
    lastBackupAt: { type: Date },
    lastRestoreDrillAt: { type: Date },
    lastRestoreDrillOutcome: { type: String, enum: ['passed', 'failed'] },
    evidenceRef: { type: String },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, collection: 'drStatuses' },
);

export type DrStatus = InferSchemaType<typeof drStatusSchema>;
export const DrStatusModel = model('DrStatus', drStatusSchema);
