import { describe, expect, it } from 'vitest';
import { applyBranch, initialQueue, missingRequired, nextQuestion, structuredValue, type QuestionLite } from './branching';

const q = (key: string, type: QuestionLite['type'], factKey: string, extra: Partial<QuestionLite> = {}): QuestionLite => ({
  key,
  text: key,
  type,
  factKey,
  required: true,
  options: [],
  branchTrigger: null,
  ...extra,
});

const questions = new Map<string, QuestionLite>(
  [
    q('q1', 'free_text', 'process'),
    q('q_fraud', 'yes_no', 'fraud_suspected', { branchTrigger: { onValue: 'yes', questionKeys: ['q_fraud_a', 'q_fraud_b'] } }),
    q('q_fraud_a', 'mcq', 'fraud_confirmed', { options: [{ id: 'confirmed', label: 'Confirmed', factValue: 'confirmed' }, { id: 'suspected', label: 'Suspected', factValue: 'suspected' }] }),
    q('q_fraud_b', 'yes_no', 'account_frozen'),
    q('q_status', 'mcq', 'incident_status', { options: [{ id: 'active', label: 'Active', factValue: 'active' }] }),
    q('q_gated', 'number', 'exposure'),
  ].map((x) => [x.key, x]),
);
const flow = [{ questionKey: 'q1' }, { questionKey: 'q_fraud' }, { questionKey: 'q_status' }, { questionKey: 'q_gated', showIf: { factKey: 'fraud_suspected', equals: true } }];

describe('branching (FR-07, FR-03, FR-06)', () => {
  it('walks the flow in order and skips asked questions', () => {
    let queue = initialQueue(flow);
    const a = nextQuestion({ queue, asked: [], flow, facts: {}, questions });
    expect(a.question?.key).toBe('q1');
    queue = a.queue;
    const b = nextQuestion({ queue, asked: ['q1'], flow, facts: {}, questions });
    expect(b.question?.key).toBe('q_fraud');
  });

  it.each([
    ['yes', true, ['q_fraud_a', 'q_fraud_b']],
    [true, true, ['q_fraud_a', 'q_fraud_b']],
    ['no', false, []],
    [false, false, []],
  ])('branch fires for %s → %s [FR-07]', (value, fires, expected) => {
    const { queue, branched } = applyBranch({ question: questions.get('q_fraud')!, value, queue: ['q_status'], asked: ['q1', 'q_fraud'] });
    expect(branched).toEqual(expected);
    expect(fires ? queue.slice(0, 2) : queue).toEqual(fires ? expected : ['q_status']);
  });

  it('branch follow-ups are asked immediately, before the rest of the flow', () => {
    const { queue } = applyBranch({ question: questions.get('q_fraud')!, value: 'yes', queue: ['q_status', 'q_gated'], asked: ['q1', 'q_fraud'] });
    const n = nextQuestion({ queue, asked: ['q1', 'q_fraud'], flow, facts: { fraud_suspected: true }, questions });
    expect(n.question?.key).toBe('q_fraud_a');
  });

  it('showIf gates a flow question on a captured fact', () => {
    const withoutFact = nextQuestion({ queue: ['q_gated'], asked: [], flow, facts: { fraud_suspected: false }, questions });
    expect(withoutFact.question).toBeNull();
    const withFact = nextQuestion({ queue: ['q_gated'], asked: [], flow, facts: { fraud_suspected: true }, questions });
    expect(withFact.question?.key).toBe('q_gated');
  });

  it('does not re-branch to questions already asked', () => {
    const { branched } = applyBranch({ question: questions.get('q_fraud')!, value: 'yes', queue: [], asked: ['q_fraud_a'] });
    expect(branched).toEqual(['q_fraud_b']);
  });

  it('missingRequired lists facts not yet captured [FR-03]', () => {
    expect(missingRequired(['process', 'fraud_suspected', 'incident_status'], { process: 'x', fraud_suspected: false })).toEqual(['incident_status']);
  });

  it('structuredValue coerces mcq / yes_no / number and rejects invalid input [FR-06]', () => {
    expect(structuredValue(questions.get('q_fraud_a')!, 'confirmed')).toEqual({ ok: true, value: 'confirmed' });
    expect(structuredValue(questions.get('q_fraud_a')!, 'nope').ok).toBe(false);
    expect(structuredValue(questions.get('q_fraud')!, 'Yes')).toEqual({ ok: true, value: true });
    expect(structuredValue(questions.get('q_fraud')!, 'maybe').ok).toBe(false);
    expect(structuredValue(questions.get('q_gated')!, '$12,500')).toEqual({ ok: true, value: 12500 });
  });
});
