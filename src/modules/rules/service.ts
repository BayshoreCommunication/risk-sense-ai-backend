import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError, notFound } from '../../lib/errors';
import type { AuthUser } from '../../middleware/auth';
import { audit } from '../audit/service';
import { parseLeaf, type Condition } from '../shared/conditions';
import { CLASSIFICATIONS, type Classification } from '../shared/enums';
import type { RuleLike } from './engine';
import { RuleModel } from './model';
import type { RuleBody, RuleListQuery, RulePatch } from './schema';

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

  async create(tenantId: string, body: RuleBody, actor: AuthUser) {
    if (await RuleModel.exists({ tenantId, key: body.key })) throw new AppError('CONFLICT', `rule key "${body.key}" already exists`);
    const doc = await RuleModel.create({ ...body, tenantId, status: 'draft', createdBy: actor.id });
    await write(tenantId, 'rule.created', actor, String(doc._id), { key: body.key, forcedClassification: body.forcedClassification });
    return doc;
  },

  /** Any edit returns the rule to `draft` so it must be re-approved (AI-05). Active rules keep working until re-activated. */
  async update(tenantId: string, id: string, patch: z.infer<typeof RulePatch>, actor: AuthUser) {
    const doc = await load(tenantId, id);
    if (doc.status === 'retired') throw new AppError('CONFLICT', 'retired rules cannot be edited');
    const before = doc.toObject();
    Object.assign(doc, patch);
    doc.status = 'draft';
    doc.approvedBy = undefined;
    doc.approvedAt = undefined;
    doc.changeRef = undefined;
    await doc.save();
    const changed = Object.keys(patch);
    await write(tenantId, 'rule.updated', actor, id, { changed, before: pick(before, changed), after: pick(doc.toObject(), changed), statusBefore: before.status });
    return doc;
  },

  async approve(tenantId: string, id: string, approver: AuthUser, changeRef?: string) {
    const doc = await load(tenantId, id);
    if (doc.status !== 'draft') throw new AppError('CONFLICT', `rule is ${doc.status}; only drafts can be approved`);
    if (String(doc.createdBy) === approver.id) throw new AppError('SELF_APPROVAL', 'a rule must be approved by an administrator other than its author (AI-05/AI-06)');
    doc.status = 'approved';
    doc.approvedBy = new Types.ObjectId(approver.id);
    doc.approvedAt = new Date();
    doc.changeRef = changeRef;
    await doc.save();
    await write(tenantId, 'rule.approved', approver, id, { changeRef: changeRef ?? null });
    return doc;
  },

  /** Takes effect on the next new assessment — rules are read at evaluation time, no restart (FR-16). */
  async activate(tenantId: string, id: string, actor: AuthUser) {
    const doc = await load(tenantId, id);
    if (doc.status === 'active') return doc;
    if (doc.status !== 'approved') throw new AppError('NOT_APPROVED', `rule is ${doc.status}; it needs an approval record before activation (AI-05)`);
    doc.status = 'active';
    doc.activatedAt = new Date();
    await doc.save();
    await write(tenantId, 'rule.activated', actor, id, { key: doc.key, approvedBy: String(doc.approvedBy) });
    return doc;
  },

  async retire(tenantId: string, id: string, actor: AuthUser) {
    const doc = await load(tenantId, id);
    if (doc.status === 'retired') return doc;
    doc.status = 'retired';
    doc.retiredAt = new Date();
    await doc.save();
    await write(tenantId, 'rule.retired', actor, id, { key: doc.key });
    return doc;
  },

  /** Active rules for evaluation, optionally narrowed by sector. */
  async activeRules(tenantId: string, sector?: string): Promise<RuleLike[]> {
    const filter: Record<string, unknown> = { tenantId, status: 'active' };
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
