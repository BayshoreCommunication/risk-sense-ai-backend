import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * One-time codes for the second login factor (FR-01, SEC-03). Only a SHA-256 of the code is stored.
 * Superseded by any newer request for the same user; consumed on success; locked after too many attempts.
 */
const otpCodeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    purpose: { type: String, enum: ['login'], default: 'login' },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date },
    supersededAt: { type: Date },
    sentTo: { type: String, required: true }, // masked in API responses; sensitive: pii
  },
  { timestamps: true, collection: 'otpCodes' },
);
otpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 }); // purge an hour after expiry

export type OtpCode = InferSchemaType<typeof otpCodeSchema>;
export const OtpCodeModel = model('OtpCode', otpCodeSchema);
