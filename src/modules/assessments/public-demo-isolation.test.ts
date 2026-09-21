import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../config/env';
import { app, seeded } from '../../tests/helpers';
import { AuditLogModel } from '../audit/model';
import { sessionAuditReference } from '../audit/service';
import { PersonaModel } from '../personas/model';
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { AssessmentModel } from './model';

describe('public-demo assessment visitor isolation [SEC-01, SEC-05]', () => {
  beforeEach(async () => {
    const { tac } = await seeded();
    env.PUBLIC_DEMO_TENANT_ID = String(tac._id);
    await TenantModel.updateOne({ _id: tac._id }, { $set: { publicDemo: true } });
    for (const [email, role] of [
      ['requestor@tac.local', 'requestor'],
      ['admin@dev.local', 'administrator'],
      ['sysadmin@dev.local', 'system_administrator'],
      ['audit@dev.local', 'audit'],
    ] as const) {
      await UserModel.updateOne({ email, role, tenantId: tac._id }, { $set: { publicDemo: true } });
    }
    await PersonaModel.create({
      tenantId: tac._id,
      key: 'visitor_isolation',
      name: 'Visitor Isolation',
      sector: 'financial',
      description: 'Active persona for isolated public demo assessment sessions.',
      versionGroupId: tac._id,
      version: 1,
      status: 'active',
      isCurrent: true,
    });
  });

  async function demo(role: 'requestor' | 'administrator' | 'system_administrator' | 'audit') {
    const response = await request(app).post('/api/v1/auth/public-demo/session').send({ role });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return { 'X-Session-Id': response.body.data.sessionId as string };
  }

  it('isolates visitor assessments by application session and hides them from sandbox operators', async () => {
    const first = await demo('requestor');
    const second = await demo('requestor');
    const administrator = await demo('administrator');
    const systemAdministrator = await demo('system_administrator');
    const auditor = await demo('audit');

    const firstStart = await request(app)
      .post('/api/v1/assessments')
      .set(first)
      .send({ personaKey: 'visitor_isolation' });
    const secondStart = await request(app)
      .post('/api/v1/assessments')
      .set(second)
      .send({ personaKey: 'visitor_isolation' });
    expect(firstStart.status).toBe(201);
    expect(secondStart.status).toBe(201);
    const firstId = firstStart.body.data._id as string;
    const secondId = secondStart.body.data._id as string;

    const [firstStored, secondStored, hiddenByDefault] = await Promise.all([
      AssessmentModel.findById(firstId).select('+publicDemoSessionTag').lean(),
      AssessmentModel.findById(secondId).select('+publicDemoSessionTag').lean(),
      AssessmentModel.findById(firstId).lean(),
    ]);
    expect(firstStored?.publicDemoSessionTag).toMatch(/^[a-f0-9]{64}$/);
    expect(secondStored?.publicDemoSessionTag).toMatch(/^[a-f0-9]{64}$/);
    expect(firstStored?.publicDemoSessionTag).not.toBe(secondStored?.publicDemoSessionTag);
    expect(hiddenByDefault).not.toHaveProperty('publicDemoSessionTag');

    const firstList = await request(app).get('/api/v1/assessments').set(first);
    const secondList = await request(app).get('/api/v1/assessments').set(second);
    expect(firstList.body.data.items.map((item: { _id: string }) => item._id)).toEqual([firstId]);
    expect(secondList.body.data.items.map((item: { _id: string }) => item._id)).toEqual([secondId]);

    expect((await request(app).get(`/api/v1/assessments/${firstId}`).set(first)).status).toBe(200);
    expect((await request(app).get(`/api/v1/assessments/${firstId}`).set(second)).status).toBe(404);
    const crossSessionTurn = await request(app)
      .post(`/api/v1/assessments/${firstId}/messages`)
      .set(second)
      .send({ text: 'This visitor must not be able to continue another visitor assessment.' });
    expect(crossSessionTurn.status).toBe(404);

    const requestor = (await UserModel.findOne({ email: 'requestor@tac.local' }).lean())!;
    // Simulate one pre-fix historical row that persisted a still-live bearer-equivalent session id.
    const latestAudit = await AuditLogModel.findOne({ tenantId: requestor.tenantId }).sort({ seq: -1 }).lean();
    await AuditLogModel.collection.insertOne({
      tenantId: requestor.tenantId,
      seq: (latestAudit?.seq ?? 0) + 1,
      category: 'session',
      action: 'session.legacy_created',
      actorUserId: requestor._id,
      actorRole: 'requestor',
      entity: { type: 'session', id: first['X-Session-Id'] },
      payload: {},
      prevHash: latestAudit?.hash ?? '0'.repeat(64),
      hash: 'historical-row-hash',
      createdAt: new Date(),
    });
    const auditList = await request(app).get('/api/v1/audit-logs').query({ limit: 200 }).set(auditor);
    expect(auditList.status).toBe(200);
    const liveSessionIds = [first, second, administrator, systemAdministrator, auditor]
      .map((headers) => headers['X-Session-Id']);
    const serializedAudit = JSON.stringify(auditList.body.data.items);
    for (const liveSessionId of liveSessionIds) expect(serializedAudit).not.toContain(liveSessionId);
    const listedSessionRefs = [...new Set<string>(
      auditList.body.data.items
        .filter((item: { entity?: { type?: string } }) => item.entity?.type === 'session')
        .map((item: { entity: { id: string } }) => item.entity.id),
    )];
    expect(listedSessionRefs).toContain(sessionAuditReference(first['X-Session-Id']));
    for (const reference of listedSessionRefs) {
      const replay = await request(app).get('/api/v1/me').set('X-Session-Id', reference);
      expect(replay.status, reference).toBe(401);
    }
    const decidedAt = new Date();
    const override = (reason: string) => ({
      status: 'closed',
      result: { classification: 'risk', computedAt: decidedAt },
      decision: {
        type: 'override',
        byUserId: requestor._id,
        reason,
        overriddenTo: 'elevated_risk',
        decidedAt,
      },
    });
    await AssessmentModel.updateOne({ _id: firstId }, { $set: override('FIRST_VISITOR_PRIVATE_REASON') });
    await AssessmentModel.updateOne({ _id: secondId }, { $set: override('SECOND_VISITOR_PRIVATE_REASON') });
    const seededUntagged = await AssessmentModel.create({
      tenantId: requestor.tenantId,
      requestorId: requestor._id,
      ...override('SEEDED_SYNTHETIC_REASON'),
    });

    const firstReport = await request(app).get('/api/v1/reports/override-rate').set(first);
    const secondReport = await request(app).get('/api/v1/reports/override-rate').set(second);
    expect(firstReport.status, JSON.stringify(firstReport.body)).toBe(200);
    expect(secondReport.status, JSON.stringify(secondReport.body)).toBe(200);
    expect(firstReport.body.data.summary.reasons).toContain('FIRST_VISITOR_PRIVATE_REASON');
    expect(firstReport.body.data.summary.reasons).not.toContain('SECOND_VISITOR_PRIVATE_REASON');
    expect(secondReport.body.data.summary.reasons).toContain('SECOND_VISITOR_PRIVATE_REASON');
    expect(secondReport.body.data.summary.reasons).not.toContain('FIRST_VISITOR_PRIVATE_REASON');
    // Exporters render aggregate rows only; free-text reasons never enter CSV/PDF bytes.
    const firstExport = await request(app)
      .get('/api/v1/reports/override-rate/export')
      .query({ format: 'csv' })
      .set(first);
    expect(firstExport.status).toBe(200);
    expect(firstExport.text).not.toContain('PRIVATE_REASON');

    const administratorList = await request(app).get('/api/v1/assessments').set(administrator);
    const administratorIds = administratorList.body.data.items.map((item: { _id: string }) => item._id);
    expect(administratorIds).toContain(String(seededUntagged._id));
    expect(administratorIds).not.toContain(firstId);
    expect(administratorIds).not.toContain(secondId);
    const administratorReport = await request(app).get('/api/v1/reports/override-rate').set(administrator);
    expect(administratorReport.status).toBe(200);
    expect(administratorReport.body.data.summary.reasons).not.toContain('FIRST_VISITOR_PRIVATE_REASON');
    expect(administratorReport.body.data.summary.reasons).not.toContain('SECOND_VISITOR_PRIVATE_REASON');
    expect((await request(app).get(`/api/v1/assessments/${seededUntagged._id}`).set(administrator)).status).toBe(200);
    expect((await request(app).get(`/api/v1/assessments/${firstId}`).set(administrator)).status).toBe(404);
    expect((await request(app).get(`/api/v1/assessments/${firstId}/reconstruct`).set(auditor)).status).toBe(404);

    const unmask = await request(app).get('/api/v1/audit-logs').query({ unmask: 'true' }).set(auditor);
    expect(unmask.status).toBe(403);
    expect(unmask.body.error.code).toBe('FORBIDDEN');

    const archive = await request(app).post('/api/v1/audit-logs/archive').set(systemAdministrator).send({
      from: new Date(Date.now() - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
      maxRecords: 10_000,
    });
    expect(archive.status).toBe(403);
    expect(archive.body.error.code).toBe('FORBIDDEN');
  });
});
