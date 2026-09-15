import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { matches, parseLeaf } from '../shared/conditions';
import { evaluate } from './engine';
import { RuleModel } from './model';

describe('conditions (shared engine)', () => {
  it('normalizes yes/no/true/false and numeric strings before comparing', () => {
    expect(matches({ factKey: 'fraud', op: 'eq', value: true }, { fraud: 'yes' })).toBe(true);
    expect(matches({ factKey: 'fraud', op: 'eq', value: 'yes' }, { fraud: true })).toBe(true);
    expect(matches({ factKey: 'amount', op: 'gt', value: 100 }, { amount: '250' })).toBe(true);
    expect(matches({ factKey: 'amount', op: 'gt', value: 100 }, { amount: 'n/a' })).toBe(false);
    expect(matches({ factKey: 'missing', op: 'exists' }, {})).toBe(false);
    expect(matches({ factKey: 'status', op: 'in', value: ['active', 'contained'] }, { status: 'Active' })).toBe(true);
  });
  it('supports all/any groups', () => {
    const c = { all: [{ factKey: 'a', op: 'eq' as const, value: 1 }, { any: [{ factKey: 'b', op: 'eq' as const, value: 2 }, { factKey: 'c', op: 'eq' as const, value: 3 }] }] };
    expect(matches(c, { a: 1, c: 3 })).toBe(true);
    expect(matches(c, { a: 1, b: 9 })).toBe(false);
  });
  it('parses template leaves', () => {
    expect(parseLeaf('amount_usd > 100000')).toEqual({ factKey: 'amount_usd', op: 'gt', value: 100000 });
    expect(parseLeaf('fraud_confirmed = confirmed')).toEqual({ factKey: 'fraud_confirmed', op: 'eq', value: 'confirmed' });
    expect(parseLeaf('patient_safety_compromised = yes')).toEqual({ factKey: 'patient_safety_compromised', op: 'eq', value: true });
    expect(parseLeaf('nonsense')).toBeNull();
  });
});

describe('rules engine (FR-17, DecisionLog 10)', () => {
  const r = (key: string, cls: 'risk' | 'elevated_risk' | 'issue', priority: number, factKey = 'x') => ({
    id: key,
    key,
    name: key,
    trigger: { factKey, op: 'eq' as const, value: true },
    forcedClassification: cls,
    priority,
  });
  it('returns null when nothing fires', () => {
    expect(evaluate([r('a', 'issue', 1)], { x: false })).toBeNull();
  });
  it('lowest priority number wins', () => {
    const res = evaluate([r('low', 'risk', 50), r('high', 'issue', 10)], { x: true });
    expect(res?.ruleKey).toBe('high');
    expect(res?.fired).toHaveLength(2);
  });
  it('ties resolve to the most severe classification', () => {
    const res = evaluate([r('a', 'risk', 10), r('b', 'issue', 10), r('c', 'elevated_risk', 10)], { x: true });
    expect(res?.classification).toBe('issue');
  });
});

describe('rules change control (FR-16, AI-05)', () => {
  let admin: Record<string, string>;
  let admin2: Record<string, string>;
  const body = {
    key: 'confirmed_fraud',
    name: 'Confirmed fraud is always an Issue',
    trigger: { factKey: 'fraud_confirmed', op: 'eq', value: 'confirmed' },
    forcedClassification: 'issue',
    forcedAction: 'Contact Law Enforcement',
    priority: 10,
  };

  beforeEach(async () => {
    await seeded();
    admin = await login('admin@dev.local');
    admin2 = await login('admin2@dev.local');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('create → self-approve blocked → approve by other → activate; activation without approval refused', async () => {
    const created = await request(app).post('/api/v1/rules').set(admin).send(body);
    expect(created.status).toBe(201);
    const id = created.body.data._id;
    const early = await request(app).post(`/api/v1/rules/${id}/activate`).set(admin);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('NOT_APPROVED');
    const self = await request(app).post(`/api/v1/rules/${id}/approve`).set(admin).send({ changeRef: 'CR-1' });
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('SELF_APPROVAL');
    const ok = await request(app).post(`/api/v1/rules/${id}/approve`).set(admin2).send({ changeRef: 'CR-1' });
    expect(ok.body.data).toMatchObject({ status: 'approved', changeRef: 'CR-1' });
    const act = await request(app).post(`/api/v1/rules/${id}/activate`).set(admin);
    expect(act.body.data.status).toBe('active');
    expect(await AuditLogModel.countDocuments({ action: { $in: ['rule.created', 'rule.approved', 'rule.activated'] } })).toBe(3);
  });

  it('an active-rule edit creates a separate draft, keeps v1 effective, and its editor cannot approve it [AI-05]', async () => {
    const created = await request(app).post('/api/v1/rules').set(admin).send(body);
    const id = created.body.data._id;
    await request(app).post(`/api/v1/rules/${id}/approve`).set(admin2).send({ changeRef: 'RULE-V1' });
    await request(app).post(`/api/v1/rules/${id}/activate`).set(admin);

    const edit = await request(app).patch(`/api/v1/rules/${id}`).set(admin2).send({ priority: 5 });
    const replacementId = edit.body.data._id;
    expect(replacementId).not.toBe(id);
    expect(edit.body.data).toMatchObject({ version: 2, status: 'draft', isCurrent: false, priority: 5 });
    expect(edit.body.data.approvedBy).toBeUndefined();

    const stillEffective = await RuleModel.findById(id).lean();
    expect(stillEffective).toMatchObject({ version: 1, status: 'active', isCurrent: true, priority: 10 });
    const latestEdit = await request(app).patch(`/api/v1/rules/${replacementId}`).set(admin).send({ forcedAction: 'Escalate immediately' });
    expect(latestEdit.body.data).toMatchObject({ _id: replacementId, version: 2, status: 'draft', forcedAction: 'Escalate immediately' });
    const missingRef = await request(app).post(`/api/v1/rules/${replacementId}/approve`).set(admin2).send({});
    expect(missingRef.status).toBe(400);
    const self = await request(app).post(`/api/v1/rules/${replacementId}/approve`).set(admin).send({ changeRef: 'RULE-V2' });
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('SELF_APPROVAL');

    const checked = await request(app).post(`/api/v1/rules/${replacementId}/approve`).set(admin2).send({ changeRef: 'RULE-V2' });
    expect(checked.status).toBe(200);
    expect((await RuleModel.findById(id).lean())?.status).toBe('active');
    await request(app).post(`/api/v1/rules/${replacementId}/activate`).set(admin);
    expect(await RuleModel.findById(id).lean()).toMatchObject({ status: 'retired', isCurrent: false });
    expect(await RuleModel.findById(replacementId).lean()).toMatchObject({ status: 'active', isCurrent: true });
    const history = await request(app).get(`/api/v1/rules/${replacementId}/history`).set(admin);
    expect(history.status).toBe(200);
    expect(history.body.data.map((version: { version: number }) => version.version)).toEqual([2, 1]);
  });

  it('does not activate a legacy rule whose approval record has no change reference [AI-05]', async () => {
    const created = await request(app).post('/api/v1/rules').set(admin).send(body);
    await request(app).post(`/api/v1/rules/${created.body.data._id}/approve`).set(admin2).send({ changeRef: 'LEGACY-1' });
    await RuleModel.updateOne({ _id: created.body.data._id }, { $unset: { changeRef: 1 } });

    const activation = await request(app).post(`/api/v1/rules/${created.body.data._id}/activate`).set(admin);

    expect(activation.status).toBe(422);
    expect(activation.body.error.code).toBe('NOT_APPROVED');
  });

  it('rolls back the current-version swap when the activation audit fails, then retries cleanly [AI-04, AI-05, SEC-07]', async () => {
    const created = await request(app).post('/api/v1/rules').set(admin).send(body);
    const originalId = created.body.data._id;
    await request(app).post(`/api/v1/rules/${originalId}/approve`).set(admin2).send({ changeRef: 'RULE-V1' });
    await request(app).post(`/api/v1/rules/${originalId}/activate`).set(admin);
    const edit = await request(app).patch(`/api/v1/rules/${originalId}`).set(admin).send({ priority: 5 });
    const replacementId = edit.body.data._id;
    await request(app).post(`/api/v1/rules/${replacementId}/approve`).set(admin2).send({ changeRef: 'RULE-V2' });

    const writeAudit = audit.write.bind(audit);
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'rule.activated' && entry.entity.id === replacementId) throw new Error('forced rule activation audit failure');
      return writeAudit(entry);
    });
    const failed = await request(app).post(`/api/v1/rules/${replacementId}/activate`).set(admin);
    expect(failed.status).toBe(500);
    expect(await RuleModel.findById(originalId).lean()).toMatchObject({ status: 'active', isCurrent: true });
    expect(await RuleModel.findById(replacementId).lean()).toMatchObject({ status: 'approved', isCurrent: false });
    expect(await AuditLogModel.countDocuments({ action: 'rule.activated', 'entity.id': replacementId })).toBe(0);

    writeSpy.mockRestore();
    const retry = await request(app).post(`/api/v1/rules/${replacementId}/activate`).set(admin);
    expect(retry.status).toBe(200);
    expect(await RuleModel.findById(originalId).lean()).toMatchObject({ status: 'retired', isCurrent: false });
    expect(await RuleModel.findById(replacementId).lean()).toMatchObject({ status: 'active', isCurrent: true });
    expect(await AuditLogModel.countDocuments({ action: 'rule.activated', 'entity.id': replacementId })).toBe(1);
  });

  it('reconciles legacy active rules that are ineffective or missing their activation audit [AI-05, SEC-07]', async () => {
    const ineffective = await request(app).post('/api/v1/rules').set(admin).send(body);
    const ineffectiveId = ineffective.body.data._id;
    await request(app).post(`/api/v1/rules/${ineffectiveId}/approve`).set(admin2).send({ changeRef: 'LEGACY-INACTIVE' });
    await RuleModel.updateOne(
      { tenantId: ineffective.body.data.tenantId, _id: ineffectiveId },
      { $set: { status: 'active', isCurrent: false, activatedAt: new Date() } },
    );

    const repaired = await request(app).post(`/api/v1/rules/${ineffectiveId}/activate`).set(admin);
    expect(repaired.status).toBe(200);
    expect(await RuleModel.findById(ineffectiveId).lean()).toMatchObject({ status: 'active', isCurrent: true });
    expect(await AuditLogModel.countDocuments({ action: 'rule.activated', 'entity.id': ineffectiveId })).toBe(1);

    await AuditLogModel.collection.deleteOne({ action: 'rule.activated', 'entity.id': ineffectiveId });
    expect(await AuditLogModel.countDocuments({ action: 'rule.activated', 'entity.id': ineffectiveId })).toBe(0);
    const auditRepaired = await request(app).post(`/api/v1/rules/${ineffectiveId}/activate`).set(admin);
    expect(auditRepaired.status).toBe(200);
    expect(await AuditLogModel.countDocuments({ action: 'rule.activated', 'entity.id': ineffectiveId })).toBe(1);
  });

  it('rejects an invalid condition and a bad classification', async () => {
    const bad = await request(app).post('/api/v1/rules').set(admin).send({ ...body, trigger: { factKey: 'x' } });
    expect(bad.status).toBe(400);
    const bad2 = await request(app).post('/api/v1/rules').set(admin).send({ ...body, key: 'k2', forcedClassification: 'critical' });
    expect(bad2.status).toBe(400);
  });

  it('parses the scoring-sheet hard_rules cell', async () => {
    const { rulesService } = await import('./service');
    const parsed = rulesService.parseSheetRules('fraud_confirmed = confirmed => issue; records_affected > 500 => issue; bogus');
    expect(parsed.rules).toHaveLength(2);
    expect(parsed.rules[0]).toMatchObject({ forcedClassification: 'issue', priority: 10, trigger: { factKey: 'fraud_confirmed', op: 'eq', value: 'confirmed' } });
    expect(parsed.errors).toHaveLength(1);
  });
});
