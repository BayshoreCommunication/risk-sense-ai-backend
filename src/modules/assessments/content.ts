import { Types } from 'mongoose';
import { sha256 } from '../../lib/hash';
import { PersonaModel } from '../personas/model';
import { QuestionModel } from '../questions/model';
import { ScenarioModel } from '../scenarios/model';
import { PUBLIC_TENANT_SLUG, TenantModel } from '../tenants/model';
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

/** Everything pinned at start so the assessment can always be replayed against what it actually used (AI-04). */
export async function pinVersions(tenantId: string, contentTenant: string, persona: { _id: Types.ObjectId; version: number }, scenario: { _id: Types.ObjectId; version: number; questionSetHash?: string | null; personaKey: string }, sector?: string) {
  const matrix = await scoringService.currentMatrix(contentTenant, sector);
  const rules = await rulesService.activeRules(contentTenant, sector);
  return {
    persona: { id: persona._id, version: persona.version },
    scenario: { id: scenario._id, version: scenario.version },
    questionSetHash: scenario.questionSetHash ?? undefined,
    matrix: matrix ? { id: matrix._id, version: matrix.version } : undefined,
    rulesHash: sha256(rules.map((r) => r.id).sort().join('|')),
  };
}
