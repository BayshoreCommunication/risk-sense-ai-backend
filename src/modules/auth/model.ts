import { Schema, model, type InferSchemaType } from 'mongoose';

export const TERMINATION_REASONS = ['timeout', 'logout', 'superseded', 'admin', 'role_changed'] as const;
export const SESSION_AUTHENTICATION_METHODS = ['single_factor', 'firebase_mfa', 'risk_sense_otp', 'development_bypass'] as const;
export type SessionAuthenticationMethod = (typeof SESSION_AUTHENTICATION_METHODS)[number];

const loginAssuranceSchema = new Schema(
  {
    method: { type: String, enum: SESSION_AUTHENTICATION_METHODS, required: true },
    // Present only when this exact session exchange proved an approved second factor.
    mfaVerifiedAt: { type: Date },
  },
  { _id: false },
);

/**
 * Application session (SEC-02, FR-04). Distinct from the Firebase token: this is what enforces
 * idle timeout and "one active session per account".
 */
const sessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // A bounded active slot makes the concurrent-session limit race-safe across API instances.
    slot: { type: Number, min: 0 },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    lastSeenAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true }, // lastSeenAt + idleTimeout; TTL index cleans up stale docs
    terminatedAt: { type: Date },
    terminationReason: { type: String, enum: TERMINATION_REASONS },
    // Required for newly minted sessions. Legacy rows without it are rejected by touch() so they
    // cannot inherit current-login assurance from users.mfaEnrolled or a later Firebase token.
    loginAssurance: { type: loginAssuranceSchema, required: true },
    userAgent: { type: String },
    ip: { type: String },
  },
  { timestamps: true, collection: 'sessions' },
);
sessionSchema.index({ userId: 1, terminatedAt: 1 });
sessionSchema.index(
  { userId: 1, slot: 1 },
  { unique: true, partialFilterExpression: { slot: { $type: 'number' }, terminatedAt: { $exists: false } } },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 }); // keep a day for audit joins

export type Session = InferSchemaType<typeof sessionSchema>;
export const SessionModel = model('Session', sessionSchema);
