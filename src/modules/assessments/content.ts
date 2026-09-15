import { Types } from 'mongoose';
import { AppError } from '../../lib/errors';
import { canonicalJson, sha256 } from '../../lib/hash';
import { PersonaModel } from '../personas/model';
import { QuestionModel } from '../questions/model';
import type { RuleLike } from '../rules/engine';
import { ScenarioModel } from '../scenarios/model';
import { DepartmentModel, PUBLIC_TENANT_SLUG, TenantModel } from '../tenants/model';
import type { AuthTenant, AuthUser } from '../../middleware/auth';
import { rulesService } from '../rules/service';
import { scoringService } from '../scoring/service';
import type { QuestionLite } from './branching';

/**
 * Content resolution for an intake. TAC maintains the master library in the `public` tenant; a PAID
 * tenant uses its own content only if it has activated any persona (DecisionLog 2026-09-13-20).
 */
export async function contentTenantId(tenantId: string): Promise<string> {
  const own = await PersonaModel.exists({ tenantId, isCurrent: true, status: 'active' });
  if (own) return tenantId;
  const pub = await TenantModel.findOne({ slug: PUBLIC_TENANT_SLUG }).select('_id').lean();
  return pub ? String(pub._id) : tenantId;
}

export async function activePersonas(contentTenant: string) {
  return PersonaModel.find({ tenantId: contentTenant, isCurrent: true, status: 'active' }).lean();
}

/** FR-10: a configured department mapping narrows the suggested/picker library, but an empty mapping falls back safely. */
export async function activePersonasForUser(user: AuthUser, tenant: AuthTenant, contentTenant: string) {
  const personas = await activePersonas(contentTenant);
  if (!tenant.features.departmentMapping || user.departmentIds.length === 0) return personas;
  const departments = await DepartmentModel.find({ tenantId: user.tenantId, _id: { $in: user.departmentIds } }).select('personaIds').lean();
  const mapped = new Set(departments.flatMap((department) => department.personaIds.map(String)));
  if (mapped.size === 0) return personas;
  const filtered = personas.filter((persona) => mapped.has(String(persona._id)));
  return filtered.length > 0 ? filtered : personas;
}

export async function activeScenarios(contentTenant: string, personaKey: string) {
  return ScenarioModel.find({ tenantId: contentTenant, personaKey, isCurrent: true, status: 'active' }).lean();
}

export async function scenarioByKey(contentTenant: string, key: string) {
  return ScenarioModel.findOne({ tenantId: contentTenant, key, isCurrent: true, status: 'active' }).lean();
}

/** Every active question reachable from a scenario flow (incl. branch follow-ups), keyed for branching.ts. */
export async function questionMap(contentTenant: string, flowKeys: string[]): Promise<Map<string, QuestionLite>> {
  const map = new Map<string, QuestionLite>();
  let frontier = [...new Set(flowKeys)];
  while (frontier.length) {
    const docs = await QuestionModel.find({ tenantId: contentTenant, key: { $in: frontier }, status: 'active' }).lean();
    const next: string[] = [];
    for (const d of docs) {
      if (map.has(d.key)) continue;
      map.set(d.key, {
        key: d.key,
        text: d.text,
        type: d.type as QuestionLite['type'],
        factKey: d.factKey,
        required: d.required,
        options: (d.options ?? []).map((o) => ({ id: o.id, label: o.label, factValue: o.factValue })),
        branchTrigger: d.branchTrigger?.questionKeys?.length ? { onValue: d.branchTrigger.onValue, questionKeys: d.branchTrigger.questionKeys } : null,
      });
      next.push(...(d.branchTrigger?.questionKeys ?? []).filter((k) => !map.has(k)));
    }
    frontier = [...new Set(next)];
  }
  return map;
}

const normalizedQuestion = (q: QuestionLite): QuestionLite => ({
  key: q.key,
  text: q.text,
  type: q.type,
  factKey: q.factKey,
  required: q.required,
  options: q.options.map((o) => ({ id: o.id, label: o.label, factValue: o.factValue })),
  branchTrigger: q.branchTrigger?.questionKeys?.length
    ? { onValue: q.branchTrigger.onValue, questionKeys: [...q.branchTrigger.questionKeys] }
    : null,
});

const normalizedRule = (r: RuleLike): RuleLike => ({
  id: r.id,
  key: r.key,
  name: r.name,
  trigger: r.trigger,
  forcedClassification: r.forcedClassification,
  forcedAction: r.forcedAction ?? undefined,
  priority: r.priority,
});

/** Hashes the complete executable question payload, not only its key/fact pair (AI-04). */
export function executableQuestionHash(questions: QuestionLite[]): string {
  const stable = questions.map(normalizedQuestion).sort((a, b) => a.key.localeCompare(b.key));
  return sha256(canonicalJson(stable));
}

/** Hashes every field used by deterministic rule evaluation (AI-04/FR-17). */
export function executableRulesHash(rules: RuleLike[]): string {
  const stable = rules.map(normalizedRule).sort((a, b) => a.id.localeCompare(b.id));
  return sha256(canonicalJson(stable));
}

/** Rebuild the runtime map and reject missing/tampered legacy snapshots instead of silently using live content. */
export function restorePinnedQuestions(raw: unknown, expectedHash?: string | null): Map<string, QuestionLite> {
  const questions = Array.isArray(raw) ? raw.map((q) => normalizedQuestion(q as QuestionLite)).sort((a, b) => a.key.localeCompare(b.key)) : [];
  if (!expectedHash || questions.length === 0) throw new AppError('CONFLICT', 'assessment has no immutable question snapshot; restart the intake');
  if (executableQuestionHash(questions) !== expectedHash) throw new AppError('CONFLICT', 'pinned question content failed its integrity check');
  return new Map(questions.map((q) => [q.key, q]));
}

/** Rebuild the exact active-rule set from scenario-selection time and verify its content-complete hash. */
export function restorePinnedRules(raw: unknown, expectedHash?: string | null): RuleLike[] {
  const rules = Array.isArray(raw) ? raw.map((r) => normalizedRule(r as RuleLike)).sort((a, b) => a.id.localeCompare(b.id)) : [];
  if (!expectedHash) throw new AppError('CONFLICT', 'assessment has no immutable rule snapshot; restart the intake');
  if (executableRulesHash(rules) !== expectedHash) throw new AppError('CONFLICT', 'pinned rule content failed its integrity check');
  return rules;
}

export interface PinnedExecutionContent {
  personaVocabulary: string[];
  questions: QuestionLite[];
  rules: RuleLike[];
}

/**
 * Freeze every mutable execution input when the scenario is selected. Scenario and matrix use their
 * copy-on-write document versions; questions and the exact active-rule set are embedded for stable execution.
 */
export async function pinVersions(
  contentTenant: string,
  persona: { _id: Types.ObjectId; version: number; vocabulary?: string[] | null },
  scenario: { _id: Types.ObjectId; version: number; conversationFlow: { questionKey: string }[] },
  sector?: string,
) {
  const questionsByKey = await questionMap(contentTenant, scenario.conversationFlow.map((n) => n.questionKey));
  const questions = [...questionsByKey.values()].map(normalizedQuestion).sort((a, b) => a.key.localeCompare(b.key));
  const referenced = new Set([
    ...scenario.conversationFlow.map((n) => n.questionKey),
    ...questions.flatMap((q) => q.branchTrigger?.questionKeys ?? []),
  ]);
  const missing = [...referenced].filter((key) => !questionsByKey.has(key));
  if (missing.length) throw new AppError('CONFLICT', `scenario content changed before it could be pinned; missing questions: ${missing.join(', ')}`, { missing });

  const matrix = await scoringService.currentMatrix(contentTenant, sector);
  if (!matrix) throw new AppError('CONFLICT', 'no active scoring matrix is available to pin for this assessment');
  const rules = (await rulesService.activeRules(contentTenant, sector)).map(normalizedRule).sort((a, b) => a.id.localeCompare(b.id));
  return {
    versions: {
      contentTenantId: new Types.ObjectId(contentTenant),
      persona: { id: persona._id, version: persona.version },
      scenario: { id: scenario._id, version: scenario.version },
      questionSetHash: executableQuestionHash(questions),
      matrix: { id: matrix._id, version: matrix.version },
      rulesHash: executableRulesHash(rules),
    },
    pinnedContent: {
      personaVocabulary: [...(persona.vocabulary ?? [])],
      questions,
      rules,
    } satisfies PinnedExecutionContent,
  };
}
