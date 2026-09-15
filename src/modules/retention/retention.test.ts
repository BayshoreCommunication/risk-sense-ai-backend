import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AssessmentMessageModel, AssessmentModel } from '../assessments/model';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { TenantModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { AssessmentArchiveModel, RetentionRunModel } from './model';
import { retentionService } from './service';

const DAY = 86400e3;

/** SEC-06 / Section 5: flag → grace → reduce (FREE) or archive + reduce (PAID); audit log never deleted; every step audited. */
describe('retention job [SEC-06, FR-24, SEC-07]', () => {
  let publicId: Types.ObjectId;
  let acmeId: Types.ObjectId;
  const NOW = new Date('2026-09-14T02:00:00Z');

  async function seedRow(tenantId: Types.ObjectId, email: string, ageDays: number) {
    const u = (await UserModel.findOne({ email }))!;
    const createdAt = new Date(NOW.getTime() - ageDays * DAY);
    const doc = await AssessmentModel.create({
      tenantId, requestorId: u._id, status: 'closed', phase: 'done', personaKey: 'finance_officer', scenarioKey: 'unauthorized_wire', sector: 'financial', createdAt,
      openingText: 'Secret free text about a wire', answers: [{ questionKey: 'q', text: 'secret answer' }], facts: [{ key: 'amount', value: 500, source: 'mcq', confidence: 1 }],
      result: { score: 40, classification: 'risk', computedClassification: 'risk', confidence: 80, ruleDriven: false, professionalConsult: false, mandatoryReview: false, explanation: 'secret explanation', keyDrivers: ['x'], recommendedAction: 'Manage the Risk', factors: { impact: { value: 1 } }, computedAt: createdAt },
      decision: { type: 'override', byUserId: u._id, overriddenTo: 'issue', reason: 'secret reason of at least twenty-five chars', decidedAt: createdAt },
      timing: { startedAt: createdAt, closedAt: new Date(createdAt.getTime() + 3600e3), durationSec: 3600 },
    });
    await AssessmentMessageModel.create({ tenantId, assessmentId: doc._id, role: 'user', kind: 'answer', content: 'secret transcript' });
    return doc;
  }

  beforeEach(async () => {
    const { publicTenant, acme } = await seeded();
    publicId = publicTenant._id;
    acmeId = acme._id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('FREE: flags after 90 days, reduces after the grace period to the permitted fields; messages removed; audited', async () => {
    const old = await seedRow(publicId, 'requestor@dev.local', 120);
    const fresh = await seedRow(publicId, 'requestor@dev.local', 10);
    const dry = await retentionService.run({ dryRun: true, trigger: 'script', actor: null, now: NOW, tenantId: String(publicId) });
    expect(dry[0]).toMatchObject({ slug: 'public', plan: 'free', flagged: 1, reduced: 0, dryRun: true });
    expect(await AssessmentModel.countDocuments({ 'retention.flaggedAt': { $exists: true } })).toBe(0); // dry run touches nothing

    const first = await retentionService.run({ dryRun: false, trigger: 'script', actor: null, now: NOW, tenantId: String(publicId) });
    expect(first[0]).toMatchObject({ flagged: 1, reduced: 0, archived: 0 });
    const flagged = (await AssessmentModel.findById(old._id).lean())!;
    expect(flagged.retention?.flaggedAt).toBeTruthy();
    expect(flagged.openingText).toBe('Secret free text about a wire'); // grace period: still intact
    expect(await AuditLogModel.countDocuments({ tenantId: publicId, action: 'retention.flagged' })).toBe(1);

    // one week later: enforcement
    const later = new Date(NOW.getTime() + 8 * DAY);
    const second = await retentionService.run({ dryRun: false, trigger: 'scheduler', actor: null, now: later, tenantId: String(publicId) });
    expect(second[0]).toMatchObject({ flagged: 0, reduced: 1, archived: 0, messagesRemoved: 1 });
    const reduced = (await AssessmentModel.findById(old._id).lean())!;
    expect(reduced.openingText).toBeUndefined();
    expect(reduced.answers).toBeUndefined();
    expect(reduced.facts).toBeUndefined();
    expect(reduced.result?.explanation).toBeUndefined();
    expect(reduced.result?.factors).toBeUndefined();
    expect(reduced.decision?.reason).toBeUndefined();
    // the five permitted fields survive (login id, risk type, time/date, duration) + analytics keys
    expect(String(reduced.requestorId)).toBeTruthy();
    expect(reduced.result?.classification).toBe('risk');
    expect(reduced.result?.score).toBeUndefined();
    expect(reduced.createdAt).toBeTruthy();
    expect(reduced.timing?.durationSec).toBe(3600);
    expect(reduced.status).toBe('closed');
    expect(reduced.decision?.type).toBe('override'); // the AI-01 invariant still holds after reduction
    expect(reduced.personaKey).toBeUndefined();
    expect(reduced.scenarioKey).toBeUndefined();
    expect(reduced.sector).toBeUndefined();
    expect(reduced.versions).toBeUndefined();
    expect(reduced.retention).toMatchObject({ mode: 'reduced' });
    expect(await AssessmentMessageModel.countDocuments({ assessmentId: old._id })).toBe(0);
    expect(await AssessmentArchiveModel.countDocuments()).toBe(0); // FREE never archives
    expect((await AssessmentModel.findById(fresh._id).lean())!.openingText).toBeTruthy();
    expect(await AuditLogModel.countDocuments({ tenantId: publicId, action: 'retention.reduced', 'entity.id': String(old._id) })).toBe(1);
    // idempotent
    const third = await retentionService.run({ dryRun: false, trigger: 'scheduler', actor: null, now: later, tenantId: String(publicId) });
    expect(third[0]).toMatchObject({ flagged: 0, reduced: 0 });
    expect(await RetentionRunModel.countDocuments({ tenantId: publicId })).toBe(4);
  });

  it('never flags or reduces an assessment before a human closes it [SEC-06, AI-01]', async () => {
    const user = (await UserModel.findOne({ email: 'requestor@dev.local' }))!;
    const createdAt = new Date(NOW.getTime() - 200 * DAY);
    const open = await AssessmentModel.create({
      tenantId: publicId,
      requestorId: user._id,
      status: 'in_progress',
      phase: 'questions',
      openingText: 'Still being completed',
      timing: { startedAt: createdAt },
      createdAt,
    });
    const result = await retentionService.run({ dryRun: false, trigger: 'script', actor: null, now: NOW, tenantId: String(publicId) });
    expect(result[0]).toMatchObject({ flagged: 0, reduced: 0 });
    const unchanged = await AssessmentModel.findById(open._id).lean();
    expect(unchanged?.openingText).toBe('Still being completed');
    expect(unchanged?.retention?.flaggedAt).toBeUndefined();
  });

  it('PAID: 7-year window; archives the full record + transcript to cold storage before reducing', async () => {
    await seedRow(acmeId, 'requestor@paid.local', 365 * 8);
    await seedRow(acmeId, 'requestor@paid.local', 365 * 2); // inside the window
    const r1 = await retentionService.run({ dryRun: false, trigger: 'script', actor: null, now: NOW, tenantId: String(acmeId) });
    expect(r1[0]).toMatchObject({ plan: 'paid', policy: { assessmentDays: 365 * 7 }, flagged: 1 });
    const r2 = await retentionService.run({ dryRun: false, trigger: 'script', actor: null, now: new Date(NOW.getTime() + 8 * DAY), tenantId: String(acmeId) });
    expect(r2[0]).toMatchObject({ reduced: 1, archived: 1, messagesRemoved: 1 });
    const archive = await AssessmentArchiveModel.findOne({ tenantId: acmeId }).lean();
    expect(archive).toBeTruthy();
    expect((archive!.document as { openingText: string }).openingText).toBe('Secret free text about a wire');
    expect(archive!.messages).toHaveLength(1);
    const live = (await AssessmentModel.findById(archive!.assessmentId).lean())!;
    expect(live.openingText).toBeUndefined();
    expect(live.retention?.mode).toBe('archived');
    expect(await AuditLogModel.countDocuments({ tenantId: acmeId, action: 'retention.archived' })).toBe(1);
    // the audit log itself is untouched (SEC-07) — the run only reports entries past the audit window
    expect(r2[0]!.auditPastRetention).toBe(0);
  });

  it('rolls back reduction and transcript deletion when the enforcement audit fails, then retries cleanly [SEC-06, SEC-07]', async () => {
    const old = await seedRow(publicId, 'requestor@dev.local', 120);
    await retentionService.run({ dryRun: false, trigger: 'script', actor: null, now: NOW, tenantId: String(publicId) });
    const later = new Date(NOW.getTime() + 8 * DAY);
    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'retention.reduced') throw new Error('forced retention audit failure');
      return writeAudit(entry);
    });

    const failed = await retentionService.run({ dryRun: false, trigger: 'scheduler', actor: null, now: later, tenantId: String(publicId) });
    expect(failed[0]).toMatchObject({ reduced: 0, messagesRemoved: 0, error: 'forced retention audit failure' });
    expect((await AssessmentModel.findById(old._id).lean())?.retention?.enforcedAt).toBeUndefined();
    expect((await AssessmentModel.findById(old._id).lean())?.openingText).toBe('Secret free text about a wire');
    expect(await AssessmentMessageModel.countDocuments({ assessmentId: old._id })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'retention.reduced', 'entity.id': String(old._id) })).toBe(0);

    writeSpy.mockRestore();
    const retry = await retentionService.run({ dryRun: false, trigger: 'scheduler', actor: null, now: later, tenantId: String(publicId) });
    expect(retry[0]).toMatchObject({ reduced: 1, messagesRemoved: 1 });
    expect((await AssessmentModel.findById(old._id).lean())?.retention?.enforcedAt).toBeTruthy();
    expect(await AssessmentMessageModel.countDocuments({ assessmentId: old._id })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'retention.reduced', 'entity.id': String(old._id) })).toBe(1);
  });

  it('repairs a legacy partial enforcement and records completion exactly once [SEC-06, SEC-07]', async () => {
    const old = await seedRow(publicId, 'requestor@dev.local', 120);
    await AssessmentModel.updateOne(
      { tenantId: publicId, _id: old._id },
      {
        $set: {
          'retention.flaggedAt': new Date(NOW.getTime() - 8 * DAY),
          'retention.enforcedAt': new Date(NOW.getTime() - DAY),
          'retention.mode': 'reduced',
        },
      },
    );

    const repaired = await retentionService.run({ dryRun: false, trigger: 'script', actor: null, now: NOW, tenantId: String(publicId) });
    expect(repaired[0]).toMatchObject({ reduced: 1, messagesRemoved: 1 });
    const reduced = await AssessmentModel.findById(old._id).lean();
    expect(reduced?.openingText).toBeUndefined();
    expect(reduced?.retention?.auditRecordedAt).toBeTruthy();
    expect(await AssessmentMessageModel.countDocuments({ tenantId: publicId, assessmentId: old._id })).toBe(0);
    expect(await AuditLogModel.countDocuments({ tenantId: publicId, action: 'retention.reduced', 'entity.id': String(old._id) })).toBe(1);

    const rerun = await retentionService.run({ dryRun: false, trigger: 'script', actor: null, now: NOW, tenantId: String(publicId) });
    expect(rerun[0]).toMatchObject({ reduced: 0, messagesRemoved: 0 });
    expect(await AuditLogModel.countDocuments({ tenantId: publicId, action: 'retention.reduced', 'entity.id': String(old._id) })).toBe(1);
  });

  it('rolls back the retention flag when its audit write fails, then retries cleanly [SEC-06, SEC-07]', async () => {
    const old = await seedRow(publicId, 'requestor@dev.local', 120);
    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'retention.flagged') throw new Error('forced retention flag audit failure');
      return writeAudit(entry);
    });

    const failed = await retentionService.run({ dryRun: false, trigger: 'scheduler', actor: null, now: NOW, tenantId: String(publicId) });
    expect(failed[0]).toMatchObject({ flagged: 0, reduced: 0, error: 'forced retention flag audit failure' });
    expect((await AssessmentModel.findById(old._id).lean())?.retention?.flaggedAt).toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'retention.flagged' })).toBe(0);

    writeSpy.mockRestore();
    const retry = await retentionService.run({ dryRun: false, trigger: 'scheduler', actor: null, now: NOW, tenantId: String(publicId) });
    expect(retry[0]).toMatchObject({ flagged: 1, reduced: 0 });
    expect((await AssessmentModel.findById(old._id).lean())?.retention?.flaggedAt).toBeTruthy();
    expect(await AuditLogModel.countDocuments({ action: 'retention.flagged' })).toBe(1);
  });

  it('system administrators run it for their tenant (dry run by default) and list runs; other roles cannot [SEC-06]', async () => {
    await seedRow(publicId, 'requestor@dev.local', 200);
    const sysadmin = await login('sysadmin@dev.local');
    const dry = await request(app).post('/api/v1/system/retention/run').set(sysadmin).send({});
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ slug: 'public', dryRun: true, flagged: 1 });
    const real = await request(app).post('/api/v1/system/retention/run').set(sysadmin).send({ dryRun: false });
    expect(real.body.data).toMatchObject({ dryRun: false, flagged: 1 });
    const runs = await request(app).get('/api/v1/system/retention/runs').set(sysadmin);
    expect(runs.body.data).toHaveLength(2);
    expect(runs.body.data[0]).toMatchObject({ trigger: 'manual', dryRun: false });
    expect((await request(app).post('/api/v1/system/retention/run').set(await login('admin@dev.local')).send({})).status).toBe(403);
    // policy is editable without code (BusinessRules 10.3): shorten to 30 days → the 200-day row is flagged already; a 60-day row becomes eligible
    await TenantModel.updateOne({ _id: publicId }, { $set: { 'retentionPolicy.assessmentDays': 30 } });
    await seedRow(publicId, 'requestor@dev.local', 60);
    const again = await request(app).post('/api/v1/system/retention/run').set(sysadmin).send({ dryRun: true });
    expect(again.body.data).toMatchObject({ flagged: 1, policy: { assessmentDays: 30 } });
  });
});
