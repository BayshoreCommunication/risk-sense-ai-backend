import { z } from 'zod';

/**
 * Output schemas for every product prompt (PromptGuide.md §A). OpenAI Structured Outputs run in strict
 * mode, so fields are required-or-nullable (never optional). None of these carries a score,
 * classification or recommended action — the LLM extracts and explains only (FR-08).
 */
export const InferPersonaOutput = z.object({
  personaKey: z.string().nullable(), // null = not confident enough; the user picks manually (FR-04)
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type InferPersonaOutput = z.infer<typeof InferPersonaOutput>;

export const SelectScenarioOutput = z.object({
  scenarioKey: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});
export type SelectScenarioOutput = z.infer<typeof SelectScenarioOutput>;

export const ExtractedFact = z.object({
  key: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  confidence: z.number().min(0).max(1),
  evidence: z.string(), // the words in the answer that support the value
});
export const ExtractFactsOutput = z.object({
  facts: z.array(ExtractedFact),
  clarification: z.string().nullable(), // a follow-up question when the answer did not settle the asked fact
});
export type ExtractFactsOutput = z.infer<typeof ExtractFactsOutput>;

export const ExplainOutput = z.object({
  explanation: z.string(), // ≥ 1 sentence naming the driving factors (AI-02)
  keyDrivers: z.array(z.string()),
});
export type ExplainOutput = z.infer<typeof ExplainOutput>;
