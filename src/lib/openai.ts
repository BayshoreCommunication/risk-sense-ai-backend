import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import type { ZodType } from 'zod';
import { env } from '../config/env';
import { logger } from './logger';

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!client) {
    if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
    client = new OpenAI({ apiKey: env.OPENAI_API_KEY, timeout: env.OPENAI_TIMEOUT_MS, maxRetries: 1 });
  }
  return client;
}

export interface StructuredCall<T> {
  name: string; // schema name, also used in logs
  system: string;
  user: string;
  schema: ZodType<T>;
  model?: string;
}

/**
 * One helper for every product prompt: Structured Outputs + Zod re-validation.
 * The model never gets asked for a score or a classification (FR-08) — callers pass facts/prose schemas only.
 */
export async function structured<T>(call: StructuredCall<T>): Promise<T> {
  const started = Date.now();
  const completion = await getClient().beta.chat.completions.parse({
    model: call.model ?? env.OPENAI_MODEL,
    messages: [
      { role: 'system', content: call.system },
      { role: 'user', content: call.user },
    ],
    response_format: zodResponseFormat(call.schema, call.name),
  });
  const parsed = completion.choices[0]?.message.parsed;
  logger.debug(
    { prompt: call.name, model: completion.model, latencyMs: Date.now() - started, tokens: completion.usage?.total_tokens },
    'openai structured call',
  );
  if (!parsed) throw new Error(`OpenAI returned no parsed output for ${call.name}`);
  return call.schema.parse(parsed);
}
