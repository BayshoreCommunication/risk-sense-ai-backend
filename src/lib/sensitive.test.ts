import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../tests/helpers';
import { AssessmentMessageModel, AssessmentModel } from '../modules/assessments/model';
import { AuditLogModel } from '../modules/audit/model';
import { DepartmentModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';
import { classFor, maskAssessmentView, maskText } from './sensitive';

/** SEC-05: sensitive fields are masked for non-acting readers; unmasking is logged; exports never carry them. */
describe('sensitive field masking [SEC-05, FR-23]', () => {
  let id: string;
  let admin: Record<string, string>;
  let owner: Record<string, string>;
  const SECRET = 'Patient John Doe (MRN 4471) was given the wrong dose on ward 3.';

  beforeEach(async () => {
    const { acme } = await seeded();
    const finance = (await DepartmentModel.findOne({ tenantId: acme._id, name: 'Finance' }))!;
    const req = (await UserModel.findOne({ email: 'requestor@paid.local' }))!;
    const doc = await AssessmentModel.create({
      tenantId: acme._id, requestorId: req._id, departmentId: finance._id, status: 'closed', phase: 'done', sector: 'healthcare',
      personaKey: 'healthcare_compliance_officer', scenarioKey: 'hc_patient_safety_incident', openingText: SECRET,
      answers: [{ questionKey: 'q1', text: SECRET }, { questionKey: 'q2', value: 'opt_a' }],
      facts: [{ key: 'harm', value: 'wrong dose given to John Doe', source: 'ai', confidence: 0.9, evidence: SECRET }, { key: 'reported', value: true, source: 'mcq', confidence: 1 }],
      result: { score: 70, classification: 'elevated_risk', computedClassification: 'elevated_risk', confidence: 88, ruleDriven: false, professionalConsult: false, mandatoryReview: false, explanation: 'A patient received the wrong dose.', recommendedAction: 'Manage the Risk', computedAt: new Date() },
      decision: { type: 'override', byUserId: req._id, overriddenTo: 'issue', reason: 'John Doe was harmed; escalating to the medical director immediately.', decidedAt: new Date() },
      timing: { startedAt: new Date(), closedAt: new Date(), durationSec: 100 },
    });
    id = String(doc._id);
    await AssessmentMessageModel.create([
      { tenantId: acme._id, assessmentId: doc._id, role: 'user', kind: 'answer', content: SECRET },
      { tenantId: acme._id, assessmentId: doc._id, role: 'assistant', kind: 'question', content: 'Was the incident reported?' },
    ]);
    admin = await login('admin@paid.local');
    owner = await login('requestor@paid.local');
  });

  it('pure helpers: class by sector, text and email masks keep shape only', () => {
    expect(classFor('healthcare')).toBe('phi');
    expect(classFor('financial')).toBe('financial');
    expect(classFor('it')).toBe('pii');
    expect(maskText('jane.doe@acme.com')).toBe('j•••@acme.com');
    expect(maskText(SECRET)).toBe(`P••• (${SECRET.length} chars)`);
    expect(maskText(42)).toBe(42);
    expect(maskText('')).toBe('');
    const v = maskAssessmentView({ openingText: 'abc', facts: [{ source: 'ai', value: 'x-ray' }, { source: 'mcq', value: 'yes' }], decision: { reason: 'why' } }, 'healthcare');
    expect(v.masked).toBe('phi');
    expect(v.openingText).toBe('a••• (3 chars)');
    expect((v.facts as { value: unknown }[]).map((f) => f.value)).toEqual(['x••• (5 chars)', 'yes']);
  });

  it('administrators read masked; unmask=true returns clear values and is audited; the owner always reads clear', async () => {
    const masked = (await request(app).get(`/api/v1/assessments/${id}`).set(admin)).body.data;
    expect(masked.masked).toBe('phi');
    expect(masked.openingText).not.toContain('John');
    expect(masked.facts.find((f: { key: string }) => f.key === 'harm').value).not.toContain('John');
    expect(masked.facts.find((f: { key: string }) => f.key === 'reported').value).toBe(true);
    expect(masked.decision.reason).not.toContain('John');
    expect(masked.result.explanation).toContain('wrong dose'); // AI prose is not a registered field
    const msgs = (await request(app).get(`/api/v1/assessments/${id}/messages`).set(admin)).body.data;
    expect(msgs[0].content).not.toContain('John');
    expect(msgs[0].masked).toBe('phi');
    expect(msgs[1].content).toBe('Was the incident reported?');
    expect(await AuditLogModel.countDocuments({ action: 'access.unmasked' })).toBe(0);

    const clear = (await request(app).get(`/api/v1/assessments/${id}`).set(admin).query({ unmask: 'true' })).body.data;
    expect(clear.masked).toBeNull();
    expect(clear.openingText).toBe(SECRET);
    const entry = await AuditLogModel.findOne({ action: 'access.unmasked', 'entity.id': id }).lean();
    expect(entry).toBeTruthy();
    expect(entry!.category).toBe('access');
    expect(entry!.payload).toMatchObject({ what: 'assessment', sector: 'healthcare' });
    expect(entry!.actorRole).toBe('administrator');

    const own = (await request(app).get(`/api/v1/assessments/${id}`).set(owner)).body.data;
    expect(own.masked).toBeNull();
    expect(own.openingText).toBe(SECRET);
    expect(await AuditLogModel.countDocuments({ action: 'access.unmasked' })).toBe(1); // the owner's read is not an unmask event
  });

  it('list rows mask the requestor email for privileged readers; reconstruction masks user text and payloads unless unmasked', async () => {
    const rows = (await request(app).get('/api/v1/assessments').set(admin)).body.data.items;
    expect(rows[0].requestor).toMatchObject({ name: 'Acme Finance Requestor', email: 'r•••@paid.local' });
    const ownRows = (await request(app).get('/api/v1/assessments').set(owner)).body.data.items;
    expect(ownRows[0].requestor.email).toBe('requestor@paid.local');
    const rec = (await request(app).get(`/api/v1/assessments/${id}/reconstruct`).set(admin)).body.data;
    expect(rec.masked).toBe('phi');
    expect(JSON.stringify(rec)).not.toContain('John Doe');
    const recClear = (await request(app).get(`/api/v1/assessments/${id}/reconstruct`).set(admin).query({ unmask: 'true' })).body.data;
    expect(recClear.masked).toBeNull();
    expect(await AuditLogModel.countDocuments({ action: 'access.unmasked', 'payload.what': 'reconstruction' })).toBe(1);
  });

  it('report override reasons are masked for privileged readers unless unmasked (audited); exports never contain free text', async () => {
    const q = { from: '2026-01-01', to: '2027-01-01' };
    const masked = (await request(app).get('/api/v1/reports/override-rate').set(admin).query(q)).body.data;
    const reasons = JSON.parse(masked.summary.reasons);
    expect(reasons[0].reason).not.toContain('John');
    const clear = (await request(app).get('/api/v1/reports/override-rate').set(admin).query({ ...q, unmask: 'true' })).body.data;
    expect(JSON.parse(clear.summary.reasons)[0].reason).toContain('John Doe');
    expect(await AuditLogModel.countDocuments({ action: 'access.unmasked', 'entity.type': 'report' })).toBe(1);
    const ownerView = (await request(app).get('/api/v1/reports/override-rate').set(owner).query(q)).body.data;
    expect(JSON.parse(ownerView.summary.reasons)[0].reason).toContain('John Doe'); // acts on the record → clear, no audit
    for (const type of ['volume', 'classification', 'override-rate', 'assessment-time']) {
      const csv = await request(app).get(`/api/v1/reports/${type}/export`).set(admin).query({ ...q, format: 'csv', unmask: 'true' });
      expect(csv.text).not.toContain('John');
      expect(csv.text).not.toContain('MRN');
    }
  });
});
