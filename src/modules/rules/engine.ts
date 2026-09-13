import { matches, type Condition, type Facts } from '../shared/conditions';
import { CLASSIFICATIONS, type Classification } from '../shared/enums';

export interface RuleLike {
  id: string;
  key: string;
  name: string;
  trigger: Condition;
  forcedClassification: Classification;
  forcedAction?: string | null;
  priority: number;
}

export interface RuleResult {
  ruleId: string;
  ruleKey: string;
  ruleName: string;
  classification: Classification;
  forcedAction?: string;
  fired: { ruleId: string; ruleKey: string; classification: Classification; priority: number }[]; // every rule that matched
}

export const severityRank = (c: Classification) => CLASSIFICATIONS.indexOf(c);

/**
 * Pure rule evaluation (FR-17). Among all rules whose trigger matches: lowest `priority` wins;
 * ties → the most severe classification (DecisionLog 2026-09-13-10). Returns null when nothing fires.
 */
export function evaluate(rules: RuleLike[], facts: Facts): RuleResult | null {
  const fired = rules
    .filter((r) => matches(r.trigger, facts))
    .sort((a, b) => a.priority - b.priority || severityRank(b.forcedClassification) - severityRank(a.forcedClassification));
  const winner = fired[0];
  if (!winner) return null;
  return {
    ruleId: winner.id,
    ruleKey: winner.key,
    ruleName: winner.name,
    classification: winner.forcedClassification,
    forcedAction: winner.forcedAction ?? undefined,
    fired: fired.map((r) => ({ ruleId: r.id, ruleKey: r.key, classification: r.forcedClassification, priority: r.priority })),
  };
}
