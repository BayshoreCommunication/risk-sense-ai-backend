import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AssessmentModel } from '../assessments/model';
import { UserModel } from '../users/model';
import { AssessmentConformanceFlagModel } from './model';

describe('stored assessment conformance sweep [FR-30, AI-01, FR-08]', () => {
  beforeEach(async () => {
    await seeded();
  });

  it('flags invalid raw records, exposes them to sysadmin, and resolves the flag after repair', async () => {
    const user = (await UserModel.findOne({ email: 'requestor@dev.local' }))!;
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
});
