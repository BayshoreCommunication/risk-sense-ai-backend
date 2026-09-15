import { Types } from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, seeded } from '../../tests/helpers';
import { PersonaModel } from '../personas/model';
import { QuestionModel } from '../questions/model';
import { RuleModel } from '../rules/model';
import { ScoringMatrixModel } from '../scoring/model';
import { ScenarioModel } from '../scenarios/model';
import { AssessmentModel } from './model';

const thresholds = {
  monitor_only: { min: 0, max: 25 },
  risk: { min: 26, max: 50 },
  elevated_risk: { min: 51, max: 75 },
  issue: { min: 76, max: 100 },
};

const matrixFactors = (matchedValue: number) => ({
  controlEffectiveness: {
    weight: 100,
    scale: { min: 1, max: 5 },
    mapping: [{ when: { factKey: 'severity_fact', op: 'eq', value: 'high' }, value: matchedValue }],
  },
  impact: { weight: 0, scale: { min: 1, max: 5 }, mapping: [] },
  severity: { weight: 0, scale: { min: 1, max: 5 }, mapping: [] },
  likelihood: { weight: 0, scale: { min: 1, max: 5 }, mapping: [] },
  duration: { weight: 0, scale: { min: 1, max: 5 }, mapping: [] },
  regulatorySensitivity: { weight: 0, scale: { min: 1, max: 5 }, mapping: [] },
});

describe('assessment execution pins [AI-04, FR-11, FR-17, FR-19]', () => {
  let owner: Record<string, string>;
  let admin: Record<string, string>;
  let admin2: Record<string, string>;

  beforeEach(async () => {
    const { tac } = await seeded();
    owner = await login('requestor@tac.local');
    admin = await login('admin@dev.local');
    admin2 = await login('admin2@dev.local');
    const tenantId = tac._id;

    await PersonaModel.create({
      tenantId,
      key: 'pinned_persona',
      name: 'Pinned Persona',
      sector: 'financial',
      description: 'Persona used to prove immutable assessment execution.',
      vocabulary: ['original-vocabulary'],
      defaultScenarioKey: 'pinned_scenario',
      versionGroupId: new Types.ObjectId(),
      version: 1,
      isCurrent: true,
      status: 'active',
    });
    await QuestionModel.create([
      {
        tenantId,
        key: 'pin_q1',
        text: 'What is the severity?',
        type: 'mcq',
        options: [
          { id: 'low', label: 'Low', factValue: 'low' },
          { id: 'high', label: 'High', factValue: 'high' },
        ],
        factKey: 'severity_fact',
        required: true,
        tags: { personaKeys: ['pinned_persona'], scenarioKeys: ['pinned_scenario'], sectors: ['financial'] },
        status: 'active',
      },
      {
        tenantId,
        key: 'pin_q2',
        text: 'Did the original hard-rule condition occur?',
        type: 'yes_no',
        factKey: 'force_issue',
        required: true,
        tags: { personaKeys: ['pinned_persona'], scenarioKeys: ['pinned_scenario'], sectors: ['financial'] },
        status: 'active',
      },
    ]);
    await ScenarioModel.create({
      tenantId,
      key: 'pinned_scenario',
      personaKey: 'pinned_persona',
      name: 'Pinned scenario',
      description: 'Original scenario content used for a running assessment.',
      businessContext: 'Regression test context.',
      conversationFlow: [{ questionKey: 'pin_q1' }, { questionKey: 'pin_q2' }],
      requiredFactKeys: ['severity_fact', 'force_issue'],
      reasoningExample: 'Original reasoning example.',
      recommendedActions: { issue: { decisionRecommendation: 'Pinned scenario action', nextSteps: ['Pinned next step'] } },
      versionGroupId: new Types.ObjectId(),
      version: 1,
      isCurrent: true,
      status: 'active',
    });
    await ScoringMatrixModel.create({
      tenantId,
      key: 'default',
      name: 'Pinned matrix v1',
      formula: 'weighted_sum',
      factors: matrixFactors(5),
      thresholds,
      confidence: { professionalConsultBelow: 60, mandatoryReviewBelow: 40 },
      versionGroupId: new Types.ObjectId(),
      version: 1,
      isCurrent: true,
      status: 'active',
    });
    await RuleModel.create({
      tenantId,
      key: 'pinned_rule',
      name: 'Pinned rule v1',
      trigger: { factKey: 'force_issue', op: 'eq', value: true },
      forcedClassification: 'issue',
      priority: 1,
      sectors: [],
      versionGroupId: new Types.ObjectId(),
      version: 1,
      isCurrent: true,
      status: 'active',
    });
  });

  it('continues and scores with v1 after question/rule edits and active scenario/matrix v2 [AI-04]', async () => {
    const start = await request(app).post('/api/v1/assessments').set(owner).send({
      personaKey: 'pinned_persona',
      text: 'A sufficiently detailed incident description with no special matching keyword.',
    });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    expect(start.body.data.nextQuestion).toMatchObject({ key: 'pin_q1', text: 'What is the severity?' });
    const id = start.body.data._id as string;
    const v1 = await AssessmentModel.findById(id).lean();
    expect(v1!.versions).toMatchObject({
      scenario: { version: 1 },
      matrix: { version: 1 },
      questionSetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      rulesHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(v1!.pinnedContent!.questions).toHaveLength(2);
    expect(v1!.pinnedContent!.rules).toHaveLength(1);

    const q2 = await QuestionModel.findOne({ key: 'pin_q2' }).lean();
    const qEdit = await request(app).patch(`/api/v1/questions/${q2!._id}`).set(admin).send({
      text: 'Changed question that must not reach the running v1 assessment.',
      factKey: 'changed_fact',
    });
    expect(qEdit.status).toBe(200);

    const scenarioV1 = await ScenarioModel.findOne({ key: 'pinned_scenario', isCurrent: true }).lean();
    const scenarioDraft = await request(app).patch(`/api/v1/scenarios/${scenarioV1!._id}`).set(admin).send({
      conversationFlow: [{ questionKey: 'pin_q1' }],
      requiredFactKeys: ['severity_fact'],
      recommendedActions: { issue: { decisionRecommendation: 'Changed scenario action', nextSteps: [] } },
    });
    expect(scenarioDraft.status).toBe(200);
    expect(scenarioDraft.body.data.version).toBe(2);
    expect((await request(app).post(`/api/v1/scenarios/${scenarioDraft.body.data._id}/activate`).set(admin)).status).toBe(200);

    const matrixV1 = await ScoringMatrixModel.findOne({ key: 'default', isCurrent: true }).lean();
    const matrixDraft = await request(app).patch(`/api/v1/scoring-matrices/${matrixV1!._id}`).set(admin).send({ factors: matrixFactors(1) });
    expect(matrixDraft.status, JSON.stringify(matrixDraft.body)).toBe(200);
    expect(matrixDraft.body.data.version).toBe(2);
    expect((await request(app).post(`/api/v1/scoring-matrices/${matrixDraft.body.data._id}/approve`).set(admin2).send({ changeRef: 'AI-04 regression' })).status).toBe(200);
    expect((await request(app).post(`/api/v1/scoring-matrices/${matrixDraft.body.data._id}/activate`).set(admin)).status).toBe(200);

    const rule = await RuleModel.findOne({ key: 'pinned_rule' }).lean();
    const ruleDraft = await request(app).patch(`/api/v1/rules/${rule!._id}`).set(admin).send({
      name: 'Changed rule v2',
      trigger: { factKey: 'severity_fact', op: 'eq', value: 'high' },
      forcedClassification: 'risk',
    });
    expect(ruleDraft.status).toBe(200);
    expect(ruleDraft.body.data.version).toBe(2);
    expect((await request(app).post(`/api/v1/rules/${ruleDraft.body.data._id}/approve`).set(admin2).send({ changeRef: 'AI-04 regression' })).status).toBe(200);
    expect((await request(app).post(`/api/v1/rules/${ruleDraft.body.data._id}/activate`).set(admin)).status).toBe(200);

    const first = await request(app).post(`/api/v1/assessments/${id}/messages`).set(owner).send({ value: 'high' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.data.nextQuestion).toMatchObject({
      key: 'pin_q2',
      text: 'Did the original hard-rule condition occur?',
      factKey: 'force_issue',
    });
    const done = await request(app).post(`/api/v1/assessments/${id}/messages`).set(owner).send({ value: true });
    expect(done.body.data).toMatchObject({ status: 'intake_complete', intakeComplete: true });

    const submitted = await request(app).post(`/api/v1/assessments/${id}/submit`).set(owner);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.result).toMatchObject({
      score: 100,
      classification: 'issue',
      ruleDriven: true,
      ruleKey: 'pinned_rule',
      ruleName: 'Pinned rule v1',
      recommendedAction: 'Pinned scenario action',
    });

    const stored = await AssessmentModel.findById(id).lean();
    expect(String(stored!.versions!.scenario!.id)).toBe(String(v1!.versions!.scenario!.id));
    expect(String(stored!.versions!.matrix!.id)).toBe(String(v1!.versions!.matrix!.id));
    expect(stored!.versions!.questionSetHash).toBe(v1!.versions!.questionSetHash);
    expect(stored!.versions!.rulesHash).toBe(v1!.versions!.rulesHash);
  });
});
