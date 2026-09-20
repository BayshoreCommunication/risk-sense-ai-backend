import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError } from '../../lib/errors';
import { withMongoTransaction } from '../../lib/db';
import { versioned, type VersionedDoc } from '../../lib/versioned';
import type { AuthUser } from '../../middleware/auth';
import { audit } from '../audit/service';
import { rulesService } from '../rules/service';
import { parseLeaf, type Condition } from '../shared/conditions';
import { CLASSIFICATIONS, type Classification } from '../shared/enums';
import { simulate, type MatrixLike, type ScoreResult } from './compute';
import { FACTOR_KEYS, ScoringMatrixModel, type FactorKey } from './model';
import { MatrixBody, type MatrixListQuery, type MatrixPatch, type SimulateBody } from './schema';
import { assertConfiguredSectors, guardConfiguredSectorReferences } from '../tenants/sectors';

/** Activation requires an approval record from someone other than the author (AI-05). */
async function validateForActivation(doc: VersionedDoc) {
  if (!doc.approvedBy || !doc.approvedAt || typeof doc.changeRef !== 'string' || !doc.changeRef.trim()) {
    throw new AppError('NOT_APPROVED', 'scoring matrix needs a complete approval record before activation (AI-05)');
  }
}

const v = versioned(ScoringMatrixModel, { entityType: 'scoring_matrix', immutable: ['key'], validateForActivation });

export const scoringService = {
  list(tenantId: string, q: z.infer<typeof MatrixListQuery>, isAdmin: boolean) {
    const filter: Record<string, unknown> = { tenantId };
    if (q.key) filter.key = q.key;
    const view = q.view ?? (isAdmin ? 'all' : 'current');
    if (view === 'current') {
      filter.isCurrent = true;
      filter.status = 'active';
    }
    return ScoringMatrixModel.find(filter).sort({ key: 1, version: -1 }).lean();
  },
  get: (tenantId: string, id: string) => v.load(tenantId, id),
  async create(tenantId: string, body: MatrixBody, actor: AuthUser) {
    return withMongoTransaction(async () => {
      await guardConfiguredSectorReferences(tenantId, [body.sector]);
      return v.createDraft(tenantId, body, actor);
    });
  },
  /** Editing transfers maker identity to the latest editor and clears approval (AI-05). */
  async update(tenantId: string, id: string, patch: z.infer<typeof MatrixPatch>, actor: AuthUser) {
    return withMongoTransaction(async () => {
    const current = await v.load(tenantId, id);
    await guardConfiguredSectorReferences(tenantId, [patch.sector ?? current.sector]);
    const doc = await v.updateAsNewVersion(
      tenantId,
      id,
      { ...patch, createdBy: actor.id, approvedBy: undefined, approvedAt: undefined, changeRef: undefined },
      actor,
    );
    if (doc.approvedBy) {
      doc.approvedBy = undefined;
      doc.approvedAt = undefined;
      doc.changeRef = undefined;
      await doc.save();
    }
    return doc;
    });
  },
  async approve(tenantId: string, id: string, approver: AuthUser, changeRef: string) {
    return withMongoTransaction(async () => {
    const doc = await v.load(tenantId, id);
    if (doc.status !== 'draft') throw new AppError('CONFLICT', `matrix version is ${doc.status}; only drafts can be approved`);
    if (String(doc.createdBy) === approver.id) throw new AppError('SELF_APPROVAL', 'a scoring matrix must be approved by an administrator other than its author (AI-05/AI-06)');
    doc.approvedBy = new Types.ObjectId(approver.id);
    doc.approvedAt = new Date();
    doc.changeRef = changeRef;
    await doc.save();
    await audit.write({ tenantId, category: 'config', action: 'scoring_matrix.approved', actor: approver, entity: { type: 'scoring_matrix', id, version: doc.version }, payload: { changeRef } });
    return doc;
    });
  },
  activate: (tenantId: string, id: string, actor: AuthUser) => v.activate(tenantId, id, actor),
  deactivate: (tenantId: string, id: string, actor: AuthUser) => v.deactivate(tenantId, id, actor),
  history: (tenantId: string, groupId: string) => v.history(tenantId, groupId).lean(),

  /** Current matrix for a sector, falling back to `default`. */
  async currentMatrix(tenantId: string, sector?: string) {
    if (sector) {
      const m = await ScoringMatrixModel.findOne({ tenantId, sector, isCurrent: true, status: 'active' }).lean();
      if (m) return m;
    }
    return ScoringMatrixModel.findOne({ tenantId, key: 'default', isCurrent: true, status: 'active' }).lean();
  },

  /** FR-18 documented test set + admin "what if": runs the exact production functions. */
  async simulate(tenantId: string, body: SimulateBody): Promise<ScoreResult & { matrix: { id: string; key: string; version: number } }> {
    await assertConfiguredSectors(tenantId, [body.sector]);
    const matrix = body.matrixId ? await v.load(tenantId, body.matrixId) : await this.currentMatrix(tenantId, body.sector);
    if (!matrix) throw new AppError('NOT_FOUND', 'no active scoring matrix; create and activate one (or upload the scoring sheet)');
    const rules = body.includeRules ? await rulesService.activeRules(tenantId, body.sector) : [];
    const result = simulate({
      matrix: matrix as unknown as MatrixLike,
      rules,
      facts: body.facts,
      requiredFactKeys: body.requiredFactKeys,
      factConfidences: body.factConfidences,
    });
    return { ...result, matrix: { id: String(matrix._id), key: matrix.key, version: matrix.version } };
  },

  /**
   * Template `scoring` sheet → matrix body (T-006). `mapping`: `fact op value => factorValue; …`;
   * `thresholds` and `professional_consult_below_confidence` on the first row.
   */
  parseSheet(rows: Record<string, string>[]): { errors: string[]; body?: MatrixBody } {
    const errors: string[] = [];
    const factors = {} as Record<FactorKey, { weight: number; scale: { min: number; max: number }; mapping: { when: Condition; value: number }[] }>;
    for (const r of rows) {
      const k = r.factor as FactorKey;
      if (!FACTOR_KEYS.includes(k)) {
        errors.push(`unknown factor "${r.factor}"`);
        continue;
      }
      const mapping: { when: Condition; value: number }[] = [];
      (r.mapping ?? '')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((entry) => {
          const [lhs, rhs] = entry.split('=>').map((s) => s.trim());
          const cond = lhs ? parseLeaf(lhs) : null;
          const value = Number(rhs);
          if (!cond || Number.isNaN(value)) errors.push(`${k}: mapping "${entry}" is not "fact op value => number"`);
          else mapping.push({ when: cond, value });
        });
      factors[k] = { weight: Number(r.weight_percent), scale: { min: Number(r.scale_min || 1), max: Number(r.scale_max || 5) }, mapping };
    }
    const first = rows.find((r) => r.thresholds?.trim()) ?? rows[0];
    const thresholds = {} as Record<Classification, { min: number; max: number }>;
    (first?.thresholds ?? '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((entry) => {
        const m = entry.match(/^([a-z_]+)\s+(\d+)\s*-\s*(\d+)$/);
        if (!m || !CLASSIFICATIONS.includes(m[1] as Classification)) errors.push(`threshold "${entry}" is not "class min-max"`);
        else thresholds[m[1] as Classification] = { min: Number(m[2]), max: Number(m[3]) };
      });
    const consult = Number(first?.professional_consult_below_confidence || 60);
    const parsed = MatrixBody.safeParse({
      key: 'default',
      name: 'Default scoring matrix (from scoring sheet)',
      factors,
      thresholds,
      confidence: { professionalConsultBelow: consult, mandatoryReviewBelow: Math.min(40, consult) },
    });
    if (!parsed.success) parsed.error.issues.forEach((i) => errors.push(`${i.path.join('.')}: ${i.message}`));
    return { errors, body: parsed.success ? parsed.data : undefined };
  },
};
