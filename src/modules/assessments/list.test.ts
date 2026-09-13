import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { DepartmentModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { AssessmentModel } from './model';

/**
 * DASH-01 / DASH-04 review dashboard: scoping, filters, pagination, ordering and the "≤ 3 s for 500 open" rule (BusinessRules 7.1).
 * Rows are inserted directly (the intake itself is covered by assessments.test.ts).
 */
describe('assessments list — review dashboard [DASH-01, DASH-04, FR-21]', () => {
  const STATUSES = ['in_progress', 'intake_complete', 'awaiting_decision', 'escalated', 'closed', 'error_review'] as const;
  const CLASSES = ['monitor_only', 'risk', 'elevated_risk', 'issue'] as const;
  let acmeId: Types.ObjectId;
  let finance: { _id: Types.ObjectId };
  let it_: { _id: Types.ObjectId };
  let itLead: { _id: Types.ObjectId };
  let finReq: { _id: Types.ObjectId };
  let itLeadH: Record<string, string>;
  let finReqH: Record<string, string>;
  const day = 24 * 3600 * 1000;
  const base = new Date('2026-09-01T12:00:00Z').getTime();

  /** 500 rows for the PAID tenant: alternating departments/requestors, statuses cycling, one per hour backwards from Sept 1. */
  async function seedRows(n = 500) {
    const rows = [];
    for (let i = 0; i < n; i++) {
      const status = STATUSES[i % STATUSES.length]!;
      const dept = i % 2 === 0 ? it_ : finance;
      const requestor = i % 2 === 0 ? itLead : finReq;
      const scored = status !== 'in_progress' && status !== 'intake_complete';
      rows.push({
        tenantId: acmeId,
        requestorId: requestor._id,
        departmentId: dept._id,
        status,
        phase: scored ? 'done' : 'questions',
        personaKey: i % 3 === 0 ? 'it_support' : 'finance_officer',
        scenarioKey: i % 3 === 0 ? 'phishing_click' : 'unauthorized_wire',
        createdAt: new Date(base - i * 3600 * 1000),
        answers: [{ questionKey: 'q1', value: 'a' }],
        facts: [{ key: 'f1', value: 1, source: 'mcq', confidence: 1 }],
        ...(scored
          ? { result: { score: status === 'error_review' ? 0 : 40 + (i % 50), classification: CLASSES[i % 4], computedClassification: CLASSES[i % 4], confidence: 55 + (i % 40), ruleDriven: i % 7 === 0, professionalConsult: false, mandatoryReview: false, explanation: `Explanation ${i}`, keyDrivers: [], recommendedAction: 'Manage the Risk', nextSteps: [], factors: {}, computedAt: new Date(base - i * 3600 * 1000) } }
          : {}),
        ...(status === 'closed' ? { decision: { type: 'accept', byUserId: requestor._id, decidedAt: new Date(base - i * 3600 * 1000) } } : {}),
      });
    }
    await AssessmentModel.insertMany(rows);
  }

  beforeEach(async () => {
    const { acme } = await seeded();
    acmeId = acme._id;
    finance = (await DepartmentModel.findOne({ tenantId: acmeId, name: 'Finance' }))!;
    it_ = (await DepartmentModel.findOne({ tenantId: acmeId, name: 'IT' }))!;
    itLead = (await UserModel.findOne({ email: 'itlead@paid.local' }))!;
    finReq = (await UserModel.findOne({ email: 'requestor@paid.local' }))!;
    itLeadH = await login('itlead@paid.local');
    finReqH = await login('requestor@paid.local');
  });

  const list = (h: Record<string, string>, query: Record<string, string | number> = {}) => request(app).get('/api/v1/assessments').set(h).query(query);

  it('scopes PAID requestors to own + department rows; FREE requestors to own only [DASH-04]', async () => {
    await seedRows(60);
    // rows alternate IT/Finance → 30 each; each requestor only has rows in their own department here
    const itRes = await list(itLeadH, { limit: 200 });
    expect(itRes.status).toBe(200);
    expect(itRes.body.data.total).toBe(30);
    expect(itRes.body.data.items.every((r: { department: { name: string } }) => r.department.name === 'IT')).toBe(true);
    const finRes = await list(finReqH, { limit: 200 });
    expect(finRes.body.data.total).toBe(30);
    // a Finance requestor's own row in another department is still visible to them (own beats department)
    await AssessmentModel.create({ tenantId: acmeId, requestorId: finReq._id, departmentId: it_._id, status: 'in_progress' });
    expect((await list(finReqH, { limit: 200 })).body.data.total).toBe(31);
    // FREE tenant: own only, no department scope, even if another FREE requestor exists
    const dev = await login('requestor@dev.local');
    const publicId = (await UserModel.findOne({ email: 'requestor@dev.local' }))!.tenantId;
    await AssessmentModel.create({ tenantId: publicId, requestorId: new Types.ObjectId(), status: 'in_progress' });
    expect((await list(dev)).body.data.total).toBe(0);
    // cross-department access widens to the whole tenant
    await UserModel.updateOne({ _id: itLead._id }, { crossDepartmentAccess: true });
    expect((await list(await login('itlead@paid.local'), { limit: 200 })).body.data.total).toBe(61);
  });

  it('filters by status / pending / classification / persona / scenario / department / date; counts follow the other filters [DASH-01, FR-21]', async () => {
    await seedRows(120);
    await UserModel.updateOne({ _id: itLead._id }, { crossDepartmentAccess: true });
    const h = await login('itlead@paid.local');
    const all = await list(h, { limit: 200 });
    expect(all.body.data.total).toBe(120);
    expect(all.body.data.counts).toMatchObject({ in_progress: 20, intake_complete: 20, awaiting_decision: 20, escalated: 20, closed: 20, error_review: 20, pending: 60, all: 120 });

    expect((await list(h, { status: 'closed' })).body.data.total).toBe(20);
    const pending = await list(h, { pending: 'true', limit: 200 });
    expect(pending.body.data.total).toBe(60);
    expect(new Set(pending.body.data.items.map((r: { status: string }) => r.status))).toEqual(new Set(['awaiting_decision', 'escalated', 'error_review']));

    const byClass = await list(h, { classification: 'issue', limit: 200 });
    expect(byClass.body.data.items.every((r: { result: { classification: string } }) => r.result.classification === 'issue')).toBe(true);
    expect(byClass.body.data.total).toBeGreaterThan(0);

    const persona = await list(h, { personaKey: 'it_support', limit: 200 });
    expect(persona.body.data.total).toBe(40);
    expect(persona.body.data.counts.all).toBe(40); // counts respect the persona filter
    expect((await list(h, { scenarioKey: 'phishing_click', limit: 200 })).body.data.total).toBe(40);
    expect((await list(h, { departmentId: String(finance._id), limit: 200 })).body.data.total).toBe(60);

    // date range: the 120 rows span 5 days back from Sept 1 12:00; the last 24 h hold 24 rows (+ the one at t0)
    const from = new Date(base - day).toISOString();
    const to = new Date(base).toISOString();
    expect((await list(h, { from, to, limit: 200 })).body.data.total).toBe(25);
    expect((await list(h, { from: 'yesterday' })).status).toBe(400);
    expect((await list(h, { departmentId: 'not-an-id' })).status).toBe(400);
  });

  it('paginates and keeps pending rows first across pages; newest/oldest ordering [DASH-01]', async () => {
    await seedRows(90);
    await UserModel.updateOne({ _id: itLead._id }, { crossDepartmentAccess: true });
    const h = await login('itlead@paid.local');
    const p1 = await list(h, { limit: 40, page: 1 });
    const p2 = await list(h, { limit: 40, page: 2 });
    const p3 = await list(h, { limit: 40, page: 3 });
    expect(p1.body.data).toMatchObject({ page: 1, limit: 40, total: 90, pages: 3 });
    expect(p1.body.data.items).toHaveLength(40);
    expect(p3.body.data.items).toHaveLength(10);
    const seq = [...p1.body.data.items, ...p2.body.data.items, ...p3.body.data.items] as { _id: string; status: string; createdAt: string }[];
    expect(new Set(seq.map((r) => r._id)).size).toBe(90); // no duplicates / gaps between pages
    const pendingIdx = seq.map((r, i) => (['awaiting_decision', 'escalated', 'error_review'].includes(r.status) ? i : -1)).filter((i) => i >= 0);
    expect(Math.max(...pendingIdx)).toBe(44); // 45 pending rows occupy positions 0..44
    // within a block, newest first
    const first = seq.slice(0, 45).map((r) => new Date(r.createdAt).getTime());
    expect([...first].sort((a, b) => b - a)).toEqual(first);

    const oldest = await list(h, { sort: 'oldest', limit: 3 });
    const times = oldest.body.data.items.map((r: { createdAt: string }) => new Date(r.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Date(times[0]).getTime()).toBe(base - 89 * 3600 * 1000);
    const newest = await list(h, { sort: 'newest', limit: 1 });
    expect(new Date(newest.body.data.items[0].createdAt).getTime()).toBe(base);
    expect((await list(h, { page: 0 })).status).toBe(400);
    expect((await list(h, { limit: 500 })).status).toBe(400);
  });

  it('rows carry the dashboard fields only (class, confidence, explanation, action, requestor, department) [FR-21, SEC-05]', async () => {
    await seedRows(12);
    const res = await list(itLeadH, { status: 'awaiting_decision' });
    const row = res.body.data.items[0];
    expect(row).toMatchObject({ status: 'awaiting_decision', requestor: { name: 'Acme IT Lead', email: 'itlead@paid.local' }, department: { name: 'IT' } });
    expect(row.result).toMatchObject({ classification: expect.any(String), confidence: expect.any(Number), explanation: expect.any(String), recommendedAction: 'Manage the Risk' });
    expect(row.result.factors).toBeUndefined();
    expect(row.answers).toBeUndefined();
    expect(row.facts).toBeUndefined();
    expect(row.requestor.firebaseUid).toBeUndefined();
    expect(row.decision).toBeNull();
    const closed = (await list(itLeadH, { status: 'closed' })).body.data.items[0];
    expect(closed.decision).toMatchObject({ type: 'accept' });
    const early = (await list(itLeadH, { status: 'in_progress' })).body.data.items[0];
    expect(early.result).toBeNull();
  });

  it('lists 500 open assessments in ≤ 3 s [DASH-01, NFR-01]', async () => {
    await seedRows(500);
    await UserModel.updateOne({ _id: itLead._id }, { crossDepartmentAccess: true });
    const h = await login('itlead@paid.local');
    const t0 = Date.now();
    const res = await list(h, { pending: 'true', limit: 50 });
    const ms = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(249); // statuses cycle by 6: 84+84+83+83+83+83; pending = the three 83s
    expect(res.body.data.counts.all).toBe(500);
    expect(ms).toBeLessThan(3000);
  });

  it('GET /departments returns the tenant departments; FREE tenants have none [FR-10, NFR-04]', async () => {
    const res = await request(app).get('/api/v1/departments').set(itLeadH);
    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { name: string }) => d.name)).toEqual(['Finance', 'IT']);
    const dev = await login('requestor@dev.local');
    expect((await request(app).get('/api/v1/departments').set(dev)).body.data).toEqual([]);
    expect((await request(app).get('/api/v1/departments')).status).toBe(401);
  });
});
