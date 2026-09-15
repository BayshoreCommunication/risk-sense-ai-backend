import { Schema, model, type InferSchemaType } from 'mongoose';
import { versionedFields } from '../../lib/versioned';
import { CLASSIFICATIONS } from '../shared/enums';

/**
 * Scenario — a specific risk situation inside a persona's library (BRD §6, FR-11).
 * Versioned copy-on-write; references personas and questions by key.
 */
const flowNodeSchema = new Schema(
  {
    questionKey: { type: String, required: true },
    // Optional gate on an already-captured fact (in addition to question-level branch triggers, FR-07).
    showIf: { factKey: { type: String }, equals: { type: Schema.Types.Mixed } },
  },
  { _id: false },
);

const actionSchema = new Schema(
  {
    decisionRecommendation: { type: String, required: true },
    nextSteps: { type: [String], default: [] },
  },
  { _id: false },
);

const scenarioSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    key: { type: String, required: true, trim: true, lowercase: true },
    personaKey: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    businessContext: { type: String, required: true },
    learningObjective: { type: String },
    riskIndicators: { type: [String], default: [] },
    conversationFlow: { type: [flowNodeSchema], default: [] }, // ordered; branches hang off questions
    requiredFactKeys: { type: [String], default: [] }, // FR-03
    expectedClassification: { type: String, enum: CLASSIFICATIONS }, // test harness
    reasoningExample: { type: String }, // AI-02 few-shot
    recommendedActions: {
      monitor_only: { type: actionSchema },
      risk: { type: actionSchema },
      elevated_risk: { type: actionSchema },
      issue: { type: actionSchema },
    },
    // Filled at activation: sha256 of every executable field in the sorted reachable question set (AI-04 pin).
    questionSetHash: { type: String },
    ...versionedFields,
  },
  { timestamps: true, collection: 'scenarios' },
);
scenarioSchema.index({ tenantId: 1, personaKey: 1, isCurrent: 1, status: 1 });
scenarioSchema.index({ tenantId: 1, key: 1, isCurrent: 1 });
scenarioSchema.index({ tenantId: 1, versionGroupId: 1, version: 1 }, { unique: true });

export type Scenario = InferSchemaType<typeof scenarioSchema>;
export const ScenarioModel = model('Scenario', scenarioSchema);
