import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AssessmentModel } from '../assessments/model';
import { AuditLogModel } from '../audit/model';
import { DepartmentModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { ReportModel } from './model';

/** Phase 6 — FR-26 standard reports, FR-27 trends, FR-28 export, DASH-04 scoping, W9 cache. */
describe('reports & analytics [FR-26, FR-27, FR-28, DASH-03, DASH-04]', () => {
  const CLASSES = ['monitor_only', 'risk', 'elevated_risk', 'issue'] as const;
  const NOW = new Date('2026-09-14T12:00:00Z');
  let acmeId: Types.ObjectId;
  let finance: Types.ObjectId;
  let it_: Types.ObjectId;
  let admin: Record<string, string>;
  let finReq: Record<string, string>;
  const DAY = 86400e3;

  /** 360 rows over the last 12 months: one per day, alternating departments; statuses/decisions cycle deterministically. */
  async function seedYear() {
    const finUser = (await UserModel.findOne({ email: 'requestor@paid.local' }))!._id;
    const itUser = (await UserModel.findOne({ email: 'itlead@paid.local' }))!._id;
    const rows = [];
    for (let i = 0; i < 360; i++) {
      const createdAt = new Date(NOW.getTime() - i * DAY);
      const dept = i % 2 === 0 ? finance : it_;
      const cls = CLASSES[i % 4]!;
      const kind = i % 6; // 0 accept, 1 override up, 2 escalate, 3 in_progress, 4 accept, 5 override down
      const scored = kind !== 3;
      const decided = kind !== 3 && kind !== 2;
      const overrideTo = kind === 1 ? CLASSES[Math.min(3, (i % 4) + 1)] : kind === 5 ? CLASSES[Math.max(0, (i % 4) - 1)] : undefined;
      const started = createdAt;
      const intake = new Date(started.getTime() + 300e3 + (i % 5) * 60e3);
      const submitted = new Date(intake.getTime() + 20e3);
      const closed = decided ? new Date(submitted.getTime() + 3600e3 * (1 + (i % 3))) : undefined;
      rows.push({
        tenantId: acmeId, requestorId: dept === finance ? finUser : itUser, departmentId: dept, createdAt,
        status: kind === 3 ? 'in_progress' : kind === 2 ? 'escalated' : 'closed', phase: scored ? 'done' : 'questions',
        personaKey: i % 3 === 0 ? 'it_support' : 'finance_officer', scenarioKey: i % 3 === 0 ? 'phishing_click' : 'unauthorized_wire',
        ...(scored ? { result: { score: 10 + (i % 80), classification: cls, computedClassification: cls, confidence: 50 + (i % 50), ruleDriven: i % 10 === 0, professionalConsult: i % 7 === 0, mandatoryReview: false, explanation: 'x', recommendedAction: 'Manage the Risk', factors: { impact: { value: 1 } }, computedAt: submitted } } : {}),
        ...(decided ? { decision: { type: overrideTo ? 'override' : 'accept', byUserId: finUser, overriddenTo: overrideTo, reason: overrideTo ? 'Reviewed with the department lead and adjusted.' : undefined, decidedAt: closed } } : kind === 2 ? { decision: { type: 'escalate', byUserId: finUser, decidedAt: submitted } } : {}),
        timing: { startedAt: started, ...(scored ? { intakeCompletedAt: intake, submittedAt: submitted } : {}), ...(closed ? { closedAt: closed, durationSec: Math.round((closed.getTime() - started.getTime()) / 1000) } : {}) },
      });
    }
    await AssessmentModel.insertMany(rows);
  }

  beforeEach(async () => {
    const { acme } = await seeded();
    acmeId = acme._id;
    finance = (await DepartmentModel.findOne({ tenantId: acmeId, name: 'Finance' }))!._id;
    it_ = (await DepartmentModel.findOne({ tenantId: acmeId, name: 'IT' }))!._id;
    admin = await login('admin@paid.local');
    finReq = await login('requestor@paid.local');
    await seedYear();
  });

  const get = (path: string, h: Record<string, string>, query: Record<string, string> = {}) => request(app).get(`/api/v1${path}`).set(h).query(query);

  it('volume: one row per month over 12 months, zero-filled, with status split; PAID gate; ≤ 10 s [FR-26]', async () => {
    const t0 = Date.now();
    const res = await get('/reports/volume', admin, { from: '2025-09-15', to: NOW.toISOString() });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(res.status).toBe(200);
    const r = res.body.data;
    expect(r.cached).toBe(false);
    expect(r.rows.map((x: { period: string }) => x.period)).toEqual(['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    expect(r.summary.started).toBe(360);
    expect(r.summary).toMatchObject({ closed: 240, escalated: 60, inProgress: 60 });
    expect(r.rows.at(-1).started).toBe(14); // 1..14 Sept
    // FREE tenant: reports are PAID
    const dev = await login('requestor@dev.local');
    const free = await get('/reports/volume', dev);
    expect(free.status).toBe(403);
    expect(free.body.error.code).toBe('FEATURE_DISABLED');
    const devUser = await UserModel.findOne({ email: 'requestor@dev.local' }).lean();
    expect(await AuditLogModel.exists({ action: 'access.denied', actorUserId: devUser!._id, 'payload.code': 'FEATURE_DISABLED' })).toBeTruthy();
    expect((await get('/reports/nonsense', admin)).status).toBe(400);
    expect((await get('/reports/volume', admin, { from: '2026-09-10', to: '2026-09-01' })).status).toBe(400);
  });

  it('classification distribution uses the human override as the final class [FR-26, FR-23]', async () => {
    const r = (await get('/reports/classification', admin, { from: '2025-09-15', to: NOW.toISOString() })).body.data;
    expect(r.rows.map((x: { classification: string }) => x.classification)).toEqual([...CLASSES]);
    expect(r.summary.scored).toBe(300);
    const total = r.rows.reduce((n: number, x: { count: number }) => n + x.count, 0);
    expect(total).toBe(300);
    expect(r.rows.reduce((n: number, x: { overriddenInto: number }) => n + x.overriddenInto, 0)).toBe(120); // kinds 1 and 5
    // override-up moves rows out of monitor_only: fewer monitor_only than the raw 75 (kind 1 → next class), plus down-moves land there
    const monitor = r.rows.find((x: { classification: string }) => x.classification === 'monitor_only');
    expect(monitor.count).not.toBe(75);
    expect(r.rows.every((x: { share: number | null }) => x.share === null || (x.share >= 0 && x.share <= 100))).toBe(true);
  });

  it('override rate per period + accept rate (accuracy proxy) + reasons retrievable [FR-26, FR-23, BRD §12]', async () => {
    const r = (await get('/reports/override-rate', admin, { from: '2025-09-15', to: NOW.toISOString(), unmask: 'true' })).body.data; // SEC-05: administrators see reasons masked unless they unmask (audited)
    expect(r.summary).toMatchObject({ decided: 300, accepted: 120, overridden: 120, escalated: 60, overrideRate: 50, acceptRate: 50 });
    expect(r.summary.overriddenUp ?? r.rows.reduce((n: number, x: { overriddenUp: number }) => n + x.overriddenUp, 0)).toBeGreaterThan(0);
    const reasons = JSON.parse(r.summary.reasons);
    expect(reasons.length).toBe(50);
    expect(reasons[0]).toMatchObject({ reason: 'Reviewed with the department lead and adjusted.' });
    expect(reasons[0].from).not.toBe(reasons[0].to);
    // narrowing by persona changes the numbers but keeps the rates consistent
    const it = (await get('/reports/override-rate', admin, { from: '2025-09-15', to: NOW.toISOString(), personaKey: 'it_support' })).body.data;
    expect(it.summary.decided).toBeLessThan(300);
    expect(it.summary.accepted + it.summary.overridden + it.summary.escalated).toBe(it.summary.decided);
  });

  it('assessment time: intake, decision and total durations with median/p95 [FR-26]', async () => {
    const r = (await get('/reports/assessment-time', admin, { from: '2025-09-15', to: NOW.toISOString(), interval: 'month' })).body.data;
    expect(r.summary.assessments).toBe(300);
    expect(r.summary.avgIntakeSec).toBeGreaterThanOrEqual(300);
    expect(r.summary.avgIntakeSec).toBeLessThanOrEqual(540);
    expect(r.summary.medianTotalSec).toBeGreaterThan(3600);
    expect(r.summary.p95TotalSec).toBeGreaterThanOrEqual(r.summary.medianTotalSec);
    const sept = r.rows.at(-1);
    expect(sept.avgDecisionSec).toBeGreaterThan(3000);
  });

  it('trends by department / persona / scenario: period × group rows, names resolved, ≤ 8 series + other [FR-27, DASH-03]', async () => {
    const dep = (await get('/analytics/trends', admin, { by: 'department', from: '2026-06-01', to: NOW.toISOString(), interval: 'month' })).body.data;
    expect(dep.summary.series.split('|').sort()).toEqual(['Finance', 'IT']);
    expect(dep.rows.length).toBe(4 * 2); // Jun..Sep × 2 departments
    expect(dep.rows.every((x: { avgScore: number | null; count: number }) => x.count === 0 || x.avgScore !== null)).toBe(true);
    const per = (await get('/analytics/trends', admin, { by: 'persona', from: '2026-06-01', to: NOW.toISOString(), interval: 'week' })).body.data;
    expect(per.summary.series.split('|').sort()).toEqual(['finance_officer', 'it_support']);
    expect(per.columns[1].label).toBe('Persona');
    const sc = (await get('/analytics/trends', admin, { by: 'scenario', from: '2026-09-01', to: NOW.toISOString(), interval: 'day' })).body.data;
    expect(sc.rows.length).toBe(14 * 2);
    expect(sc.rows.reduce((n: number, x: { count: number }) => n + x.count, 0)).toBe(14);
  });

  it('requestors are department-scoped; the cache serves the exact params for 1 h and refresh bypasses it [DASH-04, W9]', async () => {
    const q = { from: '2025-09-15', to: NOW.toISOString() };
    const mine = (await get('/reports/volume', finReq, q)).body.data;
    expect(mine.summary.started).toBe(180); // Finance only
    const all = (await get('/reports/volume', admin, q)).body.data;
    expect(all.summary.started).toBe(360);
    expect(await ReportModel.countDocuments({ tenantId: acmeId, type: 'volume' })).toBe(2); // one cache entry per scope
    // second identical call is a cache hit with the same rows
    const again = (await get('/reports/volume', admin, q)).body.data;
    expect(again.cached).toBe(true);
    expect(again.rows).toEqual(all.rows);
    // new data does not show until refresh (or the TTL)
    await AssessmentModel.create({ tenantId: acmeId, requestorId: new Types.ObjectId(), departmentId: it_, status: 'in_progress', createdAt: NOW });
    expect((await get('/reports/volume', admin, q)).body.data.summary.started).toBe(360);
    const fresh = (await get('/reports/volume', admin, { ...q, refresh: 'true' })).body.data;
    expect(fresh.cached).toBe(false);
    expect(fresh.summary.started).toBe(361);
    // a department filter a requestor is not in yields their own rows only (scope wins)
    const other = (await get('/reports/volume', finReq, { ...q, departmentId: String(it_) })).body.data;
    expect(other.summary.started).toBe(0);
  });

  it('CSV and PDF exports carry the same rows and are audited [FR-28, SEC-05]', async () => {
    const q = { from: '2025-09-15', to: NOW.toISOString() };
    const csv = await get('/reports/volume/export', admin, { ...q, format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/risksense-volume-2026-09-14\.csv/);
    const lines = csv.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Period,Started,Closed,Escalated,Error review,In progress');
    expect(lines.length).toBe(1 + 13);
    expect(lines.at(-1)).toBe('2026-09,14,10,2,0,2'); // 1..14 Sept: kinds cycle 0..5 → 10 closed, 2 escalated, 2 in progress
    const pdf = await get('/reports/classification/export', admin, { ...q, format: 'pdf' }).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).length).toBeGreaterThan(1000);
    expect(await AuditLogModel.countDocuments({ tenantId: acmeId, action: 'report.exported' })).toBe(2);
    const entry = await AuditLogModel.findOne({ tenantId: acmeId, action: 'report.exported', 'entity.id': 'classification' }).lean();
    expect(entry!.payload).toMatchObject({ format: 'pdf', rows: 4 });
    expect((await get('/reports/volume/export', await login('requestor@dev.local'), { format: 'csv' })).status).toBe(403);
  });
});
