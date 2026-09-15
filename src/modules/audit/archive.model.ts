import { Schema, model, type InferSchemaType } from 'mongoose';

/** Immutable evidence that an audit range was exported for external cold storage (SEC-06, SEC-07). */
const auditArchiveManifestSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    from: { type: Date, required: true },
    to: { type: Date, required: true },
    firstSeq: { type: Number, required: true },
    lastSeq: { type: Number, required: true },
    recordCount: { type: Number, required: true },
    exportHash: { type: String, required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'auditArchiveManifests', versionKey: false },
);
auditArchiveManifestSchema.index({ tenantId: 1, createdAt: -1 });

const forbid = () => {
  throw new Error('audit archive manifests are immutable (SEC-07)');
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'replaceOne'] as const) {
  auditArchiveManifestSchema.pre(op, forbid);
}
auditArchiveManifestSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('audit archive manifests are immutable (SEC-07)'));
  next();
});

export type AuditArchiveManifest = InferSchemaType<typeof auditArchiveManifestSchema>;
export const AuditArchiveManifestModel = model('AuditArchiveManifest', auditArchiveManifestSchema);
