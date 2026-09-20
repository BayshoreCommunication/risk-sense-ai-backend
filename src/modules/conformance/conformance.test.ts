import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AssessmentModel } from '../assessments/model';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { UserModel } from '../users/model';
import { AssessmentConformanceFlagModel, ConformanceRunModel } from './model';

describe('stored assessment conformance sweep [FR-30, AI-01, FR-08]', () => {
  beforeEach(async () => {
    await seeded();
  });

  afterEach(() => vi.restoreAllMocks());

  it('flags invalid raw records, exposes them to sysadmin, and resolves the flag after repair', async () => {
    const user = (await UserModel.findOne({ email: 'requestor@tac.local' }))!;
    const assessmentId = new Types.ObjectId();
    await AssessmentModel.collection.insertOne({
      _id: assessmentId,
      tenantId: user.tenantId,
      requestorId: user._id,
      status: 'closed',
      phase: 'done',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const sysadmin = await login('sysadmin@dev.local');
    const scan = await request(app).post('/api/v1/system/conformance/run').set(sysadmin);
    expect(scan.status).toBe(200);
    expect(scan.body.data).toMatchObject({ scanned: 1, valid: 0, flagged: 1 });
    const flags = await request(app).get('/api/v1/system/conformance/flags').set(sysadmin);
    expect(flags.body.data).toHaveLength(1);
    expect(flags.body.data[0].issues.some((issue: { path: string }) => issue.path === 'decision')).toBe(true);

    await AssessmentModel.collection.updateOne(
      { _id: assessmentId },
      { $set: { decision: { type: 'accept', byUserId: user._id, decidedAt: new Date() } } },
    );
    const repaired = await request(app).post('/api/v1/system/conformance/run').set(sysadmin);
    expect(repaired.body.data).toMatchObject({ scanned: 1, valid: 1, flagged: 0, resolved: 1 });
    expect((await request(app).get('/api/v1/system/conformance/flags').set(sysadmin)).body.data).toEqual([]);
    const history = await request(app).get('/api/v1/system/conformance/flags').set(sysadmin).query({ includeResolved: 'true' });
    expect(history.body.data[0].resolvedAt).toBeTruthy();
    expect(await AssessmentConformanceFlagModel.countDocuments({ tenantId: user.tenantId })).toBe(1);
  });

  it('rolls back flags and run history when scan audit evidence fails [FR-25, FR-30, SEC-07]', async () => {
    const user = (await UserModel.findOne({ email: 'requestor@tac.local' }))!;
    await AssessmentModel.collection.insertOne({
      _id: new Types.ObjectId(),
      tenantId: user.tenantId,
      requestorId: user._id,
      status: 'closed',
      phase: 'done',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const writeAudit = audit.write.bind(audit);
    vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'conformance.scan_completed') throw new Error('forced conformance audit failure');
      return writeAudit(entry);
    });

    const response = await request(app).post('/api/v1/system/conformance/run').set(await login('sysadmin@dev.local'));

    expect(response.status).toBe(500);
    expect(await AssessmentConformanceFlagModel.countDocuments({ tenantId: user.tenantId })).toBe(0);
    expect(await ConformanceRunModel.countDocuments({ tenantId: user.tenantId })).toBe(0);
    expect(await AuditLogModel.countDocuments({ tenantId: user.tenantId, action: 'conformance.scan_completed' })).toBe(0);
  });
});
