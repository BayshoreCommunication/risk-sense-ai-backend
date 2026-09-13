import { matches, normalizeValue, type Facts } from '../shared/conditions';

/**
 * Deterministic conversation flow (FR-07). No LLM here: which question comes next is a function of
 * the scenario flow, the branch triggers on questions, and the facts captured so far.
 */
export interface FlowNode {
  questionKey: string;
  showIf?: { factKey: string; equals: unknown } | null;
}
export interface QuestionLite {
  key: string;
  text: string;
  type: 'mcq' | 'yes_no' | 'free_text' | 'number';
  factKey: string;
  required: boolean;
  options: { id: string; label: string; factValue: unknown }[];
  branchTrigger?: { onValue: unknown; questionKeys: string[] } | null;
}

/** The queue at the start of an intake is the scenario flow in order. */
export function initialQueue(flow: FlowNode[]): string[] {
  return flow.map((n) => n.questionKey);
}

/**
 * Pops the next askable question: skips already-asked keys and nodes whose `showIf` is not satisfied.
 * Returns the remaining queue so the caller can persist it.
 */
export function nextQuestion(input: { queue: string[]; asked: string[]; flow: FlowNode[]; facts: Facts; questions: Map<string, QuestionLite> }): {
  question: QuestionLite | null;
  queue: string[];
} {
  const queue = [...input.queue];
  const gate = new Map(input.flow.filter((n) => n.showIf).map((n) => [n.questionKey, n.showIf!]));
  while (queue.length) {
    const key = queue.shift()!;
    if (input.asked.includes(key)) continue;
    const q = input.questions.get(key);
    if (!q) continue; // retired since the flow was pinned; skipped, not fatal
    const g = gate.get(key);
    if (g && !matches({ factKey: g.factKey, op: 'eq', value: g.equals as never }, input.facts)) continue;
    return { question: q, queue };
  }
  return { question: null, queue };
}

/**
 * After a question is answered: if its branch trigger matches the answer, its follow-ups are inserted
 * at the FRONT of the queue (asked immediately, FR-07 "fires 100 % of the time"), skipping any already asked.
 */
export function applyBranch(input: { question: QuestionLite; value: unknown; queue: string[]; asked: string[] }): { queue: string[]; branched: string[] } {
  const t = input.question.branchTrigger;
  if (!t || !t.questionKeys.length) return { queue: input.queue, branched: [] };
  if (normalizeValue(input.value as never) !== normalizeValue(t.onValue as never)) return { queue: input.queue, branched: [] };
  const branched = t.questionKeys.filter((k) => !input.asked.includes(k) && !input.queue.includes(k));
  return { queue: [...branched, ...input.queue], branched };
}

/** Required facts (FR-03) not yet captured. */
export function missingRequired(requiredFactKeys: string[], facts: Facts): string[] {
  return requiredFactKeys.filter((k) => facts[k] === undefined || facts[k] === null || facts[k] === '');
}

/** Turns a raw answer into the fact value for non-free-text questions (FR-06: 100 % of MCQ answers → structured). */
export function structuredValue(q: QuestionLite, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (q.type === 'mcq') {
    const opt = q.options.find((o) => o.id === value || o.factValue === value || o.label === value);
    return opt ? { ok: true, value: opt.factValue } : { ok: false, error: `choose one of: ${q.options.map((o) => o.id).join(', ')}` };
  }
  if (q.type === 'yes_no') {
    const n = normalizeValue(value as never);
    return typeof n === 'boolean' ? { ok: true, value: n } : { ok: false, error: 'answer yes or no' };
  }
  if (q.type === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'answer with a number' };
  }
  return { ok: true, value };
}
