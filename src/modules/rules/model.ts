import { Schema, model, type InferSchemaType } from 'mongoose';
import { CLASSIFICATIONS } from '../shared/enums';
import { RULE_VERSION_INDEXES } from './indexes';

export const RULE_STATUSES = ['draft', 'approved', 'active', 'retired'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

/**
 * Hard business rule (FR-16, FR-17): when `trigger` matches the extracted facts, `forcedClassification`
 * overrides the computed score and the result is labeled rule-driven. Change control (AI-05):
 * draft → approved (by someone other than the author) → active; edits create/reset a replacement draft.
 */
const ruleSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    key: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    description: { type: String },
    trigger: { type: Schema.Types.Mixed, required: true }, // Condition
    forcedClassification: { type: String, enum: CLASSIFICATIONS, required: true },
    forcedAction: { type: String },
    priority: { type: Number, default: 100 }, // lower wins when several fire (DecisionLog 10)
    sectors: { type: [String], default: [] }, // empty = all
    status: { type: String, enum: RULE_STATUSES, default: 'draft', index: true },
    versionGroupId: { type: Schema.Types.ObjectId, required: true, index: true },
    version: { type: Number, required: true, default: 1 },
    isCurrent: { type: Boolean, default: false, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    changeRef: { type: String }, // ticket / dataset reference for the approval record
    activatedAt: { type: Date },
    retiredAt: { type: Date },
  },
  { timestamps: true, collection: 'rules' },
);
// One logical rule group per key, while allowing later versions to reuse the same key.
for (const index of RULE_VERSION_INDEXES) ruleSchema.index(index.key, { name: index.name, ...index.options });
ruleSchema.index({ tenantId: 1, status: 1, priority: 1 });

export type Rule = InferSchemaType<typeof ruleSchema>;
export const RuleModel = model('Rule', ruleSchema);
