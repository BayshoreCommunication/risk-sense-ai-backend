import { Types } from 'mongoose';
import type { z } from 'zod';
import { AppError, notFound } from '../../lib/errors';
import type { AuthUser } from '../../middleware/auth';
import { audit } from '../audit/service';
import { QuestionModel } from './model';
import type { QuestionBody, QuestionListQuery, QuestionPatch } from './schema';

async function load(tenantId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound('question');
  const doc = await QuestionModel.findOne({ _id: id, tenantId });
  if (!doc) throw notFound('question');
  return doc;
}

export const questionsService = {
  list(tenantId: string, q: z.infer<typeof QuestionListQuery>) {
    const filter: Record<string, unknown> = { tenantId };
    if (q.personaKey) filter['tags.personaKeys'] = q.personaKey;
    if (q.scenarioKey) filter['tags.scenarioKeys'] = q.scenarioKey;
    if (q.sector) filter['tags.sectors'] = q.sector;
    if (q.status) filter.status = q.status;
    if (q.key) filter.key = q.key;
    return QuestionModel.find(filter).sort({ key: 1 }).lean();
  },

  get: load,

  async create(tenantId: string, body: QuestionBody, actor: AuthUser) {
    const clash = await QuestionModel.findOne({ tenantId, key: body.key }).lean();
    if (clash) throw new AppError('CONFLICT', `question key "${body.key}" already exists`);
    const doc = await QuestionModel.create({ ...body, tenantId, createdBy: actor.id });
    await audit.write({
      tenantId,
      category: 'config',
      action: 'question.created',
      actor,
      entity: { type: 'question', id: String(doc._id) },
      payload: { key: body.key, factKey: body.factKey },
    });
    return doc;
  },

  /** Questions are edited in place (not versioned); every change is audited with before/after (FR-25). */
  async update(tenantId: string, id: string, patch: z.infer<typeof QuestionPatch>, actor: AuthUser) {
    const doc = await load(tenantId, id);
    if (doc.status === 'retired') throw new AppError('CONFLICT', 'retired questions cannot be edited');
    const before = doc.toObject();
    Object.assign(doc, patch);
    await doc.save();
    const changed = Object.keys(patch);
    await audit.write({
      tenantId,
      category: 'config',
      action: 'question.updated',
      actor,
      entity: { type: 'question', id },
      payload: { changed, before: pick(before, changed), after: pick(doc.toObject(), changed) },
    });
    return doc;
  },

  /** Retire = removed from new sessions, preserved on historical records (FR-15). */
  async retire(tenantId: string, id: string, actor: AuthUser) {
    const doc = await load(tenantId, id);
    if (doc.status === 'retired') return doc;
    doc.status = 'retired';
    doc.retiredAt = new Date();
    await doc.save();
    await audit.write({ tenantId, category: 'config', action: 'question.retired', actor, entity: { type: 'question', id }, payload: { key: doc.key } });
    return doc;
  },

  /** Active questions by key — used by scenario activation validation and the chatbot. */
  activeByKeys(tenantId: string, keys: string[]) {
    return QuestionModel.find({ tenantId, key: { $in: keys }, status: 'active' }).lean();
  },
};

function pick(obj: unknown, keys: string[]) {
  const o = obj as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, o?.[k]]));
}
