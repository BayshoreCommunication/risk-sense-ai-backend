import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../tests/helpers';
import { AssessmentMessageModel, AssessmentModel } from '../modules/assessments/model';
import { AuditLogModel } from '../modules/audit/model';
import { audit } from '../modules/audit/service';
import { DepartmentModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';
import { classFor, maskAssessmentView, maskAuditPayload, maskText } from './sensitive';

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
      { tenantId: acme._id, assessmentId: doc._id, role: 'assistant', kind: 'result', content: `Result summary: ${SECRET}` },
      { tenantId: acme._id, assessmentId: doc._id, role: 'system', kind: 'info', content: 'Assessment processing complete.' },
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
    expect(maskText(42)).toBe('•••');
    expect(maskText('')).toBe('');
    const v = maskAssessmentView(
      {
        openingText: 'abc',
        facts: [{ source: 'ai', value: 'x-ray' }, { source: 'mcq', value: 'yes' }],
        decision: { reason: 'why' },
        requestor: { name: 'Jane Doe', email: 'jane@example.com' },
        escalatedTo: { name: 'John Doe' },
      },
      'healthcare',
    );
    expect(v.masked).toBe('phi');
    expect(v.openingText).toBe('a••• (3 chars)');
    expect((v.facts as { value: unknown }[]).map((f) => f.value)).toEqual(['x••• (5 chars)', 'yes']);
    expect(v.requestor).toEqual({ name: 'J••• (8 chars)', email: 'j•••@example.com' });
    expect(v.escalatedTo).toEqual({ name: 'J••• (8 chars)' });
    expect(maskAuditPayload({ user: { name: 'Jane Doe', email: 'jane@example.com' } })).toEqual({
      user: { name: 'J••• (8 chars)', email: 'j•••@example.com' },
    });
  });

  it('administrators read masked; unmask=true returns clear values and is audited; the owner always reads clear', async () => {
    const masked = (await request(app).get(`/api/v1/assessments/${id}`).set(admin)).body.data;
    expect(masked.masked).toBe('phi');
    expect(masked.openingText).not.toContain('John');
    expect(masked.facts.find((f: { key: string }) => f.key === 'harm').value).not.toContain('John');
    expect(masked.facts.find((f: { key: string }) => f.key === 'reported').value).toBe(true);
    expect(masked.decision.reason).not.toContain('John');
    expect(masked.result.explanation).not.toContain('wrong dose');
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

  it('masks assistant result messages while preserving question and system messages [SEC-05]', async () => {
    const messages = (await request(app).get(`/api/v1/assessments/${id}/messages`).set(admin)).body.data as Array<Record<string, unknown>>;
    const result = messages.find((message) => message.kind === 'result')!;
    const question = messages.find((message) => message.kind === 'question')!;
    const system = messages.find((message) => message.role === 'system')!;

    expect(result).toMatchObject({ role: 'assistant', kind: 'result', masked: 'phi' });
    expect(result.content).not.toContain('John Doe');
    expect(question.content).toBe('Was the incident reported?');
    expect(question).not.toHaveProperty('masked');
    expect(system.content).toBe('Assessment processing complete.');
    expect(system).not.toHaveProperty('masked');

    const ownerMessages = (await request(app).get(`/api/v1/assessments/${id}/messages`).set(owner)).body.data as Array<Record<string, unknown>>;
    expect(ownerMessages.find((message) => message.kind === 'result')!.content).toContain('John Doe');
  });

  it('list rows mask registered identity and explanation fields for privileged readers; reconstruction masks user text and payloads unless unmasked [SEC-05, SEC-07]', async () => {
    const rows = (await request(app).get('/api/v1/assessments').set(admin)).body.data.items;
    expect(rows[0].requestor).toMatchObject({ name: 'A••• (22 chars)', email: 'r•••@paid.local' });
    expect(rows[0].result.explanation).not.toContain('wrong dose');
    expect(rows[0].masked).toBe('phi');
    const ownRows = (await request(app).get('/api/v1/assessments').set(owner)).body.data.items;
    expect(ownRows[0].requestor.email).toBe('requestor@paid.local');
    const rec = (await request(app).get(`/api/v1/assessments/${id}/reconstruct`).set(admin)).body.data;
    expect(rec.masked).toBe('phi');
    expect(JSON.stringify(rec)).not.toContain('John Doe');
    const recClear = (await request(app).get(`/api/v1/assessments/${id}/reconstruct`).set(admin).query({ unmask: 'true' })).body.data;
    expect(recClear.masked).toBeNull();
    expect(await AuditLogModel.countDocuments({ action: 'access.unmasked', 'payload.what': 'reconstruction' })).toBe(1);
  });

  it('masks result prose and every answer/fact primitive in reconstruction and differences [SEC-05, FR-26]', async () => {
    const doc = (await AssessmentModel.findById(id))!;
    await audit.write({
      tenantId: String(doc.tenantId),
      category: 'assessment',
      action: 'assessment.answered',
      actor: null,
      entity: { type: 'assessment', id },
      payload: { questionKey: 'diagnosis', answer: 'HIV', facts: [{ key: 'diagnosis', value: 'HIV' }], branched: [] },
    });
    await audit.write({
      tenantId: String(doc.tenantId),
      category: 'assessment',
      action: 'assessment.answered',
      actor: null,
      entity: { type: 'assessment', id },
      payload: { questionKey: 'memberNumber', answer: 4471, facts: [{ key: 'memberNumber', value: 4471 }], branched: [] },
    });
    await audit.write({
      tenantId: String(doc.tenantId),
      category: 'assessment',
      action: 'assessment.scored',
      actor: null,
      entity: { type: 'assessment', id },
      payload: { score: 70, computedClassification: 'elevated_risk', factors: { severity: 80 } },
    });
    await audit.write({
      tenantId: String(doc.tenantId),
      category: 'assessment',
      action: 'assessment.recommended',
      actor: null,
      entity: { type: 'assessment', id },
      payload: { classification: 'elevated_risk', confidence: 88, ruleDriven: false, recommendedAction: 'Manage the Risk', explanation: SECRET },
    });

    const masked = (await request(app).get(`/api/v1/assessments/${id}/reconstruct`).set(admin)).body.data;
    expect(masked.state.answers[0].answer).toBe('H••• (3 chars)');
    expect(masked.state.answers[1].answer).toBe('•••');
    expect(masked.state.facts.diagnosis).toBe('H••• (3 chars)');
    expect(masked.state.facts.memberNumber).toBe('•••');
    expect(masked.state.explanation).toBe(`P••• (${SECRET.length} chars)`);
    expect(masked.state.score).toBe(70);
    expect(masked.state.confidence).toBe(88);
    expect(masked.conformance.differences.find((difference: { field: string }) => difference.field === 'facts.memberNumber')).toMatchObject({
      fromAudit: '•••',
      stored: null,
    });

    const clear = (await request(app).get(`/api/v1/assessments/${id}/reconstruct`).set(admin).query({ unmask: 'true' })).body.data;
    expect(clear.state.answers[0].answer).toBe('HIV');
    expect(clear.state.answers[1].answer).toBe(4471);
    expect(clear.state.facts.diagnosis).toBe('HIV');
    expect(clear.state.facts.memberNumber).toBe(4471);
    expect(clear.state.explanation).toBe(SECRET);
    expect(clear.conformance.differences.find((difference: { field: string }) => difference.field === 'facts.memberNumber')).toMatchObject({
      fromAudit: 4471,
      stored: null,
    });
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
