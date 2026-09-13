import { Schema, model, type InferSchemaType } from 'mongoose';
import { versionedFields } from '../../lib/versioned';

export const FACTOR_KEYS = ['controlEffectiveness', 'impact', 'severity', 'likelihood', 'duration', 'regulatorySensitivity'] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];

/**
 * Scoring matrix (FR-18, FR-19): weights, scales, fact→factor mappings, thresholds, confidence policy.
 * Versioned copy-on-write like personas, plus an approval record before activation (AI-05).
 */
const mappingSchema = new Schema({ when: { type: Schema.Types.Mixed, required: true }, value: { type: Number, required: true } }, { _id: false });
const factorSchema = new Schema(
  {
    weight: { type: Number, required: true, min: 0, max: 100 }, // percent; all six sum to 100
    scale: { min: { type: Number, default: 1 }, max: { type: Number, default: 5 } },
    mapping: { type: [mappingSchema], default: [] }, // first match wins; else scale.min
  },
  { _id: false },
);
const rangeSchema = new Schema({ min: { type: Number, required: true }, max: { type: Number, required: true } }, { _id: false });

const scoringMatrixSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    key: { type: String, required: true, trim: true, lowercase: true }, // e.g. "default", "healthcare"
    name: { type: String, required: true },
    sector: { type: String }, // optional: matrix applies to this sector; "default" has none
    formula: { type: String, enum: ['weighted_sum'], default: 'weighted_sum' },
    factors: {
      controlEffectiveness: { type: factorSchema, required: true },
      impact: { type: factorSchema, required: true },
      severity: { type: factorSchema, required: true },
      likelihood: { type: factorSchema, required: true },
      duration: { type: factorSchema, required: true },
      regulatorySensitivity: { type: factorSchema, required: true },
    },
    thresholds: {
      monitor_only: { type: rangeSchema, required: true },
      risk: { type: rangeSchema, required: true },
      elevated_risk: { type: rangeSchema, required: true },
      issue: { type: rangeSchema, required: true },
    },
    confidence: {
      professionalConsultBelow: { type: Number, default: 60 }, // FR-20
      mandatoryReviewBelow: { type: Number, default: 40 }, // AI-03 flag
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' }, // AI-05 change control
    approvedAt: { type: Date },
    changeRef: { type: String },
    ...versionedFields,
  },
  { timestamps: true, collection: 'scoringMatrices' },
);
scoringMatrixSchema.index({ tenantId: 1, key: 1, isCurrent: 1 });
scoringMatrixSchema.index({ tenantId: 1, versionGroupId: 1, version: 1 }, { unique: true });

export type ScoringMatrix = InferSchemaType<typeof scoringMatrixSchema>;
export const ScoringMatrixModel = model('ScoringMatrix', scoringMatrixSchema);
