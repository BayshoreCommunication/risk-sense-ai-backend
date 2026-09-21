/**
 * Emergency remediation for historical audit rows that stored a live application session token.
 *
 * Preview: npm run sessions:revoke-audit-exposed
 * Apply:   npm run sessions:revoke-audit-exposed -- --apply
 *
 * Output contains counts only. Applied revocations use sessionService so each termination is
 * transactional and audited with the new non-secret session reference.
 */
import { connectDb, disconnectDb } from '../lib/db';
import { AuditLogModel } from '../modules/audit/model';
import { SessionModel } from '../modules/auth/model';
import { sessionService } from '../modules/auth/service';

const LOOKUP_BATCH_SIZE = 500;

export interface RevokeAuditExposedSessionsResult {
  dryRun: boolean;
  activeScanned: number;
  legacyReferencesMatched: number;
  terminated: number;
}

export async function revokeAuditExposedSessions(
  options: { apply?: boolean } = {},
): Promise<RevokeAuditExposedSessionsResult> {
  const active = await SessionModel.find({ terminatedAt: null }).select('_id sessionId').lean();
  const exposed = new Set<string>();

  for (let offset = 0; offset < active.length; offset += LOOKUP_BATCH_SIZE) {
    const ids = active.slice(offset, offset + LOOKUP_BATCH_SIZE).map((session) => session.sessionId);
    const matched = await AuditLogModel.distinct('entity.id', {
      'entity.type': 'session',
      'entity.id': { $in: ids },
    });
    for (const value of matched) if (typeof value === 'string') exposed.add(value);
  }

  let terminated = 0;
  if (options.apply) {
    for (const session of active) {
      if (!exposed.has(session.sessionId)) continue;
      if (await sessionService.terminate(session.sessionId, 'admin')) terminated += 1;
    }
  }

  return {
    dryRun: options.apply !== true,
    activeScanned: active.length,
    legacyReferencesMatched: exposed.size,
    terminated,
  };
}

async function main(): Promise<void> {
  await connectDb();
  try {
    const result = await revokeAuditExposedSessions({ apply: process.argv.includes('--apply') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await disconnectDb();
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    process.stderr.write(`Session revocation failed (${(error as Error)?.name ?? 'Error'}).\n`);
    await disconnectDb();
    process.exitCode = 1;
  });
}
