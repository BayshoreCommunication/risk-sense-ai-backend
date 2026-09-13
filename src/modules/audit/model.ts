import { Schema, model, type InferSchemaType } from 'mongoose';

export const AUDIT_CATEGORIES = ['auth', 'session', 'config', 'dataset', 'assessment', 'decision', 'retention', 'access'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * Append-only, hash-chained audit log (SEC-07, FR-24..26).
 * There are deliberately NO update/delete helpers anywhere in the codebase for this model, and the
 * schema below blocks the Mongoose update/delete paths so a stray call fails loudly.
 */
const auditLogSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    seq: { type: Number, required: true }, // per-tenant monotonic
    category: { type: String, enum: AUDIT_CATEGORIES, required: true },
    action: { type: String, required: true }, // entity.verb, e.g. session.created
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRole: { type: String },
    entity: {
      type: { type: String, required: true },
      id: { type: String, required: true },
      version: { type: Number },
    },
    payload: { type: Schema.Types.Mixed, default: {} },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'auditLogs', versionKey: false },
);
auditLogSchema.index({ tenantId: 1, seq: 1 }, { unique: true });
auditLogSchema.index({ 'entity.type': 1, 'entity.id': 1 });
auditLogSchema.index({ tenantId: 1, category: 1, createdAt: -1 });

// Belt and braces: make mutation through Mongoose impossible.
const forbid = () => {
  throw new Error('auditLogs are append-only (SEC-07)');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'] as const) {
  auditLogSchema.pre(op, forbid);
}
auditLogSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('auditLogs are append-only (SEC-07)'));
  next();
});

export type AuditLog = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel = model('AuditLog', auditLogSchema);
