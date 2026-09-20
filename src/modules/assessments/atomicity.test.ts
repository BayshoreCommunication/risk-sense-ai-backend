import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inMongoTransaction } from '../../lib/db';
import { app, login, seeded } from '../../tests/helpers';
import { mockAi, setAi, type AiService } from '../ai/service';
import { AuditLogModel } from '../audit/model';
import { audit } from '../audit/service';
import { AssessmentMessageModel, AssessmentModel } from './model';

describe('assessment state and audit atomicity [FR-25, FR-26, FR-30, SEC-07]', () => {
  let requestor: Record<string, string>;
  const starter = JSON.parse(readFileSync(join(process.cwd(), 'templates', 'starter-content.json'), 'utf8'));

  beforeEach(async () => {
    await seeded();
    const admin = await login('admin@dev.local');
    const reviewer = await login('admin2@dev.local');
    requestor = await login('requestor@tac.local');
    const upload = await request(app).post('/api/v1/datasets').set(admin).send({ fileName: 'starter.json', content: starter });
    await request(app).post(`/api/v1/datasets/${upload.body.data._id}/approve`).set(reviewer);
    const activated = await request(app).post(`/api/v1/datasets/${upload.body.data._id}/activate`).set(admin);
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  });

  afterEach(() => {
    setAi(null);
    vi.restoreAllMocks();
  });

  const post = (path: string, body?: unknown) => request(app).post(path).set(requestor).send(body);

  const fallback = (question: { type: string; options?: { id: string }[] }) => {
    if (question.type === 'mcq') return { value: question.options![0]!.id };
    if (question.type === 'yes_no') return { value: false };
    if (question.type === 'number') return { value: 100 };
    return { text: 'A sufficiently detailed response describing the incident and the controls involved.' };
  };

  async function finishIntake(id: string) {
    let view = (await request(app).get(`/api/v1/assessments/${id}`).set(requestor)).body.data;
    for (let turn = 0; view.currentQuestionKey && turn < 80; turn++) {
      const messages = (await request(app).get(`/api/v1/assessments/${id}/messages`).set(requestor)).body.data;
      const question = messages
        .filter((message: { questionKey?: string; question?: unknown }) => message.questionKey === view.currentQuestionKey && message.question)
        .at(-1).question as { type: string; options?: { id: string }[] };
      const answered = await post(`/api/v1/assessments/${id}/messages`, fallback(question));
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      view = answered.body.data;
      if (view.intakeComplete) return;
    }
    throw new Error('intake did not complete');
  }

  it('keeps model calls outside transactions and rolls every state/message change back when audit evidence fails [FR-25, SEC-07]', async () => {
    const modelCalls: string[] = [];
    const outside = (name: string) => {
      modelCalls.push(name);
      expect(inMongoTransaction(), `${name} ran inside a Mongo transaction`).toBe(false);
    };
    const guardedAi: AiService = {
      ...mockAi,
      async inferPersona(input) {
        outside('inferPersona');
        return mockAi.inferPersona(input);
      },
      async selectScenario(input) {
        outside('selectScenario');
        return mockAi.selectScenario(input);
      },
      async extractFacts(input) {
        outside('extractFacts');
        return mockAi.extractFacts(input);
      },
      async explain(input) {
        outside('explain');
        return mockAi.explain(input);
      },
    };
    setAi(guardedAi);

    const writeAudit = audit.write.bind(audit);
    let failAction: string | null = 'assessment.started';
    const writeSpy = vi.spyOn(audit, 'write').mockImplementation(async (entry) => {
      if (entry.action === failAction) throw new Error(`forced ${entry.action} audit failure`);
      return writeAudit(entry);
    });

    const failedStart = await post('/api/v1/assessments', {
      text: 'A patient received the wrong medication dose in the ward this morning.',
    });
    expect(failedStart.status).toBe(500);
    expect(await AssessmentModel.countDocuments()).toBe(0);
    expect(await AssessmentMessageModel.countDocuments()).toBe(0);
    expect(await AuditLogModel.countDocuments({ category: 'assessment' })).toBe(0);

    failAction = null;
    const started = await post('/api/v1/assessments', {
      personaKey: 'finance_officer',
      text: 'An unauthorized wire transfer bypassed approval controls.',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const id = started.body.data._id as string;
    const pendingQuestion = started.body.data.currentQuestionKey as string;
    const messagesBeforeAnswer = await AssessmentMessageModel.countDocuments({ assessmentId: id });

    failAction = 'assessment.answered';
    const failedAnswer = await post(`/api/v1/assessments/${id}/messages`, {
      text: 'Treasury wire payments to a newly registered vendor account.',
    });
    expect(failedAnswer.status).toBe(500);
    expect(await AssessmentModel.findById(id).lean()).toMatchObject({
      currentQuestionKey: pendingQuestion,
      answers: [],
      facts: [],
    });
    expect(await AssessmentMessageModel.countDocuments({ assessmentId: id })).toBe(messagesBeforeAnswer);
    expect(await AuditLogModel.countDocuments({ action: 'assessment.answered', 'entity.id': id })).toBe(0);

    failAction = null;
    const retriedAnswer = await post(`/api/v1/assessments/${id}/messages`, {
      text: 'Treasury wire payments to a newly registered vendor account.',
    });
    expect(retriedAnswer.status, JSON.stringify(retriedAnswer.body)).toBe(200);
    await finishIntake(id);

    const messagesBeforeSubmit = await AssessmentMessageModel.countDocuments({ assessmentId: id });
    failAction = 'assessment.recommended';
    const failedSubmit = await post(`/api/v1/assessments/${id}/submit`);
    expect(failedSubmit.status).toBe(500);
    const unsubmitted = await AssessmentModel.findById(id).lean();
    expect(unsubmitted).toMatchObject({ status: 'intake_complete' });
    expect(unsubmitted?.result?.score).toBeUndefined();
    expect(unsubmitted?.result?.classification).toBeUndefined();
    expect(unsubmitted?.timing?.submittedAt).toBeUndefined();
    expect(await AssessmentMessageModel.countDocuments({ assessmentId: id })).toBe(messagesBeforeSubmit);
    expect(await AuditLogModel.countDocuments({
      action: { $in: ['assessment.rules_evaluated', 'assessment.scored', 'assessment.recommended'] },
      'entity.id': id,
    })).toBe(0);

    failAction = null;
    const submitted = await post(`/api/v1/assessments/${id}/submit`);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const messagesBeforeDecision = await AssessmentMessageModel.countDocuments({ assessmentId: id });

    failAction = 'decision.recorded';
    const failedDecision = await post(`/api/v1/assessments/${id}/decision`, { type: 'accept' });
    expect(failedDecision.status).toBe(500);
    const undecided = await AssessmentModel.findById(id).lean();
    expect(undecided).toMatchObject({ status: 'awaiting_decision' });
    expect(undecided?.decision).toBeUndefined();
    expect(undecided?.timing?.closedAt).toBeUndefined();
    expect(await AssessmentMessageModel.countDocuments({ assessmentId: id })).toBe(messagesBeforeDecision);
    expect(await AuditLogModel.countDocuments({ action: 'decision.recorded', 'entity.id': id })).toBe(0);

    failAction = null;
    const decided = await post(`/api/v1/assessments/${id}/decision`, { type: 'accept' });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.data.status).toBe('closed');
    expect(modelCalls).toEqual(expect.arrayContaining(['inferPersona', 'selectScenario', 'extractFacts', 'explain']));
    writeSpy.mockRestore();
  });
});
