import { Schema, model, type InferSchemaType } from 'mongoose';
import { CLASSIFICATIONS } from '../shared/enums';

export const ASSESSMENT_STATUSES = ['in_progress', 'intake_complete', 'awaiting_decision', 'escalated', 'closed', 'error_review'] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];
export const DECISION_TYPES = ['accept', 'override', 'escalate'] as const;

const answerSchema = new Schema(
  { questionKey: { type: String, required: true }, value: { type: Schema.Types.Mixed }, text: { type: String }, answeredAt: { type: Date, default: Date.now } },
  { _id: false },
);
const factSchema = new Schema(
  {
    key: { type: String, required: true },
    value: { type: Schema.Types.Mixed },
    source: { type: String, enum: ['mcq', 'ai', 'system'], required: true }, // FR-06
    questionKey: { type: String },
    confidence: { type: Number, default: 1 },
    flagged: { type: Boolean, default: false }, // low-confidence extraction kept for review, never dropped
    evidence: { type: String },
  },
  { _id: false },
);
const pinSchema = new Schema({ id: { type: Schema.Types.ObjectId }, version: { type: Number } }, { _id: false });

const pinnedQuestionOptionSchema = new Schema(
  { id: { type: String, required: true }, label: { type: String, required: true }, factValue: { type: Schema.Types.Mixed, required: true } },
  { _id: false },
);
const pinnedQuestionSchema = new Schema(
  {
    key: { type: String, required: true },
    text: { type: String, required: true },
    type: { type: String, enum: ['mcq', 'yes_no', 'free_text', 'number'], required: true },
    factKey: { type: String, required: true },
    required: { type: Boolean, required: true },
    options: { type: [pinnedQuestionOptionSchema], default: [] },
    branchTrigger: {
      onValue: { type: Schema.Types.Mixed },
      questionKeys: { type: [String], default: [] },
    },
  },
  { _id: false },
);
const pinnedRuleSchema = new Schema(
  {
    id: { type: String, required: true },
    key: { type: String, required: true },
    name: { type: String, required: true },
    trigger: { type: Schema.Types.Mixed, required: true },
    forcedClassification: { type: String, enum: CLASSIFICATIONS, required: true },
    forcedAction: { type: String },
    priority: { type: Number, required: true },
  },
  { _id: false },
);
const pinnedContentSchema = new Schema(
  {
    personaVocabulary: { type: [String], default: [] },
    questions: { type: [pinnedQuestionSchema], default: [] },
    rules: { type: [pinnedRuleSchema], default: [] },
  },
  { _id: false },
);

/**
 * One intake session and its outcome (Database.md). Invariants enforced here, not only in the UI:
 *  - `closed` requires a recorded human decision (AI-01, FR-22);
 *  - a `result` can only exist once intake is complete (FR-08).
 */
const assessmentSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    requestorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Opaque hash of the issuing application session for public-demo visitor isolation. Hidden
    // from ordinary queries and API views; standard/seeded assessments leave it absent.
    publicDemoSessionTag: { type: String, select: false },
    departmentId: { type: Schema.Types.ObjectId, ref: 'Department' },
    status: { type: String, enum: ASSESSMENT_STATUSES, default: 'in_progress', index: true },
    phase: { type: String, enum: ['persona', 'describe', 'questions', 'done'], default: 'persona' },

    openingText: { type: String },
    personaKey: { type: String },
    personaSource: { type: String, enum: ['user', 'ai'] },
    personaCandidates: { type: [String], default: [] }, // shown when inference is not confident (FR-04)
    scenarioKey: { type: String },
    scenarioSource: { type: String, enum: ['ai', 'default'] },
    sector: { type: String },

    versions: {
      contentTenantId: { type: Schema.Types.ObjectId },
      persona: { type: pinSchema },
      scenario: { type: pinSchema },
      questionSetHash: { type: String },
      matrix: { type: pinSchema },
      rulesHash: { type: String },
      promptVersion: { type: String },
      aiProvider: { type: String },
    },
    // Questions are edited in place; the rule list can gain/retire versions. Freeze both executable sets here.
    // Scenario and matrix documents use copy-on-write and are loaded by the version pins above (AI-04).
    pinnedContent: { type: pinnedContentSchema },

    answers: { type: [answerSchema], default: [] },
    facts: { type: [factSchema], default: [] },
    askedQuestionKeys: { type: [String], default: [] },
    queue: { type: [String], default: [] }, // pending question keys, in order (branching.ts)
    currentQuestionKey: { type: String },
    clarification: { type: String }, // one pending clarification from extraction, if any

    result: {
      score: { type: Number },
      classification: { type: String, enum: CLASSIFICATIONS },
      computedClassification: { type: String, enum: CLASSIFICATIONS },
      ruleDriven: { type: Boolean },
      ruleKey: { type: String },
      ruleName: { type: String },
      confidence: { type: Number },
      professionalConsult: { type: Boolean },
      mandatoryReview: { type: Boolean },
      explanation: { type: String },
      keyDrivers: { type: [String] },
      recommendedAction: { type: String },
      nextSteps: { type: [String] },
      factors: { type: Schema.Types.Mixed },
      computedAt: { type: Date },
    },

    decision: {
      type: { type: String, enum: DECISION_TYPES },
      byUserId: { type: Schema.Types.ObjectId, ref: 'User' },
      reason: { type: String },
      overriddenTo: { type: String, enum: CLASSIFICATIONS },
      decidedAt: { type: Date },
    },
    escalatedToUserId: { type: Schema.Types.ObjectId, ref: 'User' }, // T-061: reviewer chosen at escalation (PAID routing)

    // SEC-06 / Section 5: retention state. Flagged first (grace period), then reduced (FREE) or archived + reduced (PAID).
    retention: {
      flaggedAt: { type: Date },
      enforcedAt: { type: Date },
      auditRecordedAt: { type: Date },
      mode: { type: String, enum: ['reduced', 'archived'] },
      reason: { type: String },
    },

    timing: {
      startedAt: { type: Date, default: Date.now },
      intakeCompletedAt: { type: Date },
      submittedAt: { type: Date },
      closedAt: { type: Date },
      durationSec: { type: Number },
    },
  },
  { timestamps: true, collection: 'assessments' },
);
assessmentSchema.index({ tenantId: 1, status: 1, departmentId: 1, createdAt: -1 }); // DASH-01
assessmentSchema.index({ tenantId: 1, requestorId: 1, createdAt: -1 });
assessmentSchema.index({ tenantId: 1, publicDemoSessionTag: 1, createdAt: -1 });
assessmentSchema.index({ tenantId: 1, personaKey: 1, createdAt: -1 }); // DASH-01 persona filter
assessmentSchema.index({ tenantId: 1, 'result.classification': 1, createdAt: -1 }); // DASH-01 classification filter
assessmentSchema.index({ tenantId: 1, escalatedToUserId: 1, status: 1 }); // T-061 "escalated to me"
assessmentSchema.index({ tenantId: 1, 'result.mandatoryReview': 1, status: 1 }); // AI-03 mandatory-review queue
assessmentSchema.index({ tenantId: 1, createdAt: 1, 'retention.enforcedAt': 1 }); // SEC-06 retention sweep

assessmentSchema.pre('validate', function (next) {
  if (this.status === 'closed' && !(this.decision && this.decision.type && this.decision.byUserId)) {
    return next(new Error('AI-01: an assessment cannot be closed without a recorded human decision'));
  }
  if (this.result && this.result.computedAt && (this.status === 'in_progress')) {
    return next(new Error('FR-08: a result cannot exist before intake is complete'));
  }
  next();
});

export type Assessment = InferSchemaType<typeof assessmentSchema>;
export const AssessmentModel = model('Assessment', assessmentSchema);

const messageSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    assessmentId: { type: Schema.Types.ObjectId, ref: 'Assessment', required: true, index: true },
    role: { type: String, enum: ['assistant', 'user', 'system'], required: true },
    kind: { type: String, enum: ['info', 'question', 'answer', 'clarification', 'result', 'decision'], required: true },
    content: { type: String, required: true },
    questionKey: { type: String },
    question: { type: Schema.Types.Mixed }, // snapshot of the question shown (text, type, options) for replay
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'assessmentMessages' },
);

export type AssessmentMessage = InferSchemaType<typeof messageSchema>;
export const AssessmentMessageModel = model('AssessmentMessage', messageSchema);
