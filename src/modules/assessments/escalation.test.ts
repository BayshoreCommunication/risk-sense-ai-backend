import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AuditLogModel } from '../audit/model';
import { DepartmentModel } from '../tenants/model';
import { UserModel } from '../users/model';
import { AssessmentModel } from './model';

/** T-061 escalation routing (PAID) and the AI-03 mandatory-review queue filter. */
describe('escalation targets and mandatory review [T-061, AI-03, DASH-04]', () => {
  let acmeId: Types.ObjectId;
  let finance: Types.ObjectId;
  let finReq: Record<string, string>;
  let colleague: Record<string, string>;
  let itLead: Record<string, string>;
  let colleagueId: string;
  let itLeadId: string;
  let crossId: string;

  const awaiting = (requestorId: Types.ObjectId, departmentId: Types.ObjectId, extra: Record<string, unknown> = {}) =>
    AssessmentModel.create({
      tenantId: acmeId,
      requestorId,
      departmentId,
      status: 'awaiting_decision',
      phase: 'done',
      personaKey: 'finance_officer',
      scenarioKey: 'unauthorized_wire',
      result: { score: 48, classification: 'risk', computedClassification: 'risk', confidence: 35, ruleDriven: false, professionalConsult: true, mandatoryReview: true, explanation: 'Low confidence.', keyDrivers: [], recommendedAction: 'Further Professional Risk Guidance Needed', nextSteps: [], factors: {}, computedAt: new Date() },
      ...extra,
    });

  beforeEach(async () => {
    const { acme } = await seeded();
    acmeId = acme._id;
    finance = (await DepartmentModel.findOne({ tenantId: acmeId, name: 'Finance' }))!._id;
    const c = (await UserModel.findOne({ email: 'colleague@paid.local' }))!; // seeded Finance colleague
    const x = await UserModel.create({ firebaseUid: 'dev:cross', email: 'cross@paid.local', name: 'Cross Reviewer', role: 'requestor', tenantId: acmeId, departmentIds: [], crossDepartmentAccess: true });
    colleagueId = String(c._id);
    crossId = String(x._id);
    itLeadId = String((await UserModel.findOne({ email: 'itlead@paid.local' }))!._id);
    finReq = await login('requestor@paid.local');
    colleague = await login('colleague@paid.local');
    itLead = await login('itlead@paid.local');
  });

  it('lists same-department and cross-department requestors, never the caller or other departments; FREE gets none [T-061]', async () => {
    const finId = (await UserModel.findOne({ email: 'requestor@paid.local' }))!._id;
    const a = await awaiting(finId, finance);
    const res = await request(app).get(`/api/v1/assessments/${a._id}/escalation-targets`).set(finReq);
    expect(res.status).toBe(200);
    expect(res.body.data.map((t: { name: string }) => t.name)).toEqual(['Acme Finance Colleague', 'Cross Reviewer']);
    // another department's lead cannot even read it → 403
    expect((await request(app).get(`/api/v1/assessments/${a._id}/escalation-targets`).set(itLead)).status).toBe(403);
    // FREE tenant: no routing
    const dev = await login('requestor@dev.local');
    const devUser = (await UserModel.findOne({ email: 'requestor@dev.local' }))!;
    const free = await AssessmentModel.create({ tenantId: devUser.tenantId, requestorId: devUser._id, status: 'awaiting_decision', phase: 'done', result: { score: 30, classification: 'risk', computedClassification: 'risk', confidence: 80, ruleDriven: false, professionalConsult: false, mandatoryReview: false, explanation: 'x', recommendedAction: 'Manage the Risk', computedAt: new Date() } });
    expect((await request(app).get(`/api/v1/assessments/${free._id}/escalation-targets`).set(dev)).body.data).toEqual([]);
    const routed = await request(app).post(`/api/v1/assessments/${free._id}/decision`).set(dev).send({ type: 'escalate', escalateToUserId: colleagueId });
    expect(routed.status).toBe(403);
    expect(routed.body.error.code).toBe('FEATURE_DISABLED');
  });

  it('escalates to a reviewer who then sees it, finds it under escalatedToMe, and can decide; wrong targets are rejected [T-061, FR-22, DASH-04]', async () => {
    const finId = (await UserModel.findOne({ email: 'requestor@paid.local' }))!._id;
    const a = await awaiting(finId, finance);
    const id = String(a._id);
    const post = (h: Record<string, string>, body: unknown) => request(app).post(`/api/v1/assessments/${id}/decision`).set(h).send(body);

    expect((await post(finReq, { type: 'accept', escalateToUserId: colleagueId })).status).toBe(400); // only escalations name a reviewer
    const bad = await post(finReq, { type: 'escalate', escalateToUserId: itLeadId }); // IT lead: other department, no cross access
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const esc = await post(finReq, { type: 'escalate', escalateToUserId: crossId, reason: 'Needs treasury sign-off' });
    expect(esc.status).toBe(200);
    expect(esc.body.data).toMatchObject({ status: 'escalated', escalatedTo: { _id: crossId, name: 'Cross Reviewer' } });
    const audit = await AuditLogModel.findOne({ action: 'decision.recorded', 'entity.id': id }).lean();
    expect(audit!.payload).toMatchObject({ type: 'escalate', escalatedToUserId: crossId });

    // Re-route to the Finance colleague (still escalated) — the colleague is not in cross's reach but is in the requestor's.
    const re = await post(finReq, { type: 'escalate', escalateToUserId: colleagueId });
    expect(re.body.data.escalatedTo.name).toBe('Acme Finance Colleague');

    // The colleague sees it in their list (department scope) and under escalatedToMe; the transcript names them.
    const mine = await request(app).get('/api/v1/assessments').set(colleague).query({ escalatedToMe: 'true' });
    expect(mine.body.data.total).toBe(1);
    expect(mine.body.data.items[0]).toMatchObject({ status: 'escalated', escalatedTo: { name: 'Acme Finance Colleague' } });
    const msgs = await request(app).get(`/api/v1/assessments/${id}/messages`).set(colleague);
    expect(msgs.body.data.at(-1).content).toContain('Escalated to Acme Finance Colleague');

    // The colleague decides; the decision carries their id (FR-22) and the assessment closes.
    const acc = await post(colleague, { type: 'accept' });
    expect(acc.status).toBe(200);
    expect(acc.body.data.status).toBe('closed');
    const doc = await AssessmentModel.findById(id).lean();
    expect(String(doc!.decision!.byUserId)).toBe(colleagueId);
    expect(String(doc!.escalatedToUserId)).toBe(colleagueId); // kept as history
  });

  it('an escalatee outside the department can read and list it only because it was routed to them [T-061, DASH-04]', async () => {
    // Put the IT lead into a reachable position via cross access, escalate, then remove the access: the routing alone keeps visibility.
    await UserModel.updateOne({ _id: itLeadId }, { crossDepartmentAccess: true });
    const finId = (await UserModel.findOne({ email: 'requestor@paid.local' }))!._id;
    const a = await awaiting(finId, finance);
    const id = String(a._id);
    expect((await request(app).post(`/api/v1/assessments/${id}/decision`).set(finReq).send({ type: 'escalate', escalateToUserId: itLeadId })).status).toBe(200);
    await UserModel.updateOne({ _id: itLeadId }, { crossDepartmentAccess: false });
    const it = await login('itlead@paid.local');
    expect((await request(app).get(`/api/v1/assessments/${id}`).set(it)).status).toBe(200);
    const list = await request(app).get('/api/v1/assessments').set(it).query({ status: 'escalated' });
    expect(list.body.data.items.map((r: { _id: string }) => r._id)).toEqual([id]);
    // …but a second Finance assessment that was never routed stays invisible to them.
    const other = await awaiting(finId, finance);
    expect((await request(app).get(`/api/v1/assessments/${other._id}`).set(it)).status).toBe(403);
  });

  it('mandatoryReview=true lists only flagged assessments, tenant-wide for administrators [AI-03]', async () => {
    const finId = (await UserModel.findOne({ email: 'requestor@paid.local' }))!._id;
    await awaiting(finId, finance); // flagged (confidence 35)
    await awaiting(finId, finance, { result: { score: 60, classification: 'elevated_risk', computedClassification: 'elevated_risk', confidence: 90, ruleDriven: false, professionalConsult: false, mandatoryReview: false, explanation: 'ok', recommendedAction: 'Manage the Risk', computedAt: new Date() } });
    await awaiting(finId, finance, { status: 'closed', decision: { type: 'accept', byUserId: finId, decidedAt: new Date() } }); // flagged but already decided
    const all = await request(app).get('/api/v1/assessments').set(finReq).query({ mandatoryReview: 'true' });
    expect(all.body.data.total).toBe(2);
    expect(all.body.data.counts).toMatchObject({ awaiting_decision: 1, closed: 1, pending: 1 });
    const queue = await request(app).get('/api/v1/assessments').set(finReq).query({ mandatoryReview: 'true', pending: 'true' });
    expect(queue.body.data.items.map((r: { result: { confidence: number } }) => r.result.confidence)).toEqual([35]);
    // an administrator of the public tenant sees nothing from acme (tenant isolation, NFR-04); Acme's administrator sees the queue tenant-wide
    const admin = await login('admin@dev.local');
    expect((await request(app).get('/api/v1/assessments').set(admin).query({ mandatoryReview: 'true' })).body.data.total).toBe(0);
    const acmeAdmin = await login('admin@paid.local');
    expect((await request(app).get('/api/v1/assessments').set(acmeAdmin).query({ mandatoryReview: 'true', pending: 'true' })).body.data.total).toBe(1);
  });
});
