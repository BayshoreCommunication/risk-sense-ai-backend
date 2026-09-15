import { Types } from 'mongoose';
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
      const rawRecords = await AssessmentModel.collection.find({ tenantId: tenant._id }).toArray();
      let valid = 0;
      let flagged = 0;
      let resolved = 0;
      for (const raw of rawRecords) {
        const issues = issuesFor(raw as Record<string, unknown>);
        if (issues.length) {
          flagged++;
          await AssessmentConformanceFlagModel.updateOne(
            { tenantId: tenant._id, assessmentId: raw._id },
            { $set: { issues, lastDetectedAt: now }, $setOnInsert: { firstDetectedAt: now }, $unset: { resolvedAt: 1 } },
            { upsert: true },
          );
        } else {
          valid++;
          const update = await AssessmentConformanceFlagModel.updateOne(
            { tenantId: tenant._id, assessmentId: raw._id, resolvedAt: { $exists: false } },
            { $set: { resolvedAt: now } },
          );
          resolved += update.modifiedCount;
        }
      }
      const result = {
        tenantId: String(tenant._id),
        slug: tenant.slug,
        ranAt: now,
        trigger: options.trigger,
        scanned: rawRecords.length,
        valid,
        flagged,
        resolved,
        durationMs: Date.now() - started,
      };
      await ConformanceRunModel.create({ ...result, tenantId: tenant._id, actorUserId: options.actor?.id ? new Types.ObjectId(options.actor.id) : undefined });
      await audit.write({
        tenantId: String(tenant._id),
        category: 'config',
        action: 'conformance.scan_completed',
        actor: options.actor ?? null,
        entity: { type: 'tenant', id: String(tenant._id) },
        payload: { scanned: result.scanned, valid, flagged, resolved, trigger: options.trigger },
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
