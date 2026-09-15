import { Types } from 'mongoose';
import { withMongoTransaction } from '../../lib/db';
import { logger } from '../../lib/logger';
import { AssessmentMessageModel, AssessmentModel } from '../assessments/model';
import { audit } from '../audit/service';
import { AuditLogModel } from '../audit/model';
import { TenantModel } from '../tenants/model';
import { AssessmentArchiveModel, RetentionRunModel } from './model';

const DAY = 86400e3;
export const DEFAULT_GRACE_DAYS = 7; // BusinessRules 10.3: flagged first, enforced after a grace period

/**
 * The five business fields a FREE assessment keeps after its retention window (Section 5 / BusinessRules 1.2):
 * login id (requestorId), risk type (result.classification), time/date (createdAt), duration
 * (timing.durationSec). Tenant/id/timestamps, retention state, and the minimal closed-decision invariant are
 * technical metadata; every other assessment field and the transcript are removed.
 */
const REDUCE_UNSET = {
  departmentId: 1,
  phase: 1,
  openingText: 1,
  personaKey: 1,
  personaSource: 1,
  personaCandidates: 1,
  scenarioKey: 1,
  scenarioSource: 1,
  sector: 1,
  versions: 1,
  pinnedContent: 1,
  answers: 1,
  facts: 1,
  askedQuestionKeys: 1,
  queue: 1,
  currentQuestionKey: 1,
  clarification: 1,
  'result.score': 1,
  'result.computedClassification': 1,
  'result.ruleDriven': 1,
  'result.ruleKey': 1,
  'result.ruleName': 1,
  'result.confidence': 1,
  'result.professionalConsult': 1,
  'result.mandatoryReview': 1,
  'result.explanation': 1,
  'result.keyDrivers': 1,
  'result.recommendedAction': 1,
  'result.nextSteps': 1,
  'result.factors': 1,
  'result.computedAt': 1,
  'decision.reason': 1,
  'decision.overriddenTo': 1,
  'decision.decidedAt': 1,
  escalatedToUserId: 1,
  'timing.startedAt': 1,
  'timing.intakeCompletedAt': 1,
  'timing.submittedAt': 1,
  'timing.closedAt': 1,
} as const;

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
  policy: { assessmentDays: number; auditDays: number; evidenceDays: number; datasetHistoryDays: number; graceDays: number };
  flagged: number;
  reduced: number;
  archived: number;
  messagesRemoved: number;
  auditPastRetention: number;
  durationMs: number;
  error?: string;
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
      const evidenceDays = t.retentionPolicy?.evidenceDays ?? assessmentDays;
      const datasetHistoryDays = t.retentionPolicy?.datasetHistoryDays ?? 365 * 10;
      const cutoff = new Date(now.getTime() - assessmentDays * DAY);
      const graceCutoff = new Date(now.getTime() - grace * DAY);
      const base = { tenantId: t._id, status: 'closed', createdAt: { $lt: cutoff } };
      const res: RunResult = { tenantId: String(t._id), slug: t.slug, plan: t.plan, dryRun: Boolean(opts.dryRun), policy: { assessmentDays, auditDays, evidenceDays, datasetHistoryDays, graceDays: grace }, flagged: 0, reduced: 0, archived: 0, messagesRemoved: 0, auditPastRetention: 0, durationMs: 0 };
      try {
        // 1. Flag: past the window, not yet flagged, not yet enforced.
        const toFlag = await AssessmentModel.find({ ...base, 'retention.flaggedAt': { $exists: false }, 'retention.enforcedAt': { $exists: false } }).select('_id').lean();
        if (opts.dryRun) {
          res.flagged = toFlag.length;
        } else if (toFlag.length) {
          res.flagged = await withMongoTransaction(async () => {
            const update = await AssessmentModel.updateMany(
              {
                tenantId: t._id,
                status: 'closed',
                createdAt: { $lt: cutoff },
                _id: { $in: toFlag.map((doc) => doc._id) },
                'retention.flaggedAt': { $exists: false },
                'retention.enforcedAt': { $exists: false },
              },
              { $set: { 'retention.flaggedAt': now, 'retention.reason': `older than ${assessmentDays} days` } },
            );
            const flagged = update.modifiedCount;
            if (flagged) {
              await audit.write({ tenantId: String(t._id), category: 'retention', action: 'retention.flagged', actor: opts.actor ?? null, entity: { type: 'tenant', id: String(t._id) }, payload: { count: flagged, assessmentDays, graceDays: grace } });
            }
            return flagged;
          });
        }
        // 2. Enforce: flagged before the grace cutoff → reduce (FREE) or archive + reduce (PAID).
        const due = await AssessmentModel.find({
          tenantId: t._id,
          status: 'closed',
          createdAt: { $lt: cutoff },
          'retention.flaggedAt': { $lte: graceCutoff },
          'retention.auditRecordedAt': { $exists: false },
        });
        for (const candidate of due) {
          if (opts.dryRun) {
            const messageCount = await AssessmentMessageModel.countDocuments({ tenantId: t._id, assessmentId: candidate._id });
            if (t.plan === 'paid') res.archived++;
            res.reduced++;
            res.messagesRemoved += messageCount;
            continue;
          }

          const enforced = await withMongoTransaction(async () => {
            // Re-check eligibility in the transaction so concurrent runs cannot enforce the same row twice.
            const doc = await AssessmentModel.findOne({
              tenantId: t._id,
              status: 'closed',
              createdAt: { $lt: cutoff },
              _id: candidate._id,
              'retention.flaggedAt': { $lte: graceCutoff },
              'retention.auditRecordedAt': { $exists: false },
            });
            if (!doc) return null;
            const repairing = Boolean(doc.retention?.enforcedAt);
            const mode = doc.retention?.mode ?? (t.plan === 'paid' ? 'archived' : 'reduced');
            const msgs = await AssessmentMessageModel.find({ tenantId: t._id, assessmentId: doc._id }).lean();
            if (mode === 'archived' && repairing) {
              const archiveExists = await AssessmentArchiveModel.exists({ tenantId: t._id, assessmentId: doc._id });
              if (!archiveExists) throw new Error(`cannot reconcile archived assessment ${String(doc._id)}: cold archive is missing`);
            } else if (mode === 'archived') {
              await AssessmentArchiveModel.updateOne(
                { tenantId: t._id, assessmentId: doc._id },
                { $setOnInsert: { tenantId: t._id, assessmentId: doc._id, archivedAt: now, document: doc.toObject(), messages: msgs } },
                { upsert: true },
              );
            }
            const removed = await AssessmentMessageModel.deleteMany({ tenantId: t._id, assessmentId: doc._id });
            const update = await AssessmentModel.updateOne(
              { tenantId: t._id, _id: doc._id, 'retention.auditRecordedAt': { $exists: false } },
              {
                $unset: REDUCE_UNSET,
                $set: {
                  ...(repairing ? {} : { 'retention.enforcedAt': now }),
                  'retention.auditRecordedAt': now,
                  'retention.mode': mode,
                },
              },
            );
            if (update.modifiedCount !== 1) throw new Error(`retention state changed concurrently for assessment ${String(doc._id)}`);
            const action = mode === 'archived' ? 'retention.archived' : 'retention.reduced';
            const priorAudit = repairing
              ? await AuditLogModel.exists({ tenantId: t._id, action, 'entity.type': 'assessment', 'entity.id': String(doc._id) })
              : null;
            if (!priorAudit) {
              await audit.write({ tenantId: String(t._id), category: 'retention', action, actor: opts.actor ?? null, entity: { type: 'assessment', id: String(doc._id) }, payload: { mode, messagesRemoved: removed.deletedCount ?? 0, reconciled: repairing, keptBusinessFields: ['requestorId', 'result.classification', 'createdAt', 'timing.durationSec'], keptTechnicalFields: ['tenantId', 'status', 'decision.type', 'decision.byUserId', 'retention'] } });
            }
            return { archived: mode === 'archived', messagesRemoved: removed.deletedCount ?? 0 };
          });
          if (!enforced) continue;
          if (enforced.archived) res.archived++;
          res.messagesRemoved += enforced.messagesRemoved;
          res.reduced++;
        }
        // 3. Audit log: append-only (SEC-07) — never deleted here; report how many entries are past the tenant's audit window so an operator can archive them (POST /audit-logs/archive).
        res.auditPastRetention = await AuditLogModel.countDocuments({ tenantId: t._id, createdAt: { $lt: new Date(now.getTime() - auditDays * DAY) } });
      } catch (err) {
        logger.error({ err, tenant: t.slug }, 'retention run failed');
        res.error = err instanceof Error ? err.message : String(err);
        res.durationMs = Date.now() - t0;
        await RetentionRunModel.create({ ...res, tenantId: t._id, ranAt: now, trigger: opts.trigger, actorUserId: opts.actor?.id ? new Types.ObjectId(opts.actor.id) : undefined });
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
