import { Types } from 'mongoose';
import { GENESIS_HASH, canonicalJson, sha256 } from '../../lib/hash';
import { logger } from '../../lib/logger';
import { AuditLogModel, type AuditCategory } from './model';

export interface AuditActor {
  id: string;
  role: string;
}

export interface AuditEntryInput {
  tenantId: string;
  category: AuditCategory;
  action: string;
  actor: AuditActor | null;
  entity: { type: string; id: string; version?: number };
  payload?: Record<string, unknown>;
}

/** Fields that participate in the hash, in canonical order (createdAt excluded: set by Mongo after hashing). */
function hashInput(doc: {
  tenantId: string;
  seq: number;
  category: string;
  action: string;
  actorUserId: string | null;
  actorRole: string | null;
  entity: { type: string; id: string; version?: number };
  payload: unknown;
  prevHash: string;
}): string {
  return sha256(doc.prevHash + canonicalJson({ ...doc, prevHash: undefined }));
}

// Serialize writes per tenant in-process so seq/prevHash never race on a single instance.
// (Multi-instance safety comes from the unique {tenantId, seq} index + retry below.)
const tails = new Map<string, Promise<unknown>>();

export const audit = {
  async write(input: AuditEntryInput) {
    const key = input.tenantId;
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const last = await AuditLogModel.findOne({ tenantId: input.tenantId }).sort({ seq: -1 }).select('seq hash').lean();
        const seq = (last?.seq ?? 0) + 1;
        const prevHash = last?.hash ?? GENESIS_HASH;
        const base = {
          tenantId: input.tenantId,
          seq,
          category: input.category,
          action: input.action,
          actorUserId: input.actor?.id ?? null,
          actorRole: input.actor?.role ?? null,
          entity: input.entity,
          payload: input.payload ?? {},
          prevHash,
        };
        const hash = hashInput(base);
        try {
          return await AuditLogModel.create({
            ...base,
            tenantId: new Types.ObjectId(input.tenantId),
            actorUserId: base.actorUserId ? new Types.ObjectId(base.actorUserId) : undefined,
            hash,
          });
        } catch (err) {
          const dup = (err as { code?: number }).code === 11000;
          if (!dup || attempt === 2) throw err;
          logger.warn({ tenantId: key, seq }, 'audit seq collision, retrying');
        }
      }
      throw new Error('unreachable');
    };
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(run);
    tails.set(key, next);
    try {
      return await next;
    } finally {
      if (tails.get(key) === next) tails.delete(key);
    }
  },

  /** Walks the chain; returns the first broken seq (or ok). Used by GET /audit-logs/verify and the nightly job. */
  async verify(tenantId: string): Promise<{ ok: boolean; checked: number; firstBadSeq?: number }> {
    const cursor = AuditLogModel.find({ tenantId }).sort({ seq: 1 }).lean().cursor();
    let expectedPrev = GENESIS_HASH;
    let expectedSeq = 1;
    let checked = 0;
    for await (const doc of cursor) {
      const entity = doc.entity ?? { type: '', id: '' };
      const recomputed = hashInput({
        tenantId: String(doc.tenantId),
        seq: doc.seq,
        category: doc.category,
        action: doc.action,
        actorUserId: doc.actorUserId ? String(doc.actorUserId) : null,
        actorRole: doc.actorRole ?? null,
        entity: { type: entity.type, id: entity.id, ...(entity.version != null ? { version: entity.version } : {}) },
        payload: doc.payload ?? {},
        prevHash: doc.prevHash,
      });
      if (doc.seq !== expectedSeq || doc.prevHash !== expectedPrev || doc.hash !== recomputed) {
        return { ok: false, checked, firstBadSeq: doc.seq };
      }
      expectedPrev = doc.hash;
      expectedSeq++;
      checked++;
    }
    return { ok: true, checked };
  },

  /** Ordered lifecycle of one entity (FR-26 reconstruction). */
  async forEntity(type: string, id: string) {
    return AuditLogModel.find({ 'entity.type': type, 'entity.id': id }).sort({ seq: 1 }).lean();
  },
};
