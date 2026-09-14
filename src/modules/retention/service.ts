import { Types } from 'mongoose';
import { logger } from '../../lib/logger';
import { AssessmentMessageModel, AssessmentModel } from '../assessments/model';
import { audit } from '../audit/service';
import { AuditLogModel } from '../audit/model';
import { TenantModel } from '../tenants/model';
import { AssessmentArchiveModel, RetentionRunModel } from './model';

const DAY = 86400e3;
export const DEFAULT_GRACE_DAYS = 7; // BusinessRules 10.3: flagged first, enforced after a grace period

/**
 * The five fields a FREE assessment keeps after its retention window (Section 5 / BusinessRules 8.1):
 * login id (requestorId), risk type (result.classification), time/date (createdAt), duration (timing.durationSec)
 * + the keys needed to keep analytics meaningful (status, persona, scenario, sector, score).
 * Everything else — free text, answers, facts, explanation, factors, reasons, transcript — is removed.
 */
const REDUCE_UNSET = {
  openingText: 1, currentQuestionKey: 1, clarification: 1,
  'result.explanation': 1, 'result.keyDrivers': 1, 'result.factors': 1, 'result.nextSteps': 1, 'decision.reason': 1,
} as const;
// Arrays are emptied rather than removed so the document keeps its schema shape (FR-30).
const REDUCE_SET_EMPTY = { answers: [], facts: [], askedQuestionKeys: [], queue: [], personaCandidates: [] } as const;

export interface RunOptions {
  dryRun?: boolean;
  trigger: 'scheduler' | 'manual' | 'script';
  actor?: { id: string; role: string } | null;
  now?: Date;
  tenantId?: string; // one tenant only
  graceDays?: number;
}

export interface RunResult {
  tenantId: string;
  slug: string;
  plan: string;
  dryRun: boolean;
  policy: { assessmentDays: number; auditDays: number; graceDays: number };
  flagged: number;
  reduced: number;
  archived: number;
  messagesRemoved: number;
  auditPastRetention: number;
  durationMs: number;
}

export const retentionService = {
  /** SEC-06 nightly enforcement, per tenant. Idempotent: re-running changes nothing once records are reduced/archived. */
  async run(opts: RunOptions): Promise<RunResult[]> {
    const now = opts.now ?? new Date();
    const grace = opts.graceDays ?? DEFAULT_GRACE_DAYS;
    const tenants = await TenantModel.find(opts.tenantId ? { _id: opts.tenantId } : {}).lean();
    const results: RunResult[] = [];
    for (const t of tenants) {
      const t0 = Date.now();
      const assessmentDays = t.retentionPolicy?.assessmentDays ?? 90;
      const auditDays = t.retentionPolicy?.auditDays ?? 365 * 7;
      const cutoff = new Date(now.getTime() - assessmentDays * DAY);
      const graceCutoff = new Date(now.getTime() - grace * DAY);
      const base = { tenantId: t._id, createdAt: { $lt: cutoff } };
      const res: RunResult = { tenantId: String(t._id), slug: t.slug, plan: t.plan, dryRun: Boolean(opts.dryRun), policy: { assessmentDays, auditDays, graceDays: grace }, flagged: 0, reduced: 0, archived: 0, messagesRemoved: 0, auditPastRetention: 0, durationMs: 0 };
      try {
        // 1. Flag: past the window, not yet flagged, not yet enforced.
        const toFlag = await AssessmentModel.find({ ...base, 'retention.flaggedAt': { $exists: false }, 'retention.enforcedAt': { $exists: false } }).select('_id').lean();
        res.flagged = toFlag.length;
        if (!opts.dryRun && toFlag.length) {
          await AssessmentModel.updateMany({ _id: { $in: toFlag.map((d) => d._id) } }, { $set: { 'retention.flaggedAt': now, 'retention.reason': `older than ${assessmentDays} days` } });
          await audit.write({ tenantId: String(t._id), category: 'retention', action: 'retention.flagged', actor: opts.actor ?? null, entity: { type: 'tenant', id: String(t._id) }, payload: { count: toFlag.length, assessmentDays, graceDays: grace } });
        }
        // 2. Enforce: flagged before the grace cutoff → reduce (FREE) or archive + reduce (PAID).
        const due = await AssessmentModel.find({ ...base, 'retention.flaggedAt': { $lte: graceCutoff }, 'retention.enforcedAt': { $exists: false } });
        for (const doc of due) {
          const msgs = await AssessmentMessageModel.find({ assessmentId: doc._id }).lean();
          if (opts.dryRun) {
            if (t.plan === 'paid') res.archived++;
            res.reduced++;
            res.messagesRemoved += msgs.length;
            continue;
          }
          if (t.plan === 'paid') {
            await AssessmentArchiveModel.updateOne({ assessmentId: doc._id }, { $setOnInsert: { tenantId: t._id, assessmentId: doc._id, archivedAt: now, document: doc.toObject(), messages: msgs } }, { upsert: true });
            res.archived++;
          }
          await AssessmentModel.updateOne({ _id: doc._id }, { $unset: REDUCE_UNSET, $set: { ...REDUCE_SET_EMPTY, 'retention.enforcedAt': now, 'retention.mode': t.plan === 'paid' ? 'archived' : 'reduced' } });
          const removed = await AssessmentMessageModel.deleteMany({ assessmentId: doc._id });
          res.messagesRemoved += removed.deletedCount ?? 0;
          res.reduced++;
          await audit.write({ tenantId: String(t._id), category: 'retention', action: t.plan === 'paid' ? 'retention.archived' : 'retention.reduced', actor: opts.actor ?? null, entity: { type: 'assessment', id: String(doc._id) }, payload: { mode: t.plan === 'paid' ? 'archived' : 'reduced', messagesRemoved: removed.deletedCount ?? 0, keptFields: ['requestorId', 'result.classification', 'createdAt', 'timing.durationSec', 'status', 'personaKey', 'scenarioKey', 'sector', 'result.score'] } });
        }
        // 3. Audit log: append-only (SEC-07) — never deleted here; report how many entries are past the tenant's audit window so an operator can archive them (POST /audit-logs/archive).
        res.auditPastRetention = await AuditLogModel.countDocuments({ tenantId: t._id, createdAt: { $lt: new Date(now.getTime() - auditDays * DAY) } });
      } catch (err) {
        logger.error({ err, tenant: t.slug }, 'retention run failed');
        res.durationMs = Date.now() - t0;
        await RetentionRunModel.create({ ...res, tenantId: t._id, ranAt: now, trigger: opts.trigger, actorUserId: opts.actor?.id ? new Types.ObjectId(opts.actor.id) : undefined, error: (err as Error).message });
        results.push(res);
        continue;
      }
      res.durationMs = Date.now() - t0;
      await RetentionRunModel.create({ ...res, tenantId: t._id, ranAt: now, trigger: opts.trigger, actorUserId: opts.actor?.id ? new Types.ObjectId(opts.actor.id) : undefined });
      results.push(res);
    }
    return results;
  },

  async runs(tenantId: string, limit = 30) {
    return RetentionRunModel.find({ tenantId }).sort({ ranAt: -1 }).limit(limit).lean();
  },
};
