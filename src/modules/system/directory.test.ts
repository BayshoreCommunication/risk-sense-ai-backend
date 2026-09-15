import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { PersonaModel } from '../personas/model';
import { SessionModel } from '../auth/model';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { DrStatusModel } from './dr.model';

describe('system directory administration [FR-02, FR-10, SEC-01]', () => {
  beforeEach(async () => {
    await seeded();
  });

  it('provisions and updates one-role users, terminating sessions when the role changes', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const created = await request(app).post('/api/v1/system/users').set(sysadmin).send({
      email: 'new.requestor@example.com',
      name: 'New Requestor',
      role: 'requestor',
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ email: 'new.requestor@example.com', role: 'requestor', status: 'active' });
    expect(await AuditLogModel.countDocuments({ action: 'user.created', 'entity.id': created.body.data._id })).toBe(1);

    const invited = await login('new.requestor@example.com');
    const changed = await request(app).patch(`/api/v1/system/users/${created.body.data._id}`).set(sysadmin).send({ role: 'audit' });
    expect(changed.status).toBe(200);
    expect(changed.body.data.role).toBe('audit');
    expect((await SessionModel.findOne({ sessionId: invited['X-Session-Id'] }))?.terminationReason).toBe('role_changed');
    expect((await request(app).get('/api/v1/me').set(invited)).body.error.code).toBe('SESSION_INVALID');

    const disabled = await request(app).patch(`/api/v1/system/users/${created.body.data._id}`).set(sysadmin).send({ status: 'disabled' });
    expect(disabled.status).toBe(200);
    const disabledAccess = await request(app).get('/api/v1/me').set(invited);
    expect(disabledAccess.status).toBe(401);
    expect(disabledAccess.body.error.code).toBe('SESSION_INVALID');

    const list = await request(app).get('/api/v1/system/users').set(sysadmin);
    expect(list.body.data.some((user: { email: string }) => user.email === 'new.requestor@example.com')).toBe(true);
    expect((await request(app).get('/api/v1/system/users').set(await login('admin@dev.local'))).status).toBe(403);
  });

  it('prevents self-lockout and rejects department scope on non-requestor roles', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const me = (await request(app).get('/api/v1/me').set(sysadmin)).body.data.user;
    const self = await request(app).patch(`/api/v1/system/users/${me.id}`).set(sysadmin).send({ status: 'disabled' });
    expect(self.status).toBe(403);
    const scopedAdmin = await request(app).post('/api/v1/system/users').set(sysadmin).send({
      email: 'bad.admin@example.com',
      name: 'Bad Admin',
      role: 'administrator',
      crossDepartmentAccess: true,
    });
    expect(scopedAdmin.status).toBe(400);
  });

  it('rolls back a role change and every session termination when termination audit fails [FR-02, SEC-02, SEC-07]', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const created = await request(app).post('/api/v1/system/users').set(sysadmin).send({
      email: 'atomic.role@example.com',
      name: 'Atomic Role',
      role: 'requestor',
    });
    const userId = created.body.data._id as string;
    const invited = await login('atomic.role@example.com');
    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'session.role_changed') throw new Error('forced role-change termination audit failure');
      return writeAudit(entry);
    });
    const failed = await request(app).patch(`/api/v1/system/users/${userId}`).set(sysadmin).send({ role: 'audit' });
    writeSpy.mockRestore();

    expect(failed.status).toBe(500);
    expect((await UserModel.findById(userId).lean())?.role).toBe('requestor');
    expect((await SessionModel.findOne({ sessionId: invited['X-Session-Id'] }).lean())?.terminatedAt).toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'session.role_changed', 'entity.id': invited['X-Session-Id'] })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'user.updated', 'entity.id': userId })).toBe(0);

    const retry = await request(app).patch(`/api/v1/system/users/${userId}`).set(sysadmin).send({ role: 'audit' });
    expect(retry.status).toBe(200);
    expect((await UserModel.findById(userId).lean())?.role).toBe('audit');
    expect((await SessionModel.findOne({ sessionId: invited['X-Session-Id'] }).lean())?.terminationReason).toBe('role_changed');
    expect(await AuditLogModel.countDocuments({ action: 'session.role_changed', 'entity.id': invited['X-Session-Id'] })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'user.updated', 'entity.id': userId })).toBe(1);
  });

  it('creates departments and maps only active tenant/shared personas', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const me = (await request(app).get('/api/v1/me').set(sysadmin)).body.data.user;
    const persona = await PersonaModel.create({
      tenantId: me.tenantId,
      key: 'shared_finance',
      name: 'Shared Finance',
      sector: 'financial',
      description: 'Shared active finance persona',
      versionGroupId: new Types.ObjectId(),
      version: 1,
      status: 'active',
      isCurrent: true,
    });
    const created = await request(app).post('/api/v1/system/departments').set(sysadmin).send({ name: 'Finance Ops', personaIds: [String(persona._id)] });
    expect(created.status).toBe(201);
    expect(created.body.data.personaIds).toEqual([String(persona._id)]);
    const renamed = await request(app).patch(`/api/v1/system/departments/${created.body.data._id}`).set(sysadmin).send({ name: 'Finance Operations' });
    expect(renamed.body.data.name).toBe('Finance Operations');
    const invalid = await request(app).patch(`/api/v1/system/departments/${created.body.data._id}`).set(sysadmin).send({ personaIds: [new Types.ObjectId().toString()] });
    expect(invalid.status).toBe(400);
    expect(await AuditLogModel.countDocuments({ action: { $in: ['department.created', 'department.updated'] } })).toBe(2);
  });

  it('reports DR as unverified until external backup and restore-drill evidence is recorded [NFR-06]', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const empty = await request(app).get('/api/v1/system/dr/status').set(sysadmin);
    expect(empty.body.data).toMatchObject({
      readiness: 'attention_required',
      targetsConfigurable: false,
      targets: { backupFrequencyHours: 24, rpoHours: 1, rtoHours: 4, drillFrequencyDays: 365 },
      checks: { backupFresh: false, drillCurrent: false, externalEvidenceRecorded: false },
    });
    const fixedTargets = await request(app).patch('/api/v1/system/dr/status').set(sysadmin).send({ targets: { rpoHours: 0.5, rtoHours: 2 } });
    expect(fixedTargets.status).toBe(403);
    expect(fixedTargets.body.error.code).toBe('FEATURE_DISABLED');
    const now = new Date();
    const recorded = await request(app).patch('/api/v1/system/dr/status').set(sysadmin).send({
      provider: 'MongoDB Atlas',
      backupsEnabled: true,
      lastBackupAt: now.toISOString(),
      lastRestoreDrillAt: now.toISOString(),
      lastRestoreDrillOutcome: 'passed',
      evidenceRef: 'https://example.com/external-dr-evidence/123',
    });
    expect(recorded.status).toBe(200);
    expect(recorded.body.data).toMatchObject({ readiness: 'ready', checks: { backupFresh: true, drillCurrent: true, externalEvidenceRecorded: true }, targets: { rpoHours: 1, rtoHours: 4 } });
    expect(await AuditLogModel.countDocuments({ action: 'dr.status_recorded' })).toBe(1);
  });

  it('rolls back DR state when its required audit write fails [NFR-06, SEC-07]', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'dr.status_recorded') throw new Error('forced DR audit failure');
      return writeAudit(entry);
    });
    const failed = await request(app).patch('/api/v1/system/dr/status').set(sysadmin).send({
      provider: 'MongoDB Atlas',
      backupsEnabled: true,
    });
    writeSpy.mockRestore();

    expect(failed.status).toBe(500);
    expect(await DrStatusModel.countDocuments()).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'dr.status_recorded' })).toBe(0);

    const retry = await request(app).patch('/api/v1/system/dr/status').set(sysadmin).send({
      provider: 'MongoDB Atlas',
      backupsEnabled: true,
    });
    expect(retry.status).toBe(200);
    expect(await DrStatusModel.countDocuments()).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'dr.status_recorded' })).toBe(1);
  });

  it('keeps evidence provenance unchanged across another operator target-only edit [NFR-06, FR-25]', async () => {
    const acme = await TenantModel.findOne({ slug: 'acme' });
    expect(acme).not.toBeNull();
    await UserModel.create([
      {
        firebaseUid: 'dev:dr.evidence@paid.local',
        email: 'dr.evidence@paid.local',
        name: 'DR Evidence Operator',
        role: 'system_administrator',
        tenantId: acme!._id,
        mfaEnrolled: true,
        status: 'active',
      },
      {
        firebaseUid: 'dev:dr.policy@paid.local',
        email: 'dr.policy@paid.local',
        name: 'DR Policy Operator',
        role: 'system_administrator',
        tenantId: acme!._id,
        mfaEnrolled: true,
        status: 'active',
      },
    ]);
    const evidenceOperator = await login('dr.evidence@paid.local');
    const policyOperator = await login('dr.policy@paid.local');
    const evidenceUser = await UserModel.findOne({ email: 'dr.evidence@paid.local' }).lean();
    const policyUser = await UserModel.findOne({ email: 'dr.policy@paid.local' }).lean();

    const evidence = await request(app).patch('/api/v1/system/dr/status').set(evidenceOperator).send({
      provider: 'MongoDB Atlas',
      backupsEnabled: true,
      evidenceRef: 'https://example.com/external-dr-evidence/provenance',
    });
    expect(evidence.status).toBe(200);
    const before = await DrStatusModel.findOne({ tenantId: acme!._id }).lean();
    expect(String(before?.recordedBy)).toBe(String(evidenceUser?._id));
    expect(before?.updatedAt).toBeTruthy();

    const target = await request(app)
      .patch('/api/v1/system/dr/status')
      .set(policyOperator)
      .send({ targets: { rpoHours: 0.5, rtoHours: 2 } });
    expect(target.status).toBe(200);
    const after = await DrStatusModel.findOne({ tenantId: acme!._id }).lean();
    expect(after?.targets).toMatchObject({ rpoHours: 0.5, rtoHours: 2 });
    expect(String(after?.recordedBy)).toBe(String(evidenceUser?._id));
    expect(after?.updatedAt?.getTime()).toBe(before?.updatedAt?.getTime());
    expect(target.body.data.updatedAt).toBe(before?.updatedAt?.toISOString());

    const targetAudit = await AuditLogModel.findOne({ action: 'dr.status_recorded' }).sort({ seq: -1 }).lean();
    expect(String(targetAudit?.actorUserId)).toBe(String(policyUser?._id));
    expect(targetAudit?.payload).toMatchObject({ changed: ['targets'] });
  });

  it('lets PAID tenants configure stricter RPO/RTO policy without asserting provider readiness [NFR-06, FR-25]', async () => {
    const acme = await TenantModel.findOne({ slug: 'acme' });
    expect(acme).not.toBeNull();
    await UserModel.create({
      firebaseUid: 'dev:dr.sysadmin@paid.local',
      email: 'dr.sysadmin@paid.local',
      name: 'DR System Administrator',
      role: 'system_administrator',
      tenantId: acme!._id,
      mfaEnrolled: true,
      status: 'active',
    });
    const sysadmin = await login('dr.sysadmin@paid.local');

    const initial = await request(app).get('/api/v1/system/dr/status').set(sysadmin);
    expect(initial.body.data).toMatchObject({
      targetsConfigurable: true,
      targets: { backupFrequencyHours: 24, rpoHours: 1, rtoHours: 4, drillFrequencyDays: 365 },
      readiness: 'attention_required',
    });

    const rpo = await request(app).patch('/api/v1/system/dr/status').set(sysadmin).send({ targets: { rpoHours: 0.5 } });
    expect(rpo.status).toBe(200);
    expect(rpo.body.data).toMatchObject({ targetsConfigurable: true, targets: { rpoHours: 0.5, rtoHours: 4 }, readiness: 'attention_required' });

    const rto = await request(app).patch('/api/v1/system/dr/status').set(sysadmin).send({ targets: { rtoHours: 2 } });
    expect(rto.status).toBe(200);
    expect(rto.body.data).toMatchObject({ targets: { rpoHours: 0.5, rtoHours: 2 }, checks: { backupFresh: false, drillCurrent: false, externalEvidenceRecorded: false } });

    expect((await request(app).patch('/api/v1/system/dr/status').set(sysadmin).send({ targets: { rpoHours: 1.01 } })).status).toBe(400);
    expect((await request(app).patch('/api/v1/system/dr/status').set(sysadmin).send({ targets: { rtoHours: 4.01 } })).status).toBe(400);
    expect(await AuditLogModel.countDocuments({ action: 'dr.status_recorded' })).toBe(2);
  });
});
