import { Schema, model, type InferSchemaType } from 'mongoose';

export const TERMINATION_REASONS = ['timeout', 'logout', 'superseded', 'admin', 'role_changed'] as const;

/**
 * Application session (SEC-02, FR-04). Distinct from the Firebase token: this is what enforces
 * idle timeout and "one active session per account".
 */
const sessionSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    lastSeenAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true }, // lastSeenAt + idleTimeout; TTL index cleans up stale docs
    terminatedAt: { type: Date },
    terminationReason: { type: String, enum: TERMINATION_REASONS },
    userAgent: { type: String },
    ip: { type: String },
  },
  { timestamps: true, collection: 'sessions' },
);
sessionSchema.index({ userId: 1, terminatedAt: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 }); // keep a day for audit joins

export type Session = InferSchemaType<typeof sessionSchema>;
export const SessionModel = model('Session', sessionSchema);
