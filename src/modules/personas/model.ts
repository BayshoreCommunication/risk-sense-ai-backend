import { Schema, model, type InferSchemaType } from 'mongoose';
import { versionedFields } from '../../lib/versioned';
import { CONTENT_SECTORS } from '../shared/enums';

/**
 * Persona — role-based profile that drives vocabulary, scenarios and questions (BRD §5, FR-09).
 * References between content documents use stable string `key`s (not ObjectIds) so that the
 * template import (T-006) and version pinning (AI-04) stay simple. See DecisionLog 2026-09-13-16.
 */
const personaSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    key: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    sector: { type: String, enum: CONTENT_SECTORS, required: true },
    description: { type: String, required: true },
    responsibilities: { type: [String], default: [] },
    activities: { type: [String], default: [] },
    commonRisks: { type: [String], default: [] },
    vocabulary: { type: [String], default: [] },
    policies: { type: [String], default: [] },
    detectHints: { type: [String], default: [] }, // FR-04 persona inference hints
    defaultScenarioKey: { type: String, trim: true }, // FR-05 fallback
    ...versionedFields,
  },
  { timestamps: true, collection: 'personas' },
);
personaSchema.index({ tenantId: 1, key: 1, isCurrent: 1 });
personaSchema.index({ tenantId: 1, versionGroupId: 1, version: 1 }, { unique: true });

export type Persona = InferSchemaType<typeof personaSchema>;
export const PersonaModel = model('Persona', personaSchema);
