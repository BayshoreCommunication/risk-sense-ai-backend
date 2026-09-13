/**
 * Product prompts (PromptGuide.md §A). Each prompt has a version that is pinned into
 * `assessments.versions.promptVersion` (AI-04). Keep system prompts short (latency, NFR-01).
 * Rule: never ask the model for a score, a classification or a recommended action (FR-08).
 */
export const PROMPT_VERSION = 'v1';

const BASE = `You are the intake assistant of RiskSense AI, a risk-assessment tool. You never judge how risky something is, never score, classify or recommend actions. You only help structure what the user says. Answer strictly in the requested JSON.`;

export const inferPersona = {
  version: PROMPT_VERSION,
  system: `${BASE}
Task: decide which persona (job role) the user most likely has, based on their description and each persona's detect hints. Return personaKey null if no persona is clearly better than the others (confidence below 0.6).`,
  build: (input: { text: string; personas: { key: string; name: string; description: string; detectHints: string[] }[] }) =>
    `User description:\n"""${input.text}"""\n\nPersonas:\n${input.personas
      .map((p) => `- key: ${p.key} | name: ${p.name} | hints: ${p.detectHints.join(', ')} | ${p.description}`)
      .join('\n')}`,
};

export const selectScenario = {
  version: PROMPT_VERSION,
  system: `${BASE}
Task: pick the scenario from the persona's library that best matches the described incident. Return scenarioKey null if none matches with confidence 0.5 or more.`,
  build: (input: { personaName: string; text: string; scenarios: { key: string; name: string; description: string; riskIndicators: string[] }[] }) =>
    `Persona: ${input.personaName}\nIncident description:\n"""${input.text}"""\n\nScenarios:\n${input.scenarios
      .map((s) => `- key: ${s.key} | name: ${s.name} | indicators: ${s.riskIndicators.join(', ')} | ${s.description}`)
      .join('\n')}`,
};

export const extractFacts = {
  version: PROMPT_VERSION,
  system: `${BASE}
Task: the user answered one intake question in free text. Extract the fact the question asks for. Add another listed fact ONLY if the answer states it explicitly — omit anything not stated; never output placeholders such as "unknown", "n/a" or guesses. Use exactly the listed fact keys. Booleans for yes/no facts, numbers for amounts and counts (no currency symbols), short lowercase strings otherwise. Set confidence per fact. If the answer does not settle the asked fact, return it with low confidence and propose one short clarification question.`,
  build: (input: {
    question: { key: string; text: string; factKey: string; type: string };
    answer: string;
    factCatalog: { key: string; hint: string }[];
    vocabulary: string[];
  }) =>
    `Question asked (fact key "${input.question.factKey}", type ${input.question.type}): ${input.question.text}\nUser answer:\n"""${input.answer}"""\n\nKnown fact keys:\n${input.factCatalog
      .map((f) => `- ${f.key}: ${f.hint}`)
      .join('\n')}\nDomain vocabulary: ${input.vocabulary.join(', ') || '(none)'}`,
};

export const explain = {
  version: PROMPT_VERSION,
  system: `${BASE}
Task: write a plain-language explanation (2–4 sentences, max 120 words) of a risk classification that was ALREADY computed by a deterministic engine. Name the specific facts and factors that drove it (e.g. "the amount exceeded $100,000", "controls were bypassed"). Do not change, question or re-derive the classification or score. If a hard rule fired, say which condition triggered it. Never mention internal terms such as mapping, weights, scale or points; speak about what happened and why it matters. Non-technical readers must understand the basis.`,
  build: (input: {
    classification: string;
    score: number;
    ruleDriven: boolean;
    rule: { name: string; condition: string } | null;
    factors: { key: string; value: number; weight: number; points: number; matched: string | null }[];
    facts: { key: string; value: unknown }[];
    reasoningExample: string | null;
  }) =>
    `Classification: ${input.classification} (score ${input.score}/100)${input.ruleDriven && input.rule ? `\nHard rule fired: "${input.rule.name}" because ${input.rule.condition}` : ''}\n\nFactors (value on scale, weight %, points contributed, condition that set it):\n${input.factors
      .map((f) => `- ${f.key}: ${f.value} | ${f.weight}% | ${f.points} pts | ${f.matched ?? 'nothing specific (lowest value)'}`)
      .join('\n')}\n\nFacts:\n${input.facts.map((f) => `- ${f.key} = ${JSON.stringify(f.value)}`).join('\n')}${
      input.reasoningExample ? `\n\nStyle example for this scenario:\n"""${input.reasoningExample}"""` : ''
    }`,
};
