import { describe, expect, it } from 'vitest';
import { verifyContentSnapshot, type ContentSnapshot } from './content-verify';

const checkedAt = new Date('2026-09-14T00:00:00.000Z');

function readySnapshot(scenarioCount: number): ContentSnapshot {
  return {
    personas: [{ key: 'persona', sector: 'general', defaultScenarioKey: 'scenario-01' }],
    scenarios: Array.from({ length: scenarioCount }, (_, index) => ({
      key: `scenario-${String(index + 1).padStart(2, '0')}`,
      personaKey: 'persona',
      conversationFlow: [{ questionKey: 'core-question' }],
      requiredFactKeys: ['core_fact', 'branch_fact'],
    })),
    questions: [
      { key: 'core-question', factKey: 'core_fact', branchQuestionKeys: ['branch-question'] },
      { key: 'branch-question', factKey: 'branch_fact', branchQuestionKeys: [] },
    ],
    matrices: [{ key: 'default', approvedBy: 'reviewer', approvedAt: checkedAt, changeRef: 'MATRIX-1' }],
    rules: [{ key: 'global-rule', sectors: [], approvedBy: 'reviewer', approvedAt: checkedAt, changeRef: 'RULE-1' }],
    goldenCases: [{ name: 'synthetic boundary case', facts: {}, expect: { classification: 'monitor_only' } }],
  };
}

describe('content release gate [FR-11, FR-12, FR-18, AI-05]', () => {
  it.each([15, 25])('accepts the inclusive scenario boundary of %i when all Must gates pass [FR-11]', (count) => {
    const report = verifyContentSnapshot(readySnapshot(count), {
      tenantId: 'tenant-id',
      tenantSlug: 'tenant',
      checkedAt,
    });

    expect(report).toMatchObject({
      ok: true,
      checkedAt: checkedAt.toISOString(),
      counts: { personas: 1, scenarios: count, questions: 2, matrices: 1, rules: 1, goldenCases: 1 },
      personas: [
        {
          key: 'persona',
          scenarios: { count, ok: true },
          defaultScenario: { key: 'scenario-01', ok: true },
          linksOk: true,
          matrix: { key: 'default', approved: true, ok: true },
          rules: { applicable: 1, approved: 1, ok: true },
          goldenCasesAvailable: true,
          ok: true,
        },
      ],
      issues: [],
    });
  });

  it('reports every failed Must gate without inventing or repairing content [FR-11, FR-12, FR-18, AI-05]', () => {
    const snapshot = readySnapshot(14);
    snapshot.personas[0]!.defaultScenarioKey = 'missing-default';
    snapshot.scenarios[0]!.conversationFlow = [{ questionKey: 'missing-question' }];
    snapshot.scenarios[0]!.requiredFactKeys = ['missing_fact'];
    snapshot.scenarios.push({
      key: 'orphan',
      personaKey: 'inactive-persona',
      conversationFlow: [{ questionKey: 'core-question' }],
      requiredFactKeys: ['core_fact'],
    });
    snapshot.matrices = [{ key: 'default' }];
    snapshot.rules = [{ key: 'global-rule', sectors: [] }];
    snapshot.goldenCases = [];

    const report = verifyContentSnapshot(snapshot, { tenantId: 'tenant-id', tenantSlug: 'tenant', checkedAt });
    const codes = new Set(report.issues.map((issue) => issue.code));
    expect(report.ok).toBe(false);
    expect(report.personas[0]).toMatchObject({
      scenarios: { count: 14, ok: false },
      linksOk: false,
      matrix: { approved: false, ok: false },
      rules: { applicable: 1, approved: 0, ok: false },
      goldenCasesAvailable: false,
      ok: false,
    });
    expect(codes).toEqual(
      new Set([
        'GOLDEN_CASES_MISSING',
        'ORPHAN_SCENARIO',
        'SCENARIO_COUNT_OUT_OF_RANGE',
        'DEFAULT_SCENARIO_MISSING',
        'QUESTION_LINK_MISSING',
        'REQUIRED_FACT_UNCOVERED',
        'ACTIVE_MATRIX_UNAPPROVED',
        'ACTIVE_RULE_UNAPPROVED',
      ]),
    );
  });

  it('fails above the scenario maximum and when active matrix/rule sets are absent [FR-11, FR-18]', () => {
    const snapshot = readySnapshot(26);
    snapshot.matrices = [];
    snapshot.rules = [];

    const report = verifyContentSnapshot(snapshot, { tenantId: 'tenant-id', tenantSlug: 'tenant', checkedAt });
    expect(report.ok).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['SCENARIO_COUNT_OUT_OF_RANGE', 'ACTIVE_MATRIX_MISSING', 'ACTIVE_RULE_SET_MISSING']),
    );
  });

  it('requires a configured active default without treating that configuration issue as a broken question link [FR-05]', () => {
    const snapshot = readySnapshot(15);
    snapshot.personas[0]!.defaultScenarioKey = null;

    const report = verifyContentSnapshot(snapshot, { tenantId: 'tenant-id', tenantSlug: 'tenant', checkedAt });

    expect(report.ok).toBe(false);
    expect(report.personas[0]).toMatchObject({
      defaultScenario: { key: null, ok: false },
      linksOk: true,
      ok: false,
    });
    expect(report.issues.map((issue) => issue.code)).toContain('DEFAULT_SCENARIO_NOT_CONFIGURED');
  });

  it('requires the complete approval record including its change reference [AI-05]', () => {
    const snapshot = readySnapshot(15);
    snapshot.matrices[0]!.changeRef = '   ';
    snapshot.rules[0]!.changeRef = undefined;

    const report = verifyContentSnapshot(snapshot, { tenantId: 'tenant-id', tenantSlug: 'tenant', checkedAt });

    expect(report.ok).toBe(false);
    expect(report.personas[0]).toMatchObject({
      matrix: { approved: false, ok: false },
      rules: { applicable: 1, approved: 0, ok: false },
    });
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['ACTIVE_MATRIX_UNAPPROVED', 'ACTIVE_RULE_UNAPPROVED']),
    );
  });
});
