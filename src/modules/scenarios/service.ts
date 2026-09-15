import type { z } from 'zod';
import { AppError } from '../../lib/errors';
import { canonicalJson, sha256 } from '../../lib/hash';
import { versioned, type VersionedDoc } from '../../lib/versioned';
import type { AuthUser } from '../../middleware/auth';
import { personasService } from '../personas/service';
import { questionsService } from '../questions/service';
import { ScenarioModel } from './model';
import type { ScenarioBody, ScenarioListQuery } from './schema';

/**
 * Activation gate (FR-12, FR-03, FR-05): a scenario may only go live when
 *  - its persona has an active version,
 *  - every question in the flow (and every branch target) exists and is active — at least one (FR-12),
 *  - every requiredFactKey is produced by some question reachable from the flow.
 * The reachable question set is hashed into `questionSetHash` so assessments can pin it (AI-04).
 */
async function validateForActivation(doc: VersionedDoc) {
  const tenantId = String(doc.tenantId);
  const persona = await personasService.currentByKey(tenantId, doc.personaKey);
  if (!persona) throw new AppError('VALIDATION_ERROR', `persona "${doc.personaKey}" has no active version`, { personaKey: doc.personaKey });

  const flowKeys = (doc.conversationFlow as { questionKey: string }[]).map((n) => n.questionKey);
  if (flowKeys.length === 0) throw new AppError('NO_LINKED_QUESTIONS', 'scenario has no questions in its conversation flow (FR-12)');

  // Walk branches transitively so follow-up questions count as reachable.
  const reachable = new Map<
    string,
    {
      key: string;
      text: string;
      type: string;
      factKey: string;
      required: boolean;
      options: { id: string; label: string; factValue: unknown }[];
      branchTrigger: { onValue: unknown; questionKeys: string[] } | null;
    }
  >();
  let frontier = [...new Set(flowKeys)];
  while (frontier.length) {
    const found = await questionsService.activeByKeys(tenantId, frontier);
    const missing = frontier.filter((k) => !found.some((q) => q.key === k));
    if (missing.length) throw new AppError('NO_LINKED_QUESTIONS', `questions not found or retired: ${missing.join(', ')}`, { missing });
    const next: string[] = [];
    for (const q of found) {
      if (reachable.has(q.key)) continue;
      const branchKeys = q.branchTrigger?.questionKeys ?? [];
      reachable.set(q.key, {
        key: q.key,
        text: q.text,
        type: q.type,
        factKey: q.factKey,
        required: q.required,
        options: (q.options ?? []).map((o) => ({ id: o.id, label: o.label, factValue: o.factValue })),
        branchTrigger: branchKeys.length ? { onValue: q.branchTrigger?.onValue, questionKeys: [...branchKeys] } : null,
      });
      next.push(...branchKeys.filter((k) => !reachable.has(k)));
    }
    frontier = [...new Set(next)];
  }

  const producedFacts = new Set([...reachable.values()].map((r) => r.factKey));
  const uncovered = (doc.requiredFactKeys as string[]).filter((f) => !producedFacts.has(f));
  if (uncovered.length) {
    throw new AppError('VALIDATION_ERROR', `required facts have no question producing them: ${uncovered.join(', ')}`, { uncovered });
  }

  const pinned = [...reachable.values()].sort((a, b) => a.key.localeCompare(b.key));
  doc.questionSetHash = sha256(canonicalJson(pinned));
}

const v = versioned(ScenarioModel, {
  entityType: 'scenario',
  immutable: ['key', 'personaKey'],
  validateForActivation,
});

export const scenariosService = {
  list(tenantId: string, q: z.infer<typeof ScenarioListQuery>, isAdmin: boolean) {
    const filter: Record<string, unknown> = { tenantId };
    if (q.personaKey) filter.personaKey = q.personaKey;
    if (q.key) filter.key = q.key;
    const view = q.view ?? (isAdmin ? 'all' : 'current');
    if (view === 'current') {
      filter.isCurrent = true;
      filter.status = 'active';
    } else if (q.status) {
      filter.status = q.status;
    }
    return ScenarioModel.find(filter).sort({ personaKey: 1, key: 1, version: -1 }).lean();
  },
  get: (tenantId: string, id: string) => v.load(tenantId, id),
  async create(tenantId: string, body: ScenarioBody, actor: AuthUser) {
    // Persona must exist in some version (draft is fine) so typos are caught early; activation checks it is active.
    const anyPersona = await personasService.list(tenantId, { key: body.personaKey, view: 'all' }, true);
    if (anyPersona.length === 0) throw new AppError('VALIDATION_ERROR', `persona "${body.personaKey}" does not exist`);
    return v.createDraft(tenantId, body, actor);
  },
  update: (tenantId: string, id: string, patch: Partial<ScenarioBody>, actor: AuthUser) => v.updateAsNewVersion(tenantId, id, patch, actor),
  activate: (tenantId: string, id: string, actor: AuthUser) => v.activate(tenantId, id, actor),
  deactivate: (tenantId: string, id: string, actor: AuthUser) => v.deactivate(tenantId, id, actor),
  history: (tenantId: string, groupId: string) => v.history(tenantId, groupId).lean(),
  /** Active scenarios of a persona (FR-11 minimum 15 is a launch gate, not enforced here). */
  currentForPersona: (tenantId: string, personaKey: string) => v.current(tenantId, { personaKey }).lean(),
};
