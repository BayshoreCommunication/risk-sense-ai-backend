import { env, isTest } from '../../config/env';
import { logger } from '../../lib/logger';
import { structured } from '../../lib/openai';
import { normalizeValue } from '../shared/conditions';
import * as prompts from './prompts';
import { ExplainOutput, ExtractFactsOutput, InferPersonaOutput, SelectScenarioOutput } from './schemas';

/**
 * The only place that talks to the LLM. Two implementations behind one interface:
 *  - `openaiAi` — production (Structured Outputs via lib/openai)
 *  - `mockAi`   — deterministic heuristics for tests and for local dev without a key
 * Business rules never live here (Modules.md dependency direction).
 */
export interface AiService {
  inferPersona(input: Parameters<typeof prompts.inferPersona.build>[0]): Promise<InferPersonaOutput>;
  selectScenario(input: Parameters<typeof prompts.selectScenario.build>[0]): Promise<SelectScenarioOutput>;
  extractFacts(input: Parameters<typeof prompts.extractFacts.build>[0]): Promise<ExtractFactsOutput>;
  explain(input: Parameters<typeof prompts.explain.build>[0]): Promise<ExplainOutput>;
  readonly provider: 'openai' | 'mock';
  readonly promptVersion: string;
}

export const openaiAi: AiService = {
  provider: 'openai',
  promptVersion: prompts.PROMPT_VERSION,
  inferPersona: (input) => structured({ name: 'infer_persona', system: prompts.inferPersona.system, user: prompts.inferPersona.build(input), schema: InferPersonaOutput }),
  selectScenario: (input) =>
    structured({ name: 'select_scenario', system: prompts.selectScenario.system, user: prompts.selectScenario.build(input), schema: SelectScenarioOutput }),
  extractFacts: (input) => structured({ name: 'extract_facts', system: prompts.extractFacts.system, user: prompts.extractFacts.build(input), schema: ExtractFactsOutput }),
  explain: (input) => structured({ name: 'explain', system: prompts.explain.system, user: prompts.explain.build(input), schema: ExplainOutput }),
};

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const overlap = (a: Set<string>, b: string[]) => b.filter((w) => a.has(w.toLowerCase())).length;

/** Keyword heuristics — good enough to exercise every code path deterministically. */
export const mockAi: AiService = {
  provider: 'mock',
  promptVersion: prompts.PROMPT_VERSION,
  async inferPersona({ text, personas }) {
    const w = words(text);
    const scored = personas.map((p) => ({ p, hits: overlap(w, p.detectHints.flatMap((h) => h.split(/\s+/))) })).sort((a, b) => b.hits - a.hits);
    const best = scored[0];
    if (!best || best.hits === 0 || (scored[1] && scored[1].hits === best.hits)) return { personaKey: null, confidence: 0.3, reason: 'no distinctive hints' };
    return { personaKey: best.p.key, confidence: Math.min(0.95, 0.6 + best.hits * 0.1), reason: `matched hints for ${best.p.name}` };
  },
  async selectScenario({ text, scenarios }) {
    const w = words(text);
    const scored = scenarios
      .map((s) => ({ s, hits: overlap(w, [...s.name.split(/\s+/), ...s.riskIndicators.flatMap((r) => r.split(/\s+/))]) }))
      .sort((a, b) => b.hits - a.hits);
    const best = scored[0];
    if (!best || best.hits === 0) return { scenarioKey: null, confidence: 0.2, reason: 'no match' };
    return { scenarioKey: best.s.key, confidence: Math.min(0.95, 0.5 + best.hits * 0.1), reason: `matched ${best.hits} terms` };
  },
  async extractFacts({ question, answer }) {
    const trimmed = answer.trim();
    if (!trimmed) return { facts: [], clarification: `Could you answer: ${question.text}` };
    if (question.type === 'number') {
      const m = trimmed.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
      return m
        ? { facts: [{ key: question.factKey, value: Number(m[0]), confidence: 0.9, evidence: m[0] }], clarification: null }
        : { facts: [], clarification: `Please give a number for: ${question.text}` };
    }
    const norm = normalizeValue(trimmed);
    const low = trimmed.toLowerCase();
    if (question.type === 'yes_no') {
      // Negation first ("no, it was not") then affirmation; neither → ambiguous → low confidence + clarification.
      const no = /\b(no|not|never|wasn't|weren't|didn't|nope)\b/.test(low);
      const yes = /\b(yes|yeah|yep|correct|confirmed|indeed)\b/.test(low);
      if (no) return { facts: [{ key: question.factKey, value: false, confidence: 0.85, evidence: trimmed }], clarification: null };
      if (yes) return { facts: [{ key: question.factKey, value: true, confidence: 0.85, evidence: trimmed }], clarification: null };
      return { facts: [{ key: question.factKey, value: low, confidence: 0.4, evidence: trimmed }], clarification: `Is that a yes or a no? ${question.text}` };
    }
    const value = typeof norm === 'number' || typeof norm === 'boolean' ? norm : trimmed;
    return { facts: [{ key: question.factKey, value, confidence: trimmed.length > 3 ? 0.9 : 0.5, evidence: trimmed }], clarification: null };
  },
  async explain({ classification, score, ruleDriven, rule, factors }) {
    const top = [...factors].sort((a, b) => b.points - a.points).slice(0, 2);
    const drivers = top.map((f) => f.key);
    const text = ruleDriven && rule
      ? `This was classified as ${classification.replace('_', ' ')} because the hard rule "${rule.name}" fired (${rule.condition}). The computed score was ${score}/100, driven mainly by ${drivers.join(' and ')}.`
      : `This was classified as ${classification.replace('_', ' ')} with a score of ${score}/100. The main drivers were ${drivers.join(' and ')}, based on the answers provided.`;
    return { explanation: text, keyDrivers: drivers };
  },
};

let current: AiService | null = null;

/** `AI_PROVIDER=openai|mock|auto` — auto = openai when a key exists (never in tests). */
export function getAi(): AiService {
  if (current) return current;
  const wantOpenai = env.AI_PROVIDER === 'openai' || (env.AI_PROVIDER === 'auto' && Boolean(env.OPENAI_API_KEY) && !isTest);
  current = wantOpenai ? openaiAi : mockAi;
  logger.info({ provider: current.provider }, 'ai provider selected');
  return current;
}

/** Tests can swap the implementation. */
export function setAi(ai: AiService | null) {
  current = ai;
}
