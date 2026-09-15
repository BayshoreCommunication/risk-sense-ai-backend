import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { PersonaModel } from '../personas/model';
import { QuestionModel } from '../questions/model';
import { RuleModel } from '../rules/model';
import { ScenarioModel } from '../scenarios/model';
import { CLASSIFICATIONS } from '../shared/enums';
import { ScoringMatrixModel } from '../scoring/model';

const MIN_SCENARIOS = 15;
const MAX_SCENARIOS = 25;

const GoldenCase = z.object({
  name: z.string().min(1),
  facts: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  requiredFactKeys: z.array(z.string()).optional(),
  expect: z.object({
    classification: z.enum(CLASSIFICATIONS),
    ruleDriven: z.boolean().optional(),
    minScore: z.number().min(0).max(100).optional(),
    maxScore: z.number().min(0).max(100).optional(),
  }),
});
const GoldenCases = z.array(GoldenCase).min(1);

export interface ContentSnapshot {
  personas: Array<{ key: string; sector: string; defaultScenarioKey?: string | null }>;
  scenarios: Array<{
    key: string;
    personaKey: string;
    conversationFlow: Array<{ questionKey: string }>;
    requiredFactKeys: string[];
  }>;
  questions: Array<{ key: string; factKey: string; branchQuestionKeys: string[] }>;
  matrices: Array<{
    key: string;
    sector?: string | null;
    approvedBy?: string;
    approvedAt?: Date | null;
    changeRef?: string | null;
  }>;
  rules: Array<{
    key: string;
    sectors: string[];
    approvedBy?: string;
    approvedAt?: Date | null;
    changeRef?: string | null;
  }>;
  goldenCases: unknown;
}

export interface ContentGateIssue {
  code: string;
  requirement: string;
  message: string;
  personaKey?: string;
  scenarioKey?: string;
  questionKey?: string;
}

export interface PersonaContentReport {
  key: string;
  sector: string;
  scenarios: { count: number; expected: { min: number; max: number }; ok: boolean };
  defaultScenario: { key: string | null; ok: boolean };
  linksOk: boolean;
  matrix: { key: string | null; approved: boolean; ok: boolean };
  rules: { applicable: number; approved: number; ok: boolean };
  goldenCasesAvailable: boolean;
  ok: boolean;
}

export interface ContentVerificationReport {
  tenantId: string;
  tenantSlug: string;
  checkedAt: string;
  ok: boolean;
  counts: { personas: number; scenarios: number; questions: number; matrices: number; rules: number; goldenCases: number };
  personas: PersonaContentReport[];
  issues: ContentGateIssue[];
}

export function loadGoldenCases(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** Pure release-gate evaluation, separated from reads so edge cases stay cheap to test. */
export function verifyContentSnapshot(
  snapshot: ContentSnapshot,
  context: { tenantId: string; tenantSlug: string; checkedAt?: Date },
): ContentVerificationReport {
  const issues: ContentGateIssue[] = [];
  const golden = GoldenCases.safeParse(snapshot.goldenCases);
  const goldenCount = golden.success ? golden.data.length : 0;
  if (!golden.success) {
    issues.push({
      code: golden.error.issues.some((issue) => issue.code === 'too_small') ? 'GOLDEN_CASES_MISSING' : 'GOLDEN_CASE_INVALID',
      requirement: 'FR-18',
      message: golden.error.issues.map((issue) => `${issue.path.join('.') || 'goldenCases'}: ${issue.message}`).join('; '),
    });
  }
  if (snapshot.personas.length === 0) {
    issues.push({ code: 'NO_ACTIVE_PERSONAS', requirement: 'FR-09/FR-11', message: 'No active personas are available to verify' });
  }

  const questions = new Map(snapshot.questions.map((question) => [question.key, question]));
  const personaKeys = new Set(snapshot.personas.map((persona) => persona.key));
  const personaReports: PersonaContentReport[] = [];

  for (const scenario of snapshot.scenarios) {
    if (!personaKeys.has(scenario.personaKey)) {
      issues.push({
        code: 'ORPHAN_SCENARIO',
        requirement: 'FR-11',
        message: `Active scenario "${scenario.key}" references inactive/missing persona "${scenario.personaKey}"`,
        scenarioKey: scenario.key,
      });
    }
  }

  for (const persona of [...snapshot.personas].sort((a, b) => a.key.localeCompare(b.key))) {
    const before = issues.length;
    const scenarios = snapshot.scenarios.filter((scenario) => scenario.personaKey === persona.key);
    const countOk = scenarios.length >= MIN_SCENARIOS && scenarios.length <= MAX_SCENARIOS;
    if (!countOk) {
      issues.push({
        code: 'SCENARIO_COUNT_OUT_OF_RANGE',
        requirement: 'FR-11',
        message: `Persona "${persona.key}" has ${scenarios.length} active scenarios; expected ${MIN_SCENARIOS}–${MAX_SCENARIOS}`,
        personaKey: persona.key,
      });
    }
    const defaultScenarioKey = persona.defaultScenarioKey?.trim() || null;
    const defaultScenarioOk = Boolean(defaultScenarioKey && scenarios.some((scenario) => scenario.key === defaultScenarioKey));
    if (!defaultScenarioKey) {
      issues.push({
        code: 'DEFAULT_SCENARIO_NOT_CONFIGURED',
        requirement: 'FR-05',
        message: `Persona "${persona.key}" has no default scenario configured`,
        personaKey: persona.key,
      });
    } else if (!defaultScenarioOk) {
      issues.push({
        code: 'DEFAULT_SCENARIO_MISSING',
        requirement: 'FR-05',
        message: `Persona "${persona.key}" default scenario "${defaultScenarioKey}" is not active for that persona`,
        personaKey: persona.key,
        scenarioKey: defaultScenarioKey,
      });
    }

    for (const scenario of scenarios) verifyScenarioLinks(persona.key, scenario, questions, issues);
    const linkIssueCodes = new Set(['SCENARIO_NO_QUESTIONS', 'QUESTION_LINK_MISSING', 'REQUIRED_FACT_UNCOVERED']);
    const linksOk = !issues.slice(before).some((issue) => linkIssueCodes.has(issue.code));

    const sectorMatrix = snapshot.matrices.find((matrix) => matrix.sector === persona.sector);
    const matrix = sectorMatrix ?? snapshot.matrices.find((candidate) => candidate.key === 'default');
    const matrixApproved = Boolean(matrix?.approvedBy && matrix.approvedAt && matrix.changeRef?.trim());
    if (!matrix) {
      issues.push({
        code: 'ACTIVE_MATRIX_MISSING',
        requirement: 'FR-18/AI-05',
        message: `Persona "${persona.key}" has no active sector or default scoring matrix`,
        personaKey: persona.key,
      });
    } else if (!matrixApproved) {
      issues.push({
        code: 'ACTIVE_MATRIX_UNAPPROVED',
        requirement: 'AI-05',
        message: `Active matrix "${matrix.key}" has no complete approval record`,
        personaKey: persona.key,
      });
    }

    const applicableRules = snapshot.rules.filter((rule) => rule.sectors.length === 0 || rule.sectors.includes(persona.sector));
    const approvedRules = applicableRules.filter((rule) => rule.approvedBy && rule.approvedAt && rule.changeRef?.trim());
    if (applicableRules.length === 0) {
      issues.push({
        code: 'ACTIVE_RULE_SET_MISSING',
        requirement: 'FR-16/AI-05',
        message: `Persona "${persona.key}" has no applicable active rule set`,
        personaKey: persona.key,
      });
    } else if (approvedRules.length !== applicableRules.length) {
      issues.push({
        code: 'ACTIVE_RULE_UNAPPROVED',
        requirement: 'AI-05',
        message: `Persona "${persona.key}" has ${applicableRules.length - approvedRules.length} active rule(s) without complete approval records`,
        personaKey: persona.key,
      });
    }

    const report: PersonaContentReport = {
      key: persona.key,
      sector: persona.sector,
      scenarios: { count: scenarios.length, expected: { min: MIN_SCENARIOS, max: MAX_SCENARIOS }, ok: countOk },
      defaultScenario: { key: defaultScenarioKey, ok: defaultScenarioOk },
      linksOk,
      matrix: { key: matrix?.key ?? null, approved: matrixApproved, ok: Boolean(matrix && matrixApproved) },
      rules: { applicable: applicableRules.length, approved: approvedRules.length, ok: applicableRules.length > 0 && approvedRules.length === applicableRules.length },
      goldenCasesAvailable: golden.success,
      ok: false,
    };
    report.ok =
      report.scenarios.ok && report.defaultScenario.ok && report.linksOk && report.matrix.ok && report.rules.ok && report.goldenCasesAvailable &&
      !issues.slice(before).some((issue) => issue.personaKey === persona.key);
    personaReports.push(report);
  }

  return {
    tenantId: context.tenantId,
    tenantSlug: context.tenantSlug,
    checkedAt: (context.checkedAt ?? new Date()).toISOString(),
    ok: issues.length === 0,
    counts: {
      personas: snapshot.personas.length,
      scenarios: snapshot.scenarios.length,
      questions: snapshot.questions.length,
      matrices: snapshot.matrices.length,
      rules: snapshot.rules.length,
      goldenCases: goldenCount,
    },
    personas: personaReports,
    issues,
  };
}

export const contentVerificationService = {
  async verifyTenant(input: { tenantId: string; tenantSlug: string; goldenCases: unknown; checkedAt?: Date }) {
    const tenantId = input.tenantId;
    const [personas, scenarios, questions, matrices, rules] = await Promise.all([
      PersonaModel.find({ tenantId, isCurrent: true, status: 'active' }).select('key sector defaultScenarioKey').lean(),
      ScenarioModel.find({ tenantId, isCurrent: true, status: 'active' })
        .select('key personaKey conversationFlow requiredFactKeys')
        .lean(),
      QuestionModel.find({ tenantId, status: 'active' }).select('key factKey branchTrigger.questionKeys').lean(),
      ScoringMatrixModel.find({ tenantId, isCurrent: true, status: 'active' }).select('key sector approvedBy approvedAt changeRef').lean(),
      RuleModel.find({ tenantId, isCurrent: true, status: 'active' }).select('key sectors approvedBy approvedAt changeRef').lean(),
    ]);
    return verifyContentSnapshot(
      {
        personas: personas.map((persona) => ({ key: persona.key, sector: persona.sector, defaultScenarioKey: persona.defaultScenarioKey })),
        scenarios: scenarios.map((scenario) => ({
          key: scenario.key,
          personaKey: scenario.personaKey,
          conversationFlow: scenario.conversationFlow.map((node) => ({ questionKey: node.questionKey })),
          requiredFactKeys: [...scenario.requiredFactKeys],
        })),
        questions: questions.map((question) => ({
          key: question.key,
          factKey: question.factKey,
          branchQuestionKeys: [...(question.branchTrigger?.questionKeys ?? [])],
        })),
        matrices: matrices.map((matrix) => ({
          key: matrix.key,
          sector: matrix.sector,
          approvedBy: matrix.approvedBy ? String(matrix.approvedBy) : undefined,
          approvedAt: matrix.approvedAt,
          changeRef: matrix.changeRef,
        })),
        rules: rules.map((rule) => ({
          key: rule.key,
          sectors: [...rule.sectors],
          approvedBy: rule.approvedBy ? String(rule.approvedBy) : undefined,
          approvedAt: rule.approvedAt,
          changeRef: rule.changeRef,
        })),
        goldenCases: input.goldenCases,
      },
      input,
    );
  },
};

function verifyScenarioLinks(
  personaKey: string,
  scenario: ContentSnapshot['scenarios'][number],
  questions: Map<string, ContentSnapshot['questions'][number]>,
  issues: ContentGateIssue[],
) {
  if (scenario.conversationFlow.length === 0) {
    issues.push({
      code: 'SCENARIO_NO_QUESTIONS',
      requirement: 'FR-12',
      message: `Scenario "${scenario.key}" has no questions in its conversation flow`,
      personaKey,
      scenarioKey: scenario.key,
    });
    return;
  }
  const reachable = new Set<string>();
  const facts = new Set<string>();
  const queue = scenario.conversationFlow.map((node) => node.questionKey);
  while (queue.length) {
    const key = queue.shift()!;
    if (reachable.has(key)) continue;
    reachable.add(key);
    const question = questions.get(key);
    if (!question) {
      issues.push({
        code: 'QUESTION_LINK_MISSING',
        requirement: 'FR-12',
        message: `Scenario "${scenario.key}" references inactive/missing question "${key}"`,
        personaKey,
        scenarioKey: scenario.key,
        questionKey: key,
      });
      continue;
    }
    facts.add(question.factKey);
    queue.push(...question.branchQuestionKeys);
  }
  const missingFacts = scenario.requiredFactKeys.filter((fact) => !facts.has(fact));
  if (missingFacts.length) {
    issues.push({
      code: 'REQUIRED_FACT_UNCOVERED',
      requirement: 'FR-03',
      message: `Scenario "${scenario.key}" has required facts with no reachable active question: ${missingFacts.join(', ')}`,
      personaKey,
      scenarioKey: scenario.key,
    });
  }
}
