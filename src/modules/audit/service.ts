import { Types } from 'mongoose';
import { RetryableTransactionCollisionError, inMongoTransaction, isMongoDuplicateKeyFor } from '../../lib/db';
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

const SESSION_REFERENCE_PREFIX = 'session_ref_';
const SAFE_SESSION_REFERENCE = /^session_ref_[a-f0-9]{64}$/;

/**
 * Stable, non-secret correlation reference for session audit evidence. Callers should supply the
 * Session document id; the central write guard also fingerprints any legacy caller input so a
 * bearer-equivalent sessionId can never be persisted as a session entity id.
 */
export function sessionAuditReference(value: string): string {
  return SAFE_SESSION_REFERENCE.test(value)
    ? value
    : `${SESSION_REFERENCE_PREFIX}${sha256(`audit-session:${value}`)}`;
}

/** Read-time protection for historical rows that may predate non-secret session references. */
export function redactAuditEntrySecrets<T extends { entity?: { type?: unknown; id?: unknown } | null }>(entry: T): T {
  if (entry.entity?.type !== 'session' || typeof entry.entity.id !== 'string') return entry;
  return {
    ...entry,
    entity: { ...entry.entity, id: sessionAuditReference(entry.entity.id) },
  } as T;
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
    // Payloads may contain Mongoose documents/subdocuments (circular parent refs); store and hash a plain copy.
    const payload = JSON.parse(JSON.stringify(input.payload ?? {})) as Record<string, unknown>;
    const entity = input.entity.type === 'session'
      ? { ...input.entity, id: sessionAuditReference(input.entity.id) }
      : { ...input.entity };
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
          entity,
          payload,
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
          const seqCollision = isMongoDuplicateKeyFor(err, ['tenantId', 'seq']);
          // A duplicate write aborts a Mongo transaction. Retrying here would reuse that aborted
          // session, so signal the outer transaction boundary to replay its complete DB-only unit.
          if (seqCollision && inMongoTransaction()) throw new RetryableTransactionCollisionError('audit-sequence', err);
          if (!seqCollision || attempt === 2) throw err;
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
  async forEntity(tenantId: string, type: string, id: string, categories?: string[]) {
    return AuditLogModel.find({ tenantId, 'entity.type': type, 'entity.id': id, ...(categories ? { category: { $in: categories } } : {}) }).sort({ seq: 1 }).lean();
  },

  /**
   * Per-record integrity for a subset of the chain (SEC-07): each entry's hash must match its own content and
   * prevHash. Continuity between entries of *different* entities is only provable by the full `verify()` walk,
   * so this returns which seqs are individually tampered, not whether something was removed between them.
   */
  verifyEntries(entries: Array<{ tenantId: unknown; seq: number; category: string; action: string; actorUserId?: unknown; actorRole?: string | null; entity?: { type: string; id: string; version?: number | null } | null; payload?: unknown; prevHash: string; hash: string }>) {
    const badSeqs: number[] = [];
    for (const doc of entries) {
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
      if (recomputed !== doc.hash) badSeqs.push(doc.seq);
    }
    return { ok: badSeqs.length === 0, checked: entries.length, badSeqs };
  },
};
