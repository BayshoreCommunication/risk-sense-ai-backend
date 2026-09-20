import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { PersonaModel } from '../personas/model';
import { QuestionModel } from '../questions/model';
import { RuleModel } from '../rules/model';
import { ScenarioModel } from '../scenarios/model';
import { ScoringMatrixModel } from '../scoring/model';
import { TenantModel } from '../tenants/model';
import { DatasetModel } from './model';
import { buildTemplateWorkbook, SAMPLE } from './template';

describe('datasets (FR-13, FR-14, AI-04, AI-06)', () => {
  let admin: Record<string, string>;
  let admin2: Record<string, string>;

  beforeEach(async () => {
    await seeded();
    admin = await login('admin@dev.local');
    admin2 = await login('admin2@dev.local');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const uploadJson = (h: Record<string, string>, content: unknown, fileName = 'sample.json') =>
    request(app).post('/api/v1/datasets').set(h).send({ fileName, content });

  const sampleForSector = (sector: string) => {
    const content = JSON.parse(JSON.stringify(SAMPLE)) as typeof SAMPLE;
    content.personas.forEach((persona) => { persona.sector = sector; });
    content.questions.forEach((question) => { question.sectors = sector; });
    return content;
  };

  it('validates the sample JSON content and stores a dataset without applying anything [FR-13]', async () => {
    const res = await uploadJson(admin, SAMPLE);
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('validated');
    expect(res.body.data.counts).toMatchObject({ personas: 1, scenarios: 1, questions: 11, scoring: 6 });
    expect(await PersonaModel.countDocuments()).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'dataset.uploaded' })).toBe(1);
  });

  it('rolls back upload and approval state when required audit evidence fails [FR-13, FR-14, FR-25, SEC-07]', async () => {
    const writeAudit = audit.write.bind(audit);
    let failAction = 'dataset.uploaded';
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === failAction) throw new Error(`forced ${entry.action} audit failure`);
      return writeAudit(entry);
    });

    const failedUpload = await uploadJson(admin, SAMPLE, 'atomic-upload.json');
    expect(failedUpload.status).toBe(500);
    expect(await DatasetModel.countDocuments({ fileName: 'atomic-upload.json' })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'dataset.uploaded' })).toBe(0);

    failAction = '';
    const uploaded = await uploadJson(admin, SAMPLE, 'atomic-approval.json');
    expect(uploaded.status).toBe(201);
    failAction = 'dataset.approved';
    const failedApproval = await request(app).post(`/api/v1/datasets/${uploaded.body.data._id}/approve`).set(admin2);
    expect(failedApproval.status).toBe(500);
    expect(await DatasetModel.findById(uploaded.body.data._id).lean()).toMatchObject({ status: 'validated' });
    expect((await DatasetModel.findById(uploaded.body.data._id).lean())?.reviewerId).toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'dataset.approved', 'entity.id': uploaded.body.data._id })).toBe(0);
    writeSpy.mockRestore();
  });

  it('parses the generated XLSX template (multipart) the same way [T-006]', async () => {
    const buf = await buildTemplateWorkbook();
    const res = await request(app).post('/api/v1/datasets').set(admin).attach('file', buf, 'risksense-content-template.xlsx');
    expect(res.status).toBe(201);
    expect(res.body.data.format).toBe('xlsx');
    expect(res.body.data.status).toBe('validated');
    expect(res.body.data.counts).toMatchObject({ personas: 1, scenarios: 1, questions: 11, scoring: 6, skippedRows: 8 }); // 2 header rows × 4 sheets
  });

  it('rejects with row-level errors: bad key, missing question in flow, uncovered required fact, wrong weights [FR-13, FR-12, FR-03]', async () => {
    const broken = JSON.parse(JSON.stringify(SAMPLE)) as typeof SAMPLE;
    broken.personas[0]!.persona_key = 'Finance Officer';
    broken.scenarios[0]!.conversation_flow = 'fin_q01_process;does_not_exist';
    broken.scenarios[0]!.required_fact_keys = 'affected_process;never_asked';
    broken.scoring[0]!.weight_percent = '10';
    const res = await uploadJson(admin, broken, 'broken.json');
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('rejected');
    const errors = res.body.data.validationErrors as { sheet: string; column?: string; message: string }[];
    expect(errors.some((e) => e.sheet === 'personas' && e.column === 'key')).toBe(true);
    expect(errors.some((e) => e.sheet === 'scoring' && e.message.includes('weights sum'))).toBe(true);
    // Zod-level errors short-circuit cross validation, so fix the key and check the cross-reference layer separately.
    broken.personas[0]!.persona_key = 'finance_officer';
    broken.scoring[0]!.weight_percent = '25';
    const res2 = await uploadJson(admin, broken, 'broken2.json');
    const errors2 = res2.body.data.validationErrors as { sheet: string; column?: string; message: string }[];
    expect(errors2.some((e) => e.column === 'conversation_flow' && e.message.includes('does_not_exist'))).toBe(true);
    expect(errors2.some((e) => e.column === 'required_fact_keys' && e.message.includes('never_asked'))).toBe(true);
    expect(await AuditLogModel.countDocuments({ action: 'dataset.rejected' })).toBe(2);
  });

  it('rejects dataset persona and question sectors outside the tenant vocabulary [FR-13, NFR-04]', async () => {
    const unknownSector = sampleForSector('energy');

    const response = await uploadJson(admin, unknownSector, 'unknown-sector.json');
    expect(response.status).toBe(201);
    expect(response.body.data.status).toBe('rejected');
    const errors = response.body.data.validationErrors as { sheet: string; column?: string; message: string }[];
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ sheet: 'personas', column: 'sector', message: expect.stringContaining('energy') }),
      expect.objectContaining({ sheet: 'questions', column: 'sectors', message: expect.stringContaining('energy') }),
    ]));
    expect(await DatasetModel.countDocuments({ fileName: 'unknown-sector.json', status: 'rejected' })).toBe(1);
  });

  it('blocks sector removal while a validated or approved dataset still references it [FR-13, NFR-04]', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const withEnergy = ['financial', 'healthcare', 'it', 'general', 'energy'];
    expect((await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sectors: withEnergy })).status).toBe(200);

    const upload = await uploadJson(admin, sampleForSector('energy'), 'pending-energy.json');
    expect(upload.status).toBe(201);
    expect(upload.body.data.status).toBe('validated');
    const withoutEnergy = ['financial', 'healthcare', 'it', 'general'];
    const whileValidated = await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sectors: withoutEnergy });
    expect(whileValidated.status).toBe(409);

    expect((await request(app).post(`/api/v1/datasets/${upload.body.data._id}/approve`).set(admin2)).status).toBe(200);
    const whileApproved = await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sectors: withoutEnergy });
    expect(whileApproved.status).toBe(409);
    expect((await TenantModel.findOne({ slug: 'tac' }).lean())?.sectors).toContain('energy');
  });

  it('serializes upload creation against concurrent sector removal [FR-13, NFR-04]', async () => {
    const sysadmin = await login('sysadmin@dev.local');
    const withEnergy = ['financial', 'healthcare', 'it', 'general', 'energy'];
    const withoutEnergy = ['financial', 'healthcare', 'it', 'general'];
    expect((await request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sectors: withEnergy })).status).toBe(200);

    const [upload, removal] = await Promise.all([
      uploadJson(admin, sampleForSector('energy'), 'concurrent-energy.json'),
      request(app).patch('/api/v1/system/tenant').set(sysadmin).send({ sectors: withoutEnergy }),
    ]);
    expect(upload.status).toBe(201);
    expect(['validated', 'rejected']).toContain(upload.body.data.status);

    const tenant = await TenantModel.findOne({ slug: 'tac' }).lean();
    if (upload.body.data.status === 'validated') {
      expect(removal.status).toBe(409);
      expect(tenant?.sectors).toContain('energy');
    } else {
      expect(removal.status).toBe(200);
      expect(tenant?.sectors).not.toContain('energy');
      expect((upload.body.data.validationErrors as { message: string }[]).some((error) => error.message.includes('energy'))).toBe(true);
    }
  });

  it('author cannot approve their own upload; another administrator can [AI-06]', async () => {
    const up = await uploadJson(admin, SAMPLE);
    const id = up.body.data._id;
    const self = await request(app).post(`/api/v1/datasets/${id}/approve`).set(admin);
    expect(self.status).toBe(422);
    expect(self.body.error.code).toBe('SELF_APPROVAL');
    const other = await request(app).post(`/api/v1/datasets/${id}/approve`).set(admin2);
    expect(other.status).toBe(200);
    expect(other.body.data.status).toBe('approved');
  });

  it('lists retained author and reviewer provenance with tenant-scoped display names [FR-14]', async () => {
    const up = await uploadJson(admin, SAMPLE);
    const id = up.body.data._id as string;
    await request(app).post(`/api/v1/datasets/${id}/approve`).set(admin2);

    const list = await request(app).get('/api/v1/datasets').set(admin);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      _id: id,
      author: { id: up.body.data.authorId, name: 'Dev Administrator (TAC)' },
      reviewer: { name: 'Dev Administrator 2 (TAC reviewer)' },
    });
    expect(list.body.data[0].author).not.toHaveProperty('email');
    expect(list.body.data[0].reviewer).not.toHaveProperty('email');
    expect(list.body.data[0]).not.toHaveProperty('content');

    const detail = await request(app).get(`/api/v1/datasets/${id}`).set(admin);
    expect(detail.status).toBe(200);
    expect(detail.body.data.author.name).toBe('Dev Administrator (TAC)');
    expect(detail.body.data.reviewer.name).toBe('Dev Administrator 2 (TAC reviewer)');
    expect(detail.body.data).toHaveProperty('content');
  });

  it('publishes explicit author and reviewer fields in the generated Dataset contract [FR-14]', () => {
    const spec = JSON.parse(readFileSync(join(process.cwd(), 'openapi.json'), 'utf8')) as {
      components: { schemas: { Dataset: { properties?: Record<string, unknown>; required?: string[] } } };
    };
    const schema = spec.components.schemas.Dataset;
    expect(schema.properties).toMatchObject({
      authorId: { type: 'string' },
      reviewerId: { type: 'string' },
      author: { $ref: '#/components/schemas/DatasetPerson' },
      reviewer: { $ref: '#/components/schemas/DatasetPerson' },
    });
    expect(schema.required).toContain('authorId');
    expect(schema.required).not.toContain('author');
    expect(schema.required).not.toContain('reviewer');
  });

  it('activation without approval is refused [AI-06]', async () => {
    const up = await uploadJson(admin, SAMPLE);
    const res = await request(app).post(`/api/v1/datasets/${up.body.data._id}/activate`).set(admin);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_APPROVED');
  });

  it('activation creates and activates personas, questions and scenarios through the normal services [FR-13, FR-14]', async () => {
    const up = await uploadJson(admin, SAMPLE);
    const id = up.body.data._id;
    await request(app).post(`/api/v1/datasets/${id}/approve`).set(admin2);
    const res = await request(app).post(`/api/v1/datasets/${id}/activate`).set(admin);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('active');
    expect(res.body.data.applied.questions).toHaveLength(11);
    const persona = await PersonaModel.findOne({ key: 'finance_officer' }).lean();
    expect(persona).toMatchObject({ status: 'active', isCurrent: true, version: 1 });
    const scenario = await ScenarioModel.findOne({ key: 'fin_unauthorized_transaction' }).lean();
    expect(scenario).toMatchObject({ status: 'active', isCurrent: true });
    expect(scenario?.questionSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await QuestionModel.countDocuments({ status: 'active' })).toBe(11);
    const mcq = await QuestionModel.findOne({ key: 'fin_q14_status' }).lean();
    expect(mcq?.options.map((o) => o.factValue)).toEqual(['active', 'contained', 'resolved']);
    const branch = await QuestionModel.findOne({ key: 'fin_q06_fraud_suspected' }).lean();
    expect(branch?.branchTrigger?.onValue).toBe(true);
    expect(await AuditLogModel.countDocuments({ action: 'dataset.activated' })).toBe(1);
  });

  it('the dataset author remains maker when its reviewer performs activation [AI-05, AI-06]', async () => {
    const up = await uploadJson(admin, SAMPLE);
    const id = up.body.data._id;
    await request(app).post(`/api/v1/datasets/${id}/approve`).set(admin2);

    const activated = await request(app).post(`/api/v1/datasets/${id}/activate`).set(admin2);
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);

    const [matrix, rule, dataset] = await Promise.all([
      ScoringMatrixModel.findOne({ status: 'active' }).lean(),
      RuleModel.findOne({ status: 'active' }).lean(),
      DatasetModel.findById(id).lean(),
    ]);
    expect(String(matrix?.createdBy)).toBe(String(dataset?.authorId));
    expect(String(rule?.createdBy)).toBe(String(dataset?.authorId));
    expect(String(matrix?.approvedBy)).toBe(String(dataset?.reviewerId));
    expect(String(rule?.approvedBy)).toBe(String(dataset?.reviewerId));
  });

  it('a failed activation rolls back every content and activation-audit write [FR-13]', async () => {
    const up = await uploadJson(admin, SAMPLE);
    const id = up.body.data._id;
    await request(app).post(`/api/v1/datasets/${id}/approve`).set(admin2);
    const writeAudit = audit.write.bind(audit);
    vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === 'dataset.activated') throw new Error('forced final activation failure');
      return writeAudit(entry);
    });

    const res = await request(app).post(`/api/v1/datasets/${id}/activate`).set(admin);
    expect(res.status).toBe(500);

    expect(await PersonaModel.countDocuments()).toBe(0);
    expect(await QuestionModel.countDocuments()).toBe(0);
    expect(await ScenarioModel.countDocuments()).toBe(0);
    expect(await RuleModel.countDocuments()).toBe(0);
    expect(await ScoringMatrixModel.countDocuments()).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: /^(persona|question|scenario|rule|scoring_matrix)\./ })).toBe(0);

    const failed = await DatasetModel.findById(id).lean();
    expect(failed).toMatchObject({
      status: 'failed',
      failure: 'forced final activation failure',
      applied: { personas: [], questions: [], scenarios: [], rules: [] },
    });
    expect(failed?.activatedAt).toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'dataset.activated' })).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'dataset.failed' })).toBe(1);

    const retry = await request(app).post(`/api/v1/datasets/${id}/activate`).set(admin);
    expect(retry.status).toBe(422);
    expect(retry.body.error.code).toBe('NOT_APPROVED');
    expect(await PersonaModel.countDocuments()).toBe(0);
    expect(await AuditLogModel.countDocuments({ action: 'dataset.failed' })).toBe(1);
  });

  it('re-uploading changed content creates new versions instead of overwriting [FR-11, AI-04]', async () => {
    const first = await uploadJson(admin, SAMPLE);
    await request(app).post(`/api/v1/datasets/${first.body.data._id}/approve`).set(admin2);
    await request(app).post(`/api/v1/datasets/${first.body.data._id}/activate`).set(admin);

    const changed = JSON.parse(JSON.stringify(SAMPLE)) as typeof SAMPLE;
    changed.personas[0]!.name = 'Finance Officer (AP)';
    changed.scenarios[0]!.name = 'Unauthorized wire';
    const second = await uploadJson(admin, changed, 'v2.json');
    expect(second.body.data.seq).toBe(2);
    await request(app).post(`/api/v1/datasets/${second.body.data._id}/approve`).set(admin2);
    const act = await request(app).post(`/api/v1/datasets/${second.body.data._id}/activate`).set(admin);
    expect(act.status).toBe(200);

    const versions = await PersonaModel.find({ key: 'finance_officer' }).sort({ version: 1 }).lean();
    expect(versions.map((v) => [v.version, v.status, v.name])).toEqual([
      [1, 'deactivated', 'Finance Officer'],
      [2, 'active', 'Finance Officer (AP)'],
    ]);
    const scenarios = await ScenarioModel.find({ key: 'fin_unauthorized_transaction' }).sort({ version: 1 }).lean();
    expect(scenarios.map((s) => [s.version, s.status])).toEqual([
      [1, 'deactivated'],
      [2, 'active'],
    ]);
    expect(await QuestionModel.countDocuments({ key: 'fin_q01_process' })).toBe(1); // questions upserted in place
  });

  it('template download returns an xlsx for readers', async () => {
    const auditor = await login('audit@dev.local');
    const res = await request(app).get('/api/v1/datasets/template').set(auditor);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
  });
});
