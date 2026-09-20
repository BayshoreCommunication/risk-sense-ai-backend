import { Types } from 'mongoose';
import type { z } from 'zod';
import { withMongoTransaction } from '../../lib/db';
import { AppError, notFound } from '../../lib/errors';
import type { AuthUser } from '../../middleware/auth';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { parseLeaf, type Condition } from '../shared/conditions';
import { CLASSIFICATIONS, type Classification } from '../shared/enums';
import type { RuleLike } from './engine';
import { RuleModel } from './model';
import type { RuleBody, RuleListQuery, RulePatch } from './schema';
import { guardConfiguredSectorReferences } from '../tenants/sectors';

async function load(tenantId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound('rule');
  const doc = await RuleModel.findOne({ _id: id, tenantId });
  if (!doc) throw notFound('rule');
  return doc;
}

const write = (tenantId: string, action: string, actor: AuthUser, id: string, payload: Record<string, unknown>) =>
  audit.write({ tenantId, category: 'config', action, actor, entity: { type: 'rule', id }, payload });

export const rulesService = {
  list(tenantId: string, q: z.infer<typeof RuleListQuery>) {
    const filter: Record<string, unknown> = { tenantId };
    if (q.status) filter.status = q.status;
    if (q.sector) filter.$or = [{ sectors: q.sector }, { sectors: { $size: 0 } }];
    return RuleModel.find(filter).sort({ priority: 1, key: 1 }).lean();
  },
  get: load,

  async history(tenantId: string, id: string) {
    const doc = await load(tenantId, id);
    return RuleModel.find({ tenantId, versionGroupId: doc.versionGroupId }).sort({ version: -1 }).lean();
  },

  async create(tenantId: string, body: RuleBody, actor: AuthUser) {
    return withMongoTransaction(async () => {
      await guardConfiguredSectorReferences(tenantId, body.sectors);
      if (await RuleModel.exists({ tenantId, key: body.key })) throw new AppError('CONFLICT', `rule key "${body.key}" already exists`);
      const doc = await RuleModel.create({
        ...body,
        tenantId,
        versionGroupId: new Types.ObjectId(),
        version: 1,
        isCurrent: false,
        status: 'draft',
        createdBy: actor.id,
      });
      await write(tenantId, 'rule.created', actor, String(doc._id), { key: body.key, forcedClassification: body.forcedClassification });
      return doc;
    });
  },

  /** Draft/approved edits reset approval. Active rules are copied so the effective version stays live (AI-05). */
  async update(tenantId: string, id: string, patch: z.infer<typeof RulePatch>, actor: AuthUser) {
    return withMongoTransaction(async () => {
    const doc = await load(tenantId, id);
    await guardConfiguredSectorReferences(tenantId, patch.sectors ?? doc.sectors);
    if (doc.status === 'retired') throw new AppError('CONFLICT', 'retired rules cannot be edited');
    const changed = Object.keys(patch);

    if (doc.status === 'active') {
      const openReplacement = await RuleModel.findOne({
        tenantId,
        versionGroupId: doc.versionGroupId,
        status: { $in: ['draft', 'approved'] },
      })
        .select('version')
        .lean();
      if (openReplacement) throw new AppError('CONFLICT', `A replacement draft (v${openReplacement.version}) already exists for this rule; edit or activate it`);

      const latest = await RuleModel.findOne({ tenantId, versionGroupId: doc.versionGroupId }).sort({ version: -1 }).select('version').lean();
      const base = doc.toObject() as Record<string, unknown>;
      for (const key of ['_id', 'createdAt', 'updatedAt', 'approvedBy', 'approvedAt', 'changeRef', 'activatedAt', 'retiredAt', '__v']) delete base[key];
      const next = await RuleModel.create({
        ...base,
        ...patch,
        version: (latest?.version ?? doc.version) + 1,
        isCurrent: false,
        status: 'draft',
        createdBy: actor.id,
      });
      await write(tenantId, 'rule.version_created', actor, String(next._id), {
        fromId: id,
        fromVersion: doc.version,
        changed,
        before: pick(doc.toObject(), changed),
        after: pick(next.toObject(), changed),
      });
      return next;
    }

    const before = doc.toObject();
    Object.assign(doc, patch);
    doc.status = 'draft';
    doc.isCurrent = false;
    doc.createdBy = new Types.ObjectId(actor.id);
    doc.approvedBy = undefined;
    doc.approvedAt = undefined;
    doc.changeRef = undefined;
    await doc.save();
    await write(tenantId, 'rule.updated', actor, id, { changed, before: pick(before, changed), after: pick(doc.toObject(), changed), statusBefore: before.status });
    return doc;
    });
  },

  async approve(tenantId: string, id: string, approver: AuthUser, changeRef: string) {
    return withMongoTransaction(async () => {
    const doc = await load(tenantId, id);
    if (doc.status !== 'draft') throw new AppError('CONFLICT', `rule is ${doc.status}; only drafts can be approved`);
    if (String(doc.createdBy) === approver.id) throw new AppError('SELF_APPROVAL', 'a rule must be approved by an administrator other than its author (AI-05/AI-06)');
    doc.status = 'approved';
    doc.approvedBy = new Types.ObjectId(approver.id);
    doc.approvedAt = new Date();
    doc.changeRef = changeRef;
    await doc.save();
    await write(tenantId, 'rule.approved', approver, id, { changeRef });
    return doc;
    });
  },

  /** Takes effect for assessments that select a scenario after activation; existing assessments keep their snapshot. */
  async activate(tenantId: string, id: string, actor: AuthUser) {
    return withMongoTransaction(async () => {
      const doc = await load(tenantId, id);
      if (doc.status === 'active' && doc.isCurrent) {
        const activationAudit = await AuditLogModel.exists({ tenantId, action: 'rule.activated', 'entity.type': 'rule', 'entity.id': id });
        if (!activationAudit) {
          await write(tenantId, 'rule.activated', actor, id, {
            key: doc.key,
            approvedBy: doc.approvedBy ? String(doc.approvedBy) : null,
            previousVersion: null,
            reconciled: true,
          });
        }
        return doc;
      }
      const repairing = doc.status === 'active';
      if ((!repairing && doc.status !== 'approved') || !doc.approvedBy || !doc.approvedAt || !doc.changeRef?.trim()) {
        throw new AppError('NOT_APPROVED', `rule is ${doc.status}; it needs a complete approval record before activation (AI-05)`);
      }
      const previous = await RuleModel.findOne({ tenantId, versionGroupId: doc.versionGroupId, _id: { $ne: doc._id }, isCurrent: true, status: 'active' });
      if (previous) {
        previous.status = 'retired';
        previous.isCurrent = false;
        previous.retiredAt = new Date();
        await previous.save();
      }
      doc.status = 'active';
      doc.isCurrent = true;
      doc.activatedAt = new Date();
      await doc.save();
      const activationAudit = repairing
        ? await AuditLogModel.exists({ tenantId, action: 'rule.activated', 'entity.type': 'rule', 'entity.id': id })
        : null;
      if (!activationAudit) {
        await write(tenantId, 'rule.activated', actor, id, { key: doc.key, approvedBy: String(doc.approvedBy), previousVersion: previous?.version ?? null, reconciled: repairing });
      }
      return doc;
    });
  },

  async retire(tenantId: string, id: string, actor: AuthUser) {
    return withMongoTransaction(async () => {
    const doc = await load(tenantId, id);
    if (doc.status === 'retired') return doc;
    doc.status = 'retired';
    doc.isCurrent = false;
    doc.retiredAt = new Date();
    await doc.save();
    await write(tenantId, 'rule.retired', actor, id, { key: doc.key });
    return doc;
    });
  },

  /** Active rules for evaluation, optionally narrowed by sector. */
  async activeRules(tenantId: string, sector?: string): Promise<RuleLike[]> {
    const filter: Record<string, unknown> = { tenantId, status: 'active', isCurrent: true };
    if (sector) filter.$or = [{ sectors: sector }, { sectors: { $size: 0 } }];
    const docs = await RuleModel.find(filter).lean();
    return docs.map((d) => ({
      id: String(d._id),
      key: d.key,
      name: d.name,
      trigger: d.trigger as Condition,
      forcedClassification: d.forcedClassification as Classification,
      forcedAction: d.forcedAction,
      priority: d.priority,
    }));
  },

  /**
   * Template `hard_rules` cell → rules: `fact_key op value => classification; ...` (T-006 scoring sheet).
   * Used by dataset activation; the dataset's reviewer becomes the approval record (AI-05).
   */
  parseSheetRules(text: string): { errors: string[]; rules: Omit<RuleBody, 'sectors'>[] } {
    const errors: string[] = [];
    const rules: Omit<RuleBody, 'sectors'>[] = [];
    text
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((entry, i) => {
        const [lhs, rhs] = entry.split('=>').map((s) => s.trim());
        const cls = rhs as Classification;
        const cond = lhs ? parseLeaf(lhs) : null;
        if (!cond || !rhs || !CLASSIFICATIONS.includes(cls)) {
          errors.push(`hard rule #${i + 1} "${entry}" is not "fact op value => classification"`);
          return;
        }
        const key = `sheet_${cond.factKey}_${cond.op}_${String(cond.value).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`.slice(0, 64);
        rules.push({
          key,
          name: `${lhs} → ${cls}`,
          description: 'Imported from the scoring sheet (hard_rules).',
          trigger: cond,
          forcedClassification: cls,
          priority: 10 + i,
        });
      });
    return { errors, rules };
  },
};

function pick(obj: unknown, keys: string[]) {
  const o = obj as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, o?.[k]]));
}
