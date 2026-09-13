import { Schema, model, type InferSchemaType } from 'mongoose';

export const ROLES = ['requestor', 'administrator', 'system_administrator', 'audit'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that must always complete the second factor (SEC-03). */
export const PRIVILEGED_ROLES: Role[] = ['administrator', 'system_administrator'];

/**
 * One document = one person = exactly one role (FR-02). `role` is a single enum field on purpose:
 * the schema itself makes "two concurrent roles" unrepresentable.
 */
const userSchema = new Schema(
  {
    firebaseUid: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true }, // sensitive: pii
    name: { type: String, required: true, trim: true }, // sensitive: pii
    role: { type: String, enum: ROLES, required: true },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    departmentIds: { type: [Schema.Types.ObjectId], ref: 'Department', default: [] }, // DASH-04 scoping
    crossDepartmentAccess: { type: Boolean, default: false }, // granted by an administrator
    mfaEnrolled: { type: Boolean, default: false }, // SEC-03 — true once a second factor has been completed
    lastMfaAt: { type: Date },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, collection: 'users' },
);
userSchema.index({ tenantId: 1, role: 1 });

export type User = InferSchemaType<typeof userSchema>;
export const UserModel = model('User', userSchema);
