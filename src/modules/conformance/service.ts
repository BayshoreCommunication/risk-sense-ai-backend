import { Types } from 'mongoose';
import { withMongoTransaction } from '../../lib/db';
import type { AuthUser } from '../../middleware/auth';
import { AssessmentModel } from '../assessments/model';
import { audit } from '../audit/service';
import { TenantModel } from '../tenants/model';
import { AssessmentConformanceFlagModel, ConformanceRunModel } from './model';

interface ScanOptions {
  tenantId?: string;
  trigger: 'scheduler' | 'manual' | 'script';
  actor?: AuthUser | null;
  now?: Date;
}

interface Issue {
  path: string;
  message: string;
}

function issuesFor(raw: Record<string, unknown>): Issue[] {
  const issues: Issue[] = [];
  const validation = AssessmentModel.hydrate(raw).validateSync();
  if (validation) {
    for (const error of Object.values(validation.errors)) issues.push({ path: error.path, message: error.message });
  }
  const decision = raw.decision as { type?: unknown; byUserId?: unknown } | null | undefined;
  if (raw.status === 'closed' && !(decision?.type && decision.byUserId)) {
    issues.push({ path: 'decision', message: 'AI-01: closed assessments require a human decision and deciding user' });
  }
  const result = raw.result as { computedAt?: unknown } | null | undefined;
  if (raw.status === 'in_progress' && result?.computedAt) {
    issues.push({ path: 'result', message: 'FR-08: in-progress assessments cannot contain a computed result' });
  }
  return [...new Map(issues.map((issue) => [`${issue.path}:${issue.message}`, issue])).values()];
}

export const conformanceService = {
  async scan(options: ScanOptions) {
    const tenants = await TenantModel.find(options.tenantId ? { _id: options.tenantId } : {}).select('_id slug').lean();
    const results = [];
    for (const tenant of tenants) {
      const started = Date.now();
      const now = options.now ?? new Date();
      // Validation is read/CPU work and can be large. Do it before the transaction so the database
      // transaction contains only one bulk flag write plus the run/audit evidence writes.
      const rawRecords = await AssessmentModel.collection.find({ tenantId: tenant._id }).toArray();
      const scanned = rawRecords.map((raw) => ({ raw, issues: issuesFor(raw as Record<string, unknown>) }));
      const validAssessmentIds = scanned.filter(({ issues }) => issues.length === 0).map(({ raw }) => raw._id);
      const flagged = scanned.length - validAssessmentIds.length;
      const valid = validAssessmentIds.length;
      const result = await withMongoTransaction(async () => {
        const resolved = validAssessmentIds.length
          ? await AssessmentConformanceFlagModel.countDocuments({
              tenantId: tenant._id,
              assessmentId: { $in: validAssessmentIds },
              resolvedAt: { $exists: false },
            })
          : 0;
        if (scanned.length) {
          const operations = scanned.map(({ raw, issues }) => issues.length
              ? {
                  updateOne: {
                    filter: { tenantId: tenant._id, assessmentId: raw._id },
                    update: { $set: { issues, lastDetectedAt: now, updatedAt: now }, $setOnInsert: { firstDetectedAt: now, createdAt: now }, $unset: { resolvedAt: 1 } },
                    upsert: true,
                  },
                }
              : {
                  updateOne: {
                    filter: { tenantId: tenant._id, assessmentId: raw._id, resolvedAt: { $exists: false } },
                    update: { $set: { resolvedAt: now, updatedAt: now } },
                  },
                });
          // Mongoose's inferred array-subdocument type expects DocumentArray here, although Mongo
          // accepts these validated plain issue objects. Keep the Model call (rather than the raw
          // collection) so transaction AsyncLocalStorage attaches the current session.
          await AssessmentConformanceFlagModel.bulkWrite(
            operations as unknown as Parameters<typeof AssessmentConformanceFlagModel.bulkWrite>[0],
            { ordered: false },
          );
        }
        const completed = {
          tenantId: String(tenant._id),
          slug: tenant.slug,
          ranAt: now,
          trigger: options.trigger,
          scanned: scanned.length,
          valid,
          flagged,
          resolved,
          durationMs: Date.now() - started,
        };
        await ConformanceRunModel.create({ ...completed, tenantId: tenant._id, actorUserId: options.actor?.id ? new Types.ObjectId(options.actor.id) : undefined });
        await audit.write({
          tenantId: String(tenant._id),
          category: 'config',
          action: 'conformance.scan_completed',
          actor: options.actor ?? null,
          entity: { type: 'tenant', id: String(tenant._id) },
          payload: { scanned: completed.scanned, valid, flagged, resolved, trigger: options.trigger },
        });
        return completed;
      });
      results.push(result);
    }
    return results;
  },

  runs(tenantId: string) {
    return ConformanceRunModel.find({ tenantId }).sort({ ranAt: -1 }).limit(30).lean();
  },

  flags(tenantId: string, includeResolved = false) {
    return AssessmentConformanceFlagModel.find({ tenantId, ...(includeResolved ? {} : { resolvedAt: { $exists: false } }) }).sort({ lastDetectedAt: -1 }).lean();
  },
};
