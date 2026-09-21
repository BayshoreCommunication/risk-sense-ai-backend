import { beforeEach, describe, expect, it } from 'vitest';
import { login, seeded } from '../tests/helpers';
import { AuditLogModel } from '../modules/audit/model';
import { sessionAuditReference } from '../modules/audit/service';
import { SessionModel } from '../modules/auth/model';
import { revokeAuditExposedSessions } from './revoke-audit-exposed-sessions';

describe('historical audit-exposed session remediation [SEC-02, SEC-07]', () => {
  beforeEach(async () => { await seeded(); });

  it('previews and revokes only active sessions whose raw token exists in legacy audit evidence', async () => {
    const exposedHeaders = await login('requestor@dev.local');
    const safeHeaders = await login('requestor@paid.local');
    const exposed = (await SessionModel.findOne({ sessionId: exposedHeaders['X-Session-Id'] }))!;
    const safe = (await SessionModel.findOne({ sessionId: safeHeaders['X-Session-Id'] }))!;
    const latest = await AuditLogModel.findOne({ tenantId: exposed.tenantId }).sort({ seq: -1 }).lean();
    await AuditLogModel.collection.insertOne({
      tenantId: exposed.tenantId,
      seq: (latest?.seq ?? 0) + 1,
      category: 'session',
      action: 'session.legacy_created',
      entity: { type: 'session', id: exposed.sessionId },
      payload: {},
      prevHash: latest?.hash ?? '0'.repeat(64),
      hash: 'historical-row-hash',
      createdAt: new Date(),
    });

    const preview = await revokeAuditExposedSessions();
    expect(preview).toMatchObject({ dryRun: true, legacyReferencesMatched: 1, terminated: 0 });
    expect(JSON.stringify(preview)).not.toContain(exposed.sessionId);
    expect((await SessionModel.findById(exposed._id).lean())?.terminatedAt).toBeUndefined();

    const applied = await revokeAuditExposedSessions({ apply: true });
    expect(applied).toMatchObject({ dryRun: false, legacyReferencesMatched: 1, terminated: 1 });
    expect(JSON.stringify(applied)).not.toContain(exposed.sessionId);
    expect((await SessionModel.findById(exposed._id).lean())?.terminationReason).toBe('admin');
    expect((await SessionModel.findById(safe._id).lean())?.terminatedAt).toBeUndefined();

    const termination = await AuditLogModel.findOne({ action: 'session.admin', actorUserId: null }).lean();
    expect(termination?.entity.id).toBe(sessionAuditReference(String(exposed._id)));
    expect(termination?.entity.id).not.toBe(exposed.sessionId);
  });
});
