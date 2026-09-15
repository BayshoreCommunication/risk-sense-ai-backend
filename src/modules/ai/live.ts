export interface LiveAiEnvironment {
  RUN_AI_LIVE?: string;
  AI_PROVIDER?: string;
  OPENAI_API_KEY?: string;
}

/** Guard checked before any call to the OpenAI-backed service. */
export function assertLiveAiOptIn(environment: LiveAiEnvironment) {
  if (environment.RUN_AI_LIVE !== '1') {
    throw new Error('live AI smoke is opt-in: set RUN_AI_LIVE=1 explicitly');
  }
  if (environment.AI_PROVIDER !== 'openai') {
    throw new Error('live AI smoke requires AI_PROVIDER=openai');
  }
  if (!environment.OPENAI_API_KEY?.trim()) {
    throw new Error('live AI smoke requires OPENAI_API_KEY in the environment');
  }
}
