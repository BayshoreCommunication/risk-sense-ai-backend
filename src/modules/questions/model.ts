import { Schema, model, type InferSchemaType } from 'mongoose';
import { QUESTION_TYPES } from '../shared/enums';

/**
 * Question bank (FR-15). Questions are not versioned individually (DecisionLog 2026-09-13-09):
 * they are `active` or `retired`; the scenario version pins the question-set hash.
 */
const optionSchema = new Schema(
  {
    id: { type: String, required: true }, // stable option id, e.g. "customer"
    label: { type: String, required: true },
    factValue: { type: Schema.Types.Mixed, required: true }, // what lands in the fact (string | number | boolean)
  },
  { _id: false },
);

const questionSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    key: { type: String, required: true, trim: true, lowercase: true },
    text: { type: String, required: true },
    type: { type: String, enum: QUESTION_TYPES, required: true },
    options: { type: [optionSchema], default: [] },
    factKey: { type: String, required: true, trim: true }, // FR-06
    required: { type: Boolean, default: true },
    tags: {
      personaKeys: { type: [String], default: [] },
      scenarioKeys: { type: [String], default: [] }, // empty = all scenarios of the tagged personas
      sectors: { type: [String], default: [] },
      category: { type: String },
    },
    branchTrigger: {
      onValue: { type: Schema.Types.Mixed }, // FR-07: when the answer equals this…
      questionKeys: { type: [String], default: [] }, // …these follow-ups are asked
    },
    scoringHint: { type: String },
    status: { type: String, enum: ['active', 'retired'], default: 'active', index: true },
    retiredAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, collection: 'questions' },
);
questionSchema.index({ tenantId: 1, key: 1 }, { unique: true });
questionSchema.index({ tenantId: 1, 'tags.personaKeys': 1 });
questionSchema.index({ tenantId: 1, 'tags.scenarioKeys': 1 });

export type Question = InferSchemaType<typeof questionSchema>;
export const QuestionModel = model('Question', questionSchema);
