/**
 * Explicit, billable network smoke test. It is never part of `npm test` or CI:
 * RUN_AI_LIVE=1 AI_PROVIDER=openai OPENAI_API_KEY=... npm run test:ai-live
 */
import { env } from '../config/env';
import { assertLiveAiOptIn } from '../modules/ai/live';

async function main() {
  assertLiveAiOptIn(process.env);
  const { openaiAi } = await import('../modules/ai/service');
  const allowed = ['finance_officer', 'it_support'];
  const result = await openaiAi.inferPersona({
    text: 'I manage vendor payments, reconciliations, and approval controls.',
    personas: [
      { key: 'finance_officer', name: 'Finance Officer', description: 'Finance operations and payment controls', detectHints: ['payments', 'reconciliations'] },
      { key: 'it_support', name: 'IT Support', description: 'Technical support and infrastructure', detectHints: ['server', 'network'] },
    ],
  });
  if (result.personaKey !== null && !allowed.includes(result.personaKey)) {
    throw new Error('OpenAI returned a persona key outside the supplied synthetic catalog');
  }
  console.log(
    JSON.stringify({
      ok: true,
      provider: openaiAi.provider,
      model: env.OPENAI_MODEL,
      promptVersion: openaiAi.promptVersion,
      schemaValidated: true,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
