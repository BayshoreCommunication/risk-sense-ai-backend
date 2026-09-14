import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from './helpers';
import { AssessmentModel } from '../modules/assessments/model';
import { AuditLogModel } from '../modules/audit/model';
import { PersonaModel } from '../modules/personas/model';
import { QuestionModel } from '../modules/questions/model';
import { RuleModel } from '../modules/rules/model';
import { ScenarioModel } from '../modules/scenarios/model';
import { MatrixModel } from '../modules/scoring/model';
import { DepartmentModel, TenantModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';

/**
 * T-084 / NFR-04: multi-tenant guard audit. Tenant A's data must be invisible to tenant B through every read
 * route, and every request-path query in the modules must be tenant-scoped (static scan below).
 */
describe('multi-tenant isolation [NFR-04, SEC-01]', () => {
  let acmeId: Types.ObjectId;
  let publicId: Types.ObjectId;
  let acmeAdmin: Record<string, string>;
  let acmeReq: Record<string, string>;
  let publicAdmin: Record<string, string>;
  let publicAuditor: Record<string, string>;
  let ids: Record<string, string>;

  beforeEach(async () => {
    const { acme, publicTenant } = await seeded();
    acmeId = acme._id;
    publicId = publicTenant._id;
    // acme gets its own content + an assessment + audit entries; the public tenant has none of it
    const admin = (await UserModel.findOne({ email: 'admin@paid.local' }))!;
    const req = (await UserModel.findOne({ email: 'requestor@paid.local' }))!;
    const persona = await PersonaModel.create({ tenantId: acmeId, key: 'acme_only_persona', name: 'Acme Only', description: 'x', sector: 'financial', status: 'draft', version: 1, versionGroupId: new Types.ObjectId(), isCurrent: true, createdBy: admin._id });
    const scenario = await ScenarioModel.create({ tenantId: acmeId, key: 'acme_only_scenario', personaKey: 'acme_only_persona', name: 'Acme Scenario', description: 'x', businessContext: 'x', status: 'draft', version: 1, versionGroupId: new Types.ObjectId(), isCurrent: true, conversationFlow: [], requiredFactKeys: [], createdBy: admin._id });
    const question = await QuestionModel.create({ tenantId: acmeId, key: 'acme_only_question', text: 'Acme?', type: 'yes_no', factKey: 'acme_fact', required: true, status: 'active', tags: {}, createdBy: admin._id });
    const rule = await RuleModel.create({ tenantId: acmeId, key: 'acme_only_rule', name: 'Acme rule', priority: 1, trigger: { factKey: 'acme_fact', op: 'eq', value: true }, forcedClassification: 'issue', status: 'draft', version: 1, versionGroupId: new Types.ObjectId(), isCurrent: true, createdBy: admin._id });
    const factor = (weight: number) => ({ weight, scale: { min: 1, max: 5 }, mapping: [] });
    const matrix = await MatrixModel.create({ tenantId: acmeId, key: 'acme_only_matrix', name: 'Acme matrix', status: 'draft', version: 1, versionGroupId: new Types.ObjectId(), isCurrent: true, createdBy: admin._id, factors: { controlEffectiveness: factor(20), impact: factor(20), severity: factor(20), likelihood: factor(20), duration: factor(10), regulatorySensitivity: factor(10) }, thresholds: { monitor_only: { min: 0, max: 25 }, risk: { min: 26, max: 50 }, elevated_risk: { min: 51, max: 75 }, issue: { min: 76, max: 100 } } });
    const assessment = await AssessmentModel.create({ tenantId: acmeId, requestorId: req._id, status: 'in_progress', openingText: 'acme secret' });
    const department = (await DepartmentModel.findOne({ tenantId: acmeId }))!;
    ids = { persona: String(persona._id), scenario: String(scenario._id), question: String(question._id), rule: String(rule._id), matrix: String(matrix._id), assessment: String(assessment._id), department: String(department._id) };
    acmeAdmin = await login('admin@paid.local');
    acmeReq = await login('requestor@paid.local');
    publicAdmin = await login('admin@dev.local');
    publicAuditor = await login('audit@dev.local');
  });

  const LISTS: { path: string; marker: string; as: () => Record<string, string> }[] = [
    { path: '/personas?status=draft', marker: 'acme_only_persona', as: () => publicAdmin },
    { path: '/scenarios?status=draft', marker: 'acme_only_scenario', as: () => publicAdmin },
    { path: '/questions', marker: 'acme_only_question', as: () => publicAdmin },
    { path: '/rules', marker: 'acme_only_rule', as: () => publicAdmin },
    { path: '/scoring-matrices', marker: 'acme_only_matrix', as: () => publicAdmin },
    { path: '/assessments', marker: 'acme secret', as: () => publicAuditor },
    { path: '/departments', marker: 'Finance', as: () => publicAuditor },
    { path: '/audit-logs', marker: String(acmeId), as: () => publicAuditor },
  ];

  it('list routes never return another tenant’s documents', async () => {
    for (const l of LISTS) {
      const mine = await request(app).get(`/api/v1${l.path}`).set(l.path.startsWith('/assessments') || l.path.startsWith('/departments') || l.path.startsWith('/audit-logs') ? acmeAdmin : acmeAdmin);
      expect(mine.status, l.path).toBe(200);
      expect(JSON.stringify(mine.body), `${l.path} as acme should contain ${l.marker}`).toContain(l.marker);
      const other = await request(app).get(`/api/v1${l.path}`).set(l.as());
      expect(other.status, l.path).toBe(200);
      expect(JSON.stringify(other.body), `${l.path} as public must not contain ${l.marker}`).not.toContain(l.marker);
    }
  });

  it('detail routes answer 404 (not 403) across tenants so ids cannot be probed', async () => {
    const detail: [string, Record<string, string>][] = [
      [`/personas/${ids.persona}`, publicAdmin],
      [`/scenarios/${ids.scenario}`, publicAdmin],
      [`/questions/${ids.question}`, publicAdmin],
      [`/rules/${ids.rule}`, publicAdmin],
      [`/scoring-matrices/${ids.matrix}`, publicAdmin],
      [`/assessments/${ids.assessment}`, publicAuditor],
      [`/assessments/${ids.assessment}/messages`, publicAuditor],
      [`/assessments/${ids.assessment}/reconstruct`, publicAuditor],
    ];
    for (const [path, h] of detail) {
      const res = await request(app).get(`/api/v1${path}`).set(h);
      expect(res.status, path).toBe(404);
    }
    // writes across tenants are refused too
    expect((await request(app).patch(`/api/v1/personas/${ids.persona}`).set(publicAdmin).send({ name: 'hijack' })).status).toBe(404);
    expect((await request(app).post(`/api/v1/assessments/${ids.assessment}/decision`).set(await login('requestor@dev.local')).send({ type: 'accept' })).status).toBe(404);
  });

  it('reports and analytics are computed per tenant; the audit log of one tenant never leaks into another', async () => {
    await TenantModel.updateOne({ _id: publicId }, { $set: { 'features.reports': true } });
    const pub = (await request(app).get('/api/v1/reports/volume').set(publicAdmin)).body.data;
    expect(pub.summary.started).toBe(0);
    const acme = (await request(app).get('/api/v1/reports/volume').set(acmeAdmin)).body.data;
    expect(acme.summary.started).toBe(1);
    expect(await AuditLogModel.countDocuments({ tenantId: publicId, 'entity.id': ids.assessment })).toBe(0);
    const requestorOther = await request(app).get(`/api/v1/assessments/${ids.assessment}/escalation-targets`).set(acmeReq);
    expect(requestorOther.status).toBe(200);
  });

  it('static scan: every request-path query in a module service/route names tenantId (or is an explicitly exempt lookup)', () => {
    const root = join(process.cwd(), 'src', 'modules');
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts)$/.test(f) && !/\.test\.ts$/.test(f) && /(service|routes|content)\.ts$/.test(f)) files.push(p); } };
    walk(root);
    // Lookups that are legitimately tenant-agnostic or scoped by a tenant-owned parent (checked upstream).
    const EXEMPT = [
      /findOne\(\{ firebaseUid/, /findOne\(\{ email/, /findById\(user\.tenantId\)/, /findById\(o\.escalatedToUserId\)/, /findById\(req\.user!\.tenantId\)/, /findById\(scored/, /AssessmentMessageModel\.find\(\{ assessmentId/, /AssessmentMessageModel\.deleteMany\(\{ assessmentId/, /SessionModel\.find/, /SessionModel\.findOne/, /OtpModel/,
      /TenantModel\.findOne\(\{ slug/, /TenantModel\.findOne\(\{ 'features\.sso'/, /TenantModel\.findOne\(\{ _id: \{ \$ne/, /TenantModel\.find\(opts/, /AssessmentModel\.find\(\{ \.\.\.base/, /AssessmentModel\.updateOne\(\{ _id: doc\._id/, /AssessmentModel\.updateMany\(\{ _id: \{ \$in/, /AssessmentArchiveModel\.updateOne\(\{ assessmentId/,
      /UserModel\.updateOne/, /UserModel\.findById/, /findById\(id\)/, /\.findOne\(\{ _id: id, tenantId/, /AssessmentModel\.findById\(id\)/, /versionGroupId/, /key: q\.key/,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const re = /\b[A-Z][A-Za-z]*Model\.(find|findOne|countDocuments|aggregate|updateOne|updateMany|deleteMany|findOneAndUpdate)\(([^;]{0,220})/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const stmt = m[0];
        if (/tenantId/.test(stmt)) continue;
        if (EXEMPT.some((x) => x.test(stmt))) continue;
        offenders.push(`${file.replace(process.cwd() + '/', '')}: ${stmt.slice(0, 120).replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders, `queries without tenantId:\n${offenders.join('\n')}`).toEqual([]);
  });
});
