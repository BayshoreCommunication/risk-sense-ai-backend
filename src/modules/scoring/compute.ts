import { matches, type Condition, type Facts } from '../shared/conditions';
import { CLASSIFICATIONS, type Classification } from '../shared/enums';
import { evaluate, type RuleLike, type RuleResult } from '../rules/engine';
import { FACTOR_KEYS, type FactorKey } from './model';

/**
 * Pure scoring (FR-18, FR-19, FR-20, AI-03). No database, no LLM. `POST /scoring/simulate`, the
 * golden-set tests and the assessment submit path all call exactly these functions.
 */
export interface MatrixLike {
  factors: Record<FactorKey, { weight: number; scale: { min: number; max: number }; mapping: { when: Condition; value: number }[] }>;
  thresholds: Record<Classification, { min: number; max: number }>;
  confidence: { professionalConsultBelow: number; mandatoryReviewBelow: number };
}

export interface FactorTrace {
  value: number;
  matchedMapping: number | null; // index of the mapping that fired, null = scale.min default
  weight: number;
  contribution: number; // weight × normalized value, in points of the 0–100 score
}

export interface ScoreResult {
  ruleDriven: boolean;
  rule: RuleResult | null;
  score: number; // 0–100 (computed even when a rule fires, for transparency)
  factors: Record<FactorKey, FactorTrace>;
  classification: Classification;
  computedClassification: Classification; // from thresholds, before any rule override
  confidence: number; // 0–100
  professionalConsult: boolean; // FR-20
  mandatoryReview: boolean; // AI-03
  errorReview: boolean; // FR-18: score exactly 0
}

/** Each factor = first mapping whose condition matches, else the scale minimum. */
export function computeFactors(matrix: MatrixLike, facts: Facts): Record<FactorKey, FactorTrace> {
  const out = {} as Record<FactorKey, FactorTrace>;
  for (const k of FACTOR_KEYS) {
    const f = matrix.factors[k];
    let value = f.scale.min;
    let matched: number | null = null;
    for (const [i, m] of f.mapping.entries()) {
      if (matches(m.when, facts)) {
        value = m.value;
        matched = i;
        break;
      }
    }
    const normalized = (value - f.scale.min) / (f.scale.max - f.scale.min); // 0..1
    out[k] = { value, matchedMapping: matched, weight: f.weight, contribution: f.weight * normalized };
  }
  return out;
}

/** score = Σ weight_i × (value_i − min_i) / (max_i − min_i), rounded to an integer in [0, 100]. */
export function computeScore(factors: Record<FactorKey, FactorTrace>): number {
  const raw = FACTOR_KEYS.reduce((a, k) => a + factors[k].contribution, 0);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function classify(matrix: MatrixLike, score: number): Classification {
  for (const c of CLASSIFICATIONS) {
    const r = matrix.thresholds[c];
    if (score >= r.min && score <= r.max) return c;
  }
  return 'issue'; // unreachable when thresholds are contiguous (schema enforces it)
}

/**
 * Confidence (AI-03): 70 % weight on required-fact coverage, 30 % on the mean extraction confidence
 * of the facts actually present (MCQ answers are 1.0; free-text extractions carry the model's confidence).
 * Result is a percentage 0–100.
 */
export function computeConfidence(input: { facts: Facts; requiredFactKeys: string[]; factConfidences?: Record<string, number> }): number {
  const present = (k: string) => input.facts[k] !== undefined && input.facts[k] !== null && input.facts[k] !== '';
  const required = input.requiredFactKeys;
  const coverage = required.length ? required.filter(present).length / required.length : 1;
  const keys = Object.keys(input.facts).filter(present);
  const confs = keys.map((k) => input.factConfidences?.[k] ?? 1);
  const meanConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
  return Math.round((coverage * 0.7 + meanConf * 0.3) * 100);
}

export function simulate(input: {
  matrix: MatrixLike;
  rules: RuleLike[];
  facts: Facts;
  requiredFactKeys?: string[];
  factConfidences?: Record<string, number>;
}): ScoreResult {
  const factors = computeFactors(input.matrix, input.facts);
  const score = computeScore(factors);
  const computedClassification = classify(input.matrix, score);
  const rule = evaluate(input.rules, input.facts);
  const classification = rule ? rule.classification : computedClassification;
  const confidence = computeConfidence({ facts: input.facts, requiredFactKeys: input.requiredFactKeys ?? [], factConfidences: input.factConfidences });
  return {
    ruleDriven: Boolean(rule),
    rule,
    score,
    factors,
    classification,
    computedClassification,
    confidence,
    professionalConsult: confidence < input.matrix.confidence.professionalConsultBelow,
    mandatoryReview: confidence < input.matrix.confidence.mandatoryReviewBelow,
    errorReview: score === 0 && !rule,
  };
}
