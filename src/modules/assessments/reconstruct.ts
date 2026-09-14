import type { Facts } from '../shared/conditions';

/**
 * FR-26: rebuild an assessment's lifecycle from its audit entries ALONE (no read of the assessment document).
 * Pure: takes the ordered entries, returns the timeline plus the state they imply. PAID tenants log full
 * payloads (`fullAudit`) so everything is recoverable; FREE tenants log the lifecycle skeleton only, and the
 * result says exactly which parts could not be rebuilt (`completeness: 'partial'`, `missing[]`).
 */
export interface AuditEntryLike {
  seq: number;
  action: string;
  actorUserId?: unknown;
  actorRole?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt?: Date | string;
}

export interface TimelineStep {
  seq: number;
  at: string | null;
  action: string;
  actor: { id: string | null; role: string | null };
  summary: string;
  detail: Record<string, unknown>;
}

export interface ReconstructedState {
  personaKey: string | null;
  personaSource: string | null;
  openingText: string | null;
  scenarioKey: string | null;
  scenarioSource: string | null;
  versions: Record<string, unknown> | null;
  answers: { questionKey: string; answer: unknown; branched: string[] | number }[];
  facts: Facts;
  rules: { fired: unknown[]; winner: string | null } | null;
  score: number | null;
  computedClassification: string | null;
  factors: Record<string, unknown> | null;
  classification: string | null;
  ruleDriven: boolean | null;
  confidence: number | null;
  recommendedAction: string | null;
  explanation: string | null;
  decisions: { type: string; overriddenTo: string | null; escalatedToUserId: string | null; reason: string | null; byUserId: string | null; at: string | null }[];
  status: 'in_progress' | 'awaiting_decision' | 'escalated' | 'closed' | 'error_review' | 'unknown';
}

export interface Reconstruction {
  timeline: TimelineStep[];
  state: ReconstructedState;
  completeness: 'full' | 'partial' | 'empty';
  missing: string[];
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : v == null ? null : String(v));
const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
const iso = (d: unknown): string | null => (d instanceof Date ? d.toISOString() : typeof d === 'string' ? d : null);

export function reconstruct(entries: AuditEntryLike[]): Reconstruction {
  const state: ReconstructedState = {
    personaKey: null, personaSource: null, openingText: null, scenarioKey: null, scenarioSource: null, versions: null,
    answers: [], facts: {}, rules: null, score: null, computedClassification: null, factors: null,
    classification: null, ruleDriven: null, confidence: null, recommendedAction: null, explanation: null,
    decisions: [], status: 'unknown',
  };
  const missing = new Set<string>();
  const timeline: TimelineStep[] = [];
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);

  for (const e of sorted) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const step: TimelineStep = { seq: e.seq, at: iso(e.createdAt), action: e.action, actor: { id: e.actorUserId ? String(e.actorUserId) : null, role: e.actorRole ?? null }, summary: e.action, detail: p };
    switch (e.action) {
      case 'assessment.started':
        state.status = 'in_progress';
        state.personaKey = str(p.personaKey);
        state.personaSource = str(p.personaSource);
        if ('openingText' in p) state.openingText = str(p.openingText);
        else missing.add('openingText');
        step.summary = state.personaKey ? `Started as ${state.personaKey} (${state.personaSource ?? 'unknown source'})` : 'Started; persona to be chosen';
        break;
      case 'assessment.persona_set':
        state.personaKey = str(p.personaKey);
        state.personaSource = 'user';
        step.summary = `Persona set to ${state.personaKey}`;
        break;
      case 'assessment.scenario_selected':
        state.scenarioKey = str(p.scenarioKey);
        state.scenarioSource = str(p.source);
        state.versions = (p.versions as Record<string, unknown>) ?? null;
        step.summary = `Scenario ${state.scenarioKey} (${state.scenarioSource}${typeof p.confidence === 'number' ? `, confidence ${p.confidence}` : ''})`;
        break;
      case 'assessment.answered': {
        const questionKey = str(p.questionKey) ?? '?';
        const full = 'answer' in p || Array.isArray(p.facts);
        if (full) {
          for (const f of (p.facts as { key: string; value: unknown }[]) ?? []) state.facts[f.key] = f.value as never;
          state.answers.push({ questionKey, answer: p.answer, branched: (p.branched as string[]) ?? [] });
          step.summary = `Answered ${questionKey}: ${JSON.stringify(p.answer)}`;
        } else {
          state.answers.push({ questionKey, answer: undefined, branched: num(p.branched) ?? 0 });
          missing.add('answers');
          missing.add('facts');
          step.summary = `Answered ${questionKey} (answer not logged on this plan)`;
        }
        break;
      }
      case 'assessment.rules_evaluated':
        if (Array.isArray(p.fired)) {
          state.rules = { fired: p.fired, winner: str(p.winner) };
          step.summary = state.rules.winner ? `Hard rule fired: ${state.rules.winner}` : `Rules evaluated, none fired`;
        } else {
          state.rules = { fired: [], winner: null };
          missing.add('rules');
          step.summary = `Rules evaluated (${num(p.fired) ?? 0} fired; details not logged on this plan)`;
        }
        break;
      case 'assessment.scored':
        state.score = num(p.score);
        state.computedClassification = str(p.computedClassification ?? p.classification);
        if (p.factors && typeof p.factors === 'object') state.factors = p.factors as Record<string, unknown>;
        else missing.add('factors');
        step.summary = `Scored ${state.score} → ${state.computedClassification}`;
        break;
      case 'assessment.recommended':
        state.classification = str(p.classification);
        state.confidence = num(p.confidence);
        if ('ruleDriven' in p) state.ruleDriven = Boolean(p.ruleDriven);
        if ('recommendedAction' in p) state.recommendedAction = str(p.recommendedAction);
        else missing.add('recommendedAction');
        if ('explanation' in p) state.explanation = str(p.explanation);
        else missing.add('explanation');
        state.status = state.score === 0 ? 'error_review' : 'awaiting_decision';
        step.summary = `Recommended ${state.classification} (confidence ${state.confidence}%${state.ruleDriven ? ', rule-driven' : ''})`;
        break;
      case 'decision.recorded': {
        const d = { type: str(p.type) ?? 'unknown', overriddenTo: str(p.overriddenTo), escalatedToUserId: str(p.escalatedToUserId), reason: 'reason' in p ? str(p.reason) : null, byUserId: step.actor.id, at: step.at };
        if (!('reason' in p)) missing.add('decisionReason');
        state.decisions.push(d);
        state.status = d.type === 'escalate' ? 'escalated' : 'closed';
        step.summary = d.type === 'escalate' ? `Escalated${d.escalatedToUserId ? ` to user ${d.escalatedToUserId}` : ''}` : d.type === 'override' ? `Overridden to ${d.overriddenTo}` : 'Accepted the recommendation';
        break;
      }
      default:
        step.summary = e.action;
    }
    timeline.push(step);
  }
  const completeness = sorted.length === 0 ? 'empty' : missing.size ? 'partial' : 'full';
  return { timeline, state, completeness, missing: [...missing].sort() };
}
