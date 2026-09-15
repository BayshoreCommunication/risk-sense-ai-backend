import { describe, expect, it } from 'vitest';
import { assertLiveAiOptIn } from './live';

describe('live AI smoke guard [FR-08]', () => {
  it('refuses network use unless the operator opts in and selects OpenAI', () => {
    expect(() => assertLiveAiOptIn({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'key' })).toThrow('RUN_AI_LIVE=1');
    expect(() => assertLiveAiOptIn({ RUN_AI_LIVE: '1', AI_PROVIDER: 'mock', OPENAI_API_KEY: 'key' })).toThrow('AI_PROVIDER=openai');
    expect(() => assertLiveAiOptIn({ RUN_AI_LIVE: '1', AI_PROVIDER: 'openai' })).toThrow('OPENAI_API_KEY');
  });

  it('allows the explicitly opted-in, configured combination without exposing the key', () => {
    expect(() => assertLiveAiOptIn({ RUN_AI_LIVE: '1', AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-only-key' })).not.toThrow();
  });
});
