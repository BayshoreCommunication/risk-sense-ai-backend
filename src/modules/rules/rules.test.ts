import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AuditLogModel } from '../audit/model';
import { matches, parseLeaf } from '../shared/conditions';
import { evaluate } from './engine';

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

  it('editing an approved/active rule sends it back to draft', async () => {
    const created = await request(app).post('/api/v1/rules').set(admin).send(body);
    const id = created.body.data._id;
    await request(app).post(`/api/v1/rules/${id}/approve`).set(admin2);
    const edit = await request(app).patch(`/api/v1/rules/${id}`).set(admin).send({ priority: 5 });
    expect(edit.body.data).toMatchObject({ status: 'draft', priority: 5 });
    expect(edit.body.data.approvedBy).toBeUndefined();
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
