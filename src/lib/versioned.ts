/* eslint-disable @typescript-eslint/no-explicit-any */
import { Schema, Types, type Model } from 'mongoose';
import { VERSION_STATUSES, type VersionStatus } from '../modules/shared/enums';
import { AppError, notFound } from './errors';
import type { AuthUser } from '../middleware/auth';
import { audit } from '../modules/audit/service';
import { withMongoTransaction } from './db';

/**
 * Copy-on-write versioning (DecisionLog 2026-09-13-09, FR-09/FR-11/AI-04).
 *
 *   draft  ──activate──►  active  ──edit──►  new draft (version+1, same versionGroupId)
 *                            │                     │
 *                       deactivate            activate → becomes current, previous active → deactivated
 *
 * Rules: an `active` document is never mutated; drafts may be edited in place; exactly one document
 * per versionGroupId is `isCurrent`; old versions stay readable forever (assessments pin them).
 *
 * Typing note: Mongoose's generic document types are intentionally not threaded through here —
 * the helper works on any model that spreads `versionedFields`; services keep their own typed DTOs.
 */
export const versionedFields = {
  versionGroupId: { type: Schema.Types.ObjectId, required: true, index: true },
  version: { type: Number, required: true, default: 1 },
  isCurrent: { type: Boolean, default: false, index: true },
  status: { type: String, enum: VERSION_STATUSES, default: 'draft', index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  activatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  activatedAt: { type: Date },
  deactivatedAt: { type: Date },
} as const;

export interface VersionedDoc {
  _id: Types.ObjectId;
  tenantId: Types.ObjectId;
  key: string;
  versionGroupId: Types.ObjectId;
  version: number;
  isCurrent: boolean;
  status: VersionStatus;
  [field: string]: any;
}

type Doc = VersionedDoc & { save: () => Promise<unknown>; toObject: () => VersionedDoc };

export interface VersionedOptions {
  entityType: string; // audit entity type, e.g. 'persona'
  /** Fields that must not change between versions (identity). */
  immutable?: string[];
  /** Runs before activation; throw AppError to block. May set fields on the doc (e.g. a pinned hash). */
  validateForActivation?: (doc: Doc) => Promise<void>;
}

export function versioned(model: Model<any>, opts: VersionedOptions) {
  const { entityType } = opts;

  async function load(tenantId: string, id: string): Promise<Doc> {
    if (!Types.ObjectId.isValid(id)) throw notFound(entityType);
    const doc = await model.findOne({ _id: id, tenantId });
    if (!doc) throw notFound(entityType);
    return doc as Doc;
  }

  return {
    load,

    /** New version group (version 1, draft). `key` must be unique among current documents of the tenant. */
    async createDraft(tenantId: string, data: Record<string, any>, actor: AuthUser): Promise<Doc> {
      return withMongoTransaction(async () => {
      const clash = await model.findOne({ tenantId, key: data.key, isCurrent: true }).lean();
      if (clash) throw new AppError('CONFLICT', `${entityType} key "${data.key}" already exists`);
      const doc = await model.create({
        ...data,
        tenantId,
        versionGroupId: new Types.ObjectId(),
        version: 1,
        isCurrent: false,
        status: 'draft',
        createdBy: actor.id,
      });
      await audit.write({
        tenantId,
        category: 'config',
        action: `${entityType}.created`,
        actor,
        entity: { type: entityType, id: String(doc._id), version: 1 },
        payload: { key: data.key },
      });
      return doc as Doc;
      });
    },

    /**
     * Drafts are edited in place. Active documents are never touched: the patch is applied to a copy
     * that becomes the next draft version in the same group (FR-11).
     */
    async updateAsNewVersion(tenantId: string, id: string, patch: Record<string, any>, actor: AuthUser): Promise<Doc> {
      return withMongoTransaction(async () => {
      const current = await load(tenantId, id);
      for (const f of opts.immutable ?? []) {
        if (f in patch && patch[f] !== current[f]) {
          throw new AppError('VALIDATION_ERROR', `${f} cannot change between versions`);
        }
      }
      const changed = Object.keys(patch);
      if (current.status === 'draft') {
        const before = current.toObject();
        Object.assign(current, patch);
        await current.save();
        await audit.write({
          tenantId,
          category: 'config',
          action: `${entityType}.draft_updated`,
          actor,
          entity: { type: entityType, id, version: current.version },
          payload: { changed, before: pick(before, changed), after: pick(current.toObject(), changed) },
        });
        return current;
      }
      if (current.status === 'deactivated') throw new AppError('CONFLICT', `${entityType} is deactivated; create a new one`);
      // Guard: only one open draft per group.
      const openDraft = (await model.findOne({ tenantId, versionGroupId: current.versionGroupId, status: 'draft' }).lean()) as VersionedDoc | null;
      if (openDraft) throw new AppError('CONFLICT', `A draft (v${openDraft.version}) already exists for this ${entityType}; edit or activate it`);
      const latest = (await model.findOne({ tenantId, versionGroupId: current.versionGroupId }).sort({ version: -1 }).lean()) as VersionedDoc | null;
      const base: Record<string, any> = { ...current.toObject() };
      for (const k of ['_id', 'createdAt', 'updatedAt', 'activatedAt', 'activatedBy', 'deactivatedAt', '__v']) delete base[k];
      const next = await model.create({
        ...base,
        ...patch,
        version: (latest?.version ?? current.version) + 1,
        isCurrent: false,
        status: 'draft',
        createdBy: actor.id,
      });
      await audit.write({
        tenantId,
        category: 'config',
        action: `${entityType}.version_created`,
        actor,
        entity: { type: entityType, id: String(next._id), version: next.version },
        payload: { fromVersion: current.version, fromId: id, changed },
      });
      return next as Doc;
      });
    },

    /** Draft → active + current; the previously active version becomes `deactivated` but stays readable (AI-04). */
    async activate(tenantId: string, id: string, actor: AuthUser): Promise<Doc> {
      return withMongoTransaction(async () => {
      const doc = await load(tenantId, id);
      if (doc.status === 'active') return doc;
      if (doc.status === 'deactivated') throw new AppError('CONFLICT', `${entityType} version is deactivated`);
      if (opts.validateForActivation) await opts.validateForActivation(doc);
      const previous = (await model.findOne({ tenantId, versionGroupId: doc.versionGroupId, isCurrent: true }).lean()) as VersionedDoc | null;
      if (previous) {
        await model.updateOne({ _id: previous._id }, { $set: { isCurrent: false, status: 'deactivated', deactivatedAt: new Date() } });
      }
      doc.isCurrent = true;
      doc.status = 'active';
      doc.activatedBy = actor.id;
      doc.activatedAt = new Date();
      await doc.save();
      await audit.write({
        tenantId,
        category: 'config',
        action: `${entityType}.activated`,
        actor,
        entity: { type: entityType, id, version: doc.version },
        payload: { key: doc.key, previousVersion: previous?.version ?? null },
      });
      return doc;
      });
    },

    /** Removes from new sessions; historical references keep working (FR-09, FR-15). */
    async deactivate(tenantId: string, id: string, actor: AuthUser): Promise<Doc> {
      return withMongoTransaction(async () => {
      const doc = await load(tenantId, id);
      if (doc.status === 'deactivated') return doc;
      doc.isCurrent = false;
      doc.status = 'deactivated';
      doc.deactivatedAt = new Date();
      await doc.save();
      await audit.write({
        tenantId,
        category: 'config',
        action: `${entityType}.deactivated`,
        actor,
        entity: { type: entityType, id, version: doc.version },
        payload: { key: doc.key },
      });
      return doc;
      });
    },

    /** Current (active) documents only — what the chatbot and requestors see. */
    current(tenantId: string, filter: Record<string, unknown> = {}) {
      return model.find({ tenantId, isCurrent: true, status: 'active', ...filter });
    },

    /** Version history for a group, newest first. */
    history(tenantId: string, versionGroupId: string) {
      return model.find({ tenantId, versionGroupId }).sort({ version: -1 });
    },
  };
}

function pick(obj: unknown, keys: string[]) {
  const o = obj as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, o?.[k]]));
}
