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
    // New issuances use the single active slot. The partial unique index is a datastore-level
    // backstop in addition to the issuance lock and atomic supersede/create transaction.
    activeSlot: { type: Number, min: 0, max: 0 },
    consumedAt: { type: Date },
    supersededAt: { type: Date },
    sentTo: { type: String, required: true }, // masked in API responses; sensitive: pii
  },
  { timestamps: true, collection: 'otpCodes' },
);
otpCodeSchema.index(
  { userId: 1, purpose: 1, activeSlot: 1 },
  { unique: true, partialFilterExpression: { activeSlot: { $type: 'number' } } },
);
otpCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 }); // purge an hour after expiry

export type OtpCode = InferSchemaType<typeof otpCodeSchema>;
export const OtpCodeModel = model('OtpCode', otpCodeSchema);

/**
 * A short-lived, database-authoritative mutex for one user's OTP issuance path. Using a
 * deterministic string `_id` relies on MongoDB's built-in unique index, so it is safe before
 * Mongoose has built secondary indexes and across independent API instances.
 */
const otpIssueLockSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: ['login'], required: true },
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'otpIssueLocks' },
);
otpIssueLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type OtpIssueLock = InferSchemaType<typeof otpIssueLockSchema>;
export const OtpIssueLockModel = model('OtpIssueLock', otpIssueLockSchema);
