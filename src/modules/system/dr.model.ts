import { Schema, model, type InferSchemaType } from 'mongoose';

export const FIXED_DR_TARGETS = {
  backupFrequencyHours: 24,
  rpoHours: 1,
  rtoHours: 4,
  drillFrequencyDays: 365,
} as const;

function validTarget(max: number) {
  return {
    validator: (value: number) => Number.isFinite(value) && value > 0 && value <= max,
    message: `target must be greater than 0 and no more than ${max} hours`,
  };
}

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
    // PAID-only policy overrides. FREE always uses FIXED_DR_TARGETS, even if a tenant was downgraded.
    targets: {
      rpoHours: { type: Number, validate: validTarget(FIXED_DR_TARGETS.rpoHours) },
      rtoHours: { type: Number, validate: validTarget(FIXED_DR_TARGETS.rtoHours) },
    },
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, collection: 'drStatuses' },
);

export type DrStatus = InferSchemaType<typeof drStatusSchema>;
export const DrStatusModel = model('DrStatus', drStatusSchema);
