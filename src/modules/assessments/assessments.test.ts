import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { app, login, publishReviewedContent, seeded } from '../../tests/helpers';
import { AuditLogModel } from '../audit/model';
import { ScenarioModel } from '../scenarios/model';
import { UserModel } from '../users/model';
import { AssessmentModel } from './model';

/**
 * End-to-end intake with the deterministic mock AI (AI_PROVIDER=mock in tests) and the starter content
 * (3 personas, 13 scenarios, 76 questions, matrix + hard rules) loaded through the dataset flow.
 */
describe('assessments — intake → submit → decision', () => {
  let requestor: Record<string, string>;
  let admin: Record<string, string>;
  const starter = JSON.parse(readFileSync(join(process.cwd(), 'templates', 'starter-content.json'), 'utf8'));

  beforeEach(async () => {
    const { publicTenant } = await seeded();
    admin = await login('admin@dev.local');
    const admin2 = await login('admin2@dev.local');
    requestor = await login('requestor@tac.local');
    const up = await request(app).post('/api/v1/datasets').set(admin).send({ fileName: 'starter.json', content: starter });
    await request(app).post(`/api/v1/datasets/${up.body.data._id}/approve`).set(admin2);
    const act = await request(app).post(`/api/v1/datasets/${up.body.data._id}/activate`).set(admin);
    expect(act.status).toBe(200);
    await publishReviewedContent(String(publicTenant._id), starter);
  });

  const post = (path: string, h: Record<string, string>, body?: unknown) => request(app).post(path).set(h).send(body);

  async function answerUntilDone(id: string, answers: Record<string, unknown>, fallback: (q: { key: string; type: string; options: { id: string }[] }) => unknown) {
    let res = await request(app).get(`/api/v1/assessments/${id}`).set(requestor);
    let current = res.body.data.currentQuestionKey as string | undefined;
    let guard = 0;
    while (current && guard++ < 60) {
      const turn = await post(`/api/v1/assessments/${id}/messages`, requestor, {
        ...(current in answers ? (typeof answers[current] === 'string' && (answers[current] as string).length > 20 ? { text: answers[current] } : { value: answers[current] }) : {}),
      }).catch(() => null);
      if (!turn || turn.status !== 200) {
        // need a fallback answer for this question
        const q = (await request(app).get(`/api/v1/assessments/${id}/messages`).set(requestor)).body.data.filter((m: { questionKey?: string; question?: unknown }) => m.questionKey === current && m.question).pop().question;
        const fb = fallback(q);
        res = await post(`/api/v1/assessments/${id}/messages`, requestor, typeof fb === 'string' && fb.length > 20 ? { text: fb } : { value: fb });
        expect(res.status, `answer ${current}`).toBe(200);
      } else res = turn;
      if (res.body.data.intakeComplete) return res.body.data;
      current = res.body.data.nextQuestion?.key;
    }
    return res.body.data;
  }

  const genericAnswer = (q: { key: string; type: string; options: { id: string }[] }) => {
    if (q.type === 'mcq') return q.options[0]!.id;
    if (q.type === 'yes_no') return false;
    if (q.type === 'number') return 100;
    return 'A short description of what happened, with enough words to be useful.';
  };

  it('requestor starts with a persona; first question arrives; requestor-only route [FR-03, SEC-01]', async () => {
    const denied = await post('/api/v1/assessments', admin, { personaKey: 'finance_officer' });
    expect(denied.status).toBe(403);
    const res = await post('/api/v1/assessments', requestor, { personaKey: 'finance_officer' });
    expect(res.status).toBe(201);
    expect(res.body.data.phase).toBe('describe'); // persona chosen, no description yet → ask for one
    const id = res.body.data._id;
    const turn = await post(`/api/v1/assessments/${id}/messages`, requestor, { text: 'A vendor wire of 250000 was sent without dual authorization and the transfer was not approved.' });
    expect(turn.status, JSON.stringify(turn.body)).toBe(200);
    expect(turn.body.data.scenarioKey).toBe('fin_unauthorized_transaction');
    expect(turn.body.data.nextQuestion.key).toBe('fin_q01_process');
    expect(turn.body.data.versions.scenario.version).toBe(1);
    const pinnedScenario = await ScenarioModel.findById(turn.body.data.versions.scenario.id).lean();
    expect(turn.body.data.versions.questionSetHash).toBe(pinnedScenario!.questionSetHash);
    expect(turn.body.data.versions.promptVersion).toBe('v1');
    expect(turn.body.data.result).toBeNull(); // FR-08: nothing scored yet
  });

  it('infers the persona from the description (mock AI), offers candidates when unsure, allows override [FR-04]', async () => {
    const res = await post('/api/v1/assessments', requestor, { text: 'A patient received the wrong medication dose in the ward this morning' });
    expect(res.status).toBe(201);
    expect(res.body.data.personaKey).toBe('healthcare_compliance_officer');
    expect(res.body.data.personaSource).toBe('ai');
    expect(res.body.data.phase).toBe('persona');
    expect(res.body.data.personaCandidates).toHaveLength(3);
    expect(res.body.data.scenarioKey).toBeUndefined();

    const overridden = await post(`/api/v1/assessments/${res.body.data._id}/persona`, requestor, { personaKey: 'it_support' });
    expect(overridden.status).toBe(200);
    expect(overridden.body.data.personaKey).toBe('it_support');
    expect(overridden.body.data.personaSource).toBe('user');
    expect(overridden.body.data.scenarioKey).toBeDefined();

    const unsure = await post('/api/v1/assessments', requestor, { text: 'Something happened yesterday and I am not sure what to do about it' });
    expect(unsure.body.data.personaKey).toBeUndefined();
    expect(unsure.body.data.personaCandidates).toHaveLength(3);
    const chosen = await post(`/api/v1/assessments/${unsure.body.data._id}/persona`, requestor, { personaKey: 'it_support' });
    expect(chosen.status).toBe(200);
    expect(chosen.body.data.personaKey).toBe('it_support');
    expect(chosen.body.data.scenarioKey).toBeDefined(); // description existed → scenario chosen (default fallback allowed)
  });

  it('falls back to the persona default scenario when nothing matches [FR-05]', async () => {
    const res = await post('/api/v1/assessments', requestor, { personaKey: 'finance_officer' });
    const turn = await post(`/api/v1/assessments/${res.body.data._id}/messages`, requestor, { text: 'zzz qqq xxx yyy nothing relevant here at all' });
    expect(turn.body.data.scenarioKey).toBe('fin_unauthorized_transaction');
    expect(turn.body.data.scenarioSource).toBe('default');
  });

  it('MCQ answers become facts with confidence 1; a yes on the fraud question fires the branch immediately [FR-06, FR-07]', async () => {
    const res = await post('/api/v1/assessments', requestor, { personaKey: 'finance_officer', text: 'suspected fraud on a vendor payment account' });
    const id = res.body.data._id;
    expect(res.body.data.scenarioKey).toBe('fin_suspected_fraud');
    // walk to the fraud question
    let turn = res;
    while (turn.body.data.nextQuestion && turn.body.data.nextQuestion.key !== 'fin_q06_fraud_suspected') {
      const q = turn.body.data.nextQuestion;
      turn = await post(`/api/v1/assessments/${id}/messages`, requestor, q.type === 'free_text' ? { text: 'Accounts payable vendor payment process was affected.' } : { value: genericAnswer(q) });
      expect(turn.status).toBe(200);
    }
    turn = await post(`/api/v1/assessments/${id}/messages`, requestor, { value: true });
    expect(turn.body.data.nextQuestion.key).toBe('fin_q06a_fraud_confirmed'); // branch first
    const doc = await AssessmentModel.findById(id).lean();
    const fact = doc!.facts.find((f) => f.key === 'fraud_suspected');
    expect(fact).toMatchObject({ value: true, source: 'mcq', confidence: 1, flagged: false });
    const rejected = await post(`/api/v1/assessments/${id}/messages`, requestor, { value: 'not-an-option' });
    expect(rejected.status).toBe(400);
  });

  it('free text is extracted into facts, low confidence is flagged not dropped, and a clarification is asked once [FR-06]', async () => {
    const res = await post('/api/v1/assessments', requestor, { personaKey: 'finance_officer', text: 'unauthorized wire transfer without approval' });
    const id = res.body.data._id;
    expect(res.body.data.nextQuestion.key).toBe('fin_q01_process');
    const t1 = await post(`/api/v1/assessments/${id}/messages`, requestor, { text: 'Treasury wire payments to a new vendor.' });
    expect(t1.body.data.nextQuestion.key).toBe('fin_q02_funds');
    let doc = await AssessmentModel.findById(id).lean();
    expect(doc!.facts.find((f) => f.key === 'affected_process')).toMatchObject({ source: 'ai', flagged: false });
    // yes/no answered in ambiguous text → clarification, then a clear answer
    await post(`/api/v1/assessments/${id}/messages`, requestor, { value: 'company' });
    await post(`/api/v1/assessments/${id}/messages`, requestor, { value: 250000 });
    const vague = await post(`/api/v1/assessments/${id}/messages`, requestor, { text: 'hard to say honestly' });
    expect(vague.body.data.nextQuestion.key).toBe('fin_q04_authorized');
    expect(vague.body.data.clarification).toBeTruthy();
    const clear = await post(`/api/v1/assessments/${id}/messages`, requestor, { text: 'No, it was not authorized.' });
    expect(clear.body.data.nextQuestion.key).toBe('fin_q05_approvals');
    doc = await AssessmentModel.findById(id).lean();
    expect(doc!.facts.find((f) => f.key === 'authorized')).toMatchObject({ value: false, source: 'ai' });
  });

  it('submit before intake is complete is refused; after completion it scores, explains, recommends [FR-08, FR-18, FR-20, AI-02]', async () => {
    const res = await post('/api/v1/assessments', requestor, { personaKey: 'finance_officer', text: 'unauthorized wire transfer without approval' });
    const id = res.body.data._id;
    const early = await post(`/api/v1/assessments/${id}/submit`, requestor);
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('MISSING_REQUIRED_FACTS');

    const done = await answerUntilDone(
      id,
      { fin_q01_process: 'Treasury wire to an external vendor account.', fin_q03_amount: 250000, fin_q04_authorized: false, fin_q05_approvals: false, fin_q18_unauthorized_tx: true, fin_q10_controls_bypassed: true, fin_q13_loss_liability: true, gen_q_status: 'active', gen_q_similar_incident: false, gen_q_actions: 'Wire recall requested and the vendor account was blocked immediately.' },
      genericAnswer,
    );
    expect(done.intakeComplete).toBe(true);
    expect(done.status).toBe('intake_complete');

    const sub = await post(`/api/v1/assessments/${id}/submit`, requestor);
    expect(sub.status).toBe(200);
    const r = sub.body.data.result;
    expect(sub.body.data.status).toBe('awaiting_decision');
    expect(r.classification).toBe('elevated_risk');
    expect(r.ruleDriven).toBe(false);
    expect(r.score).toBeGreaterThanOrEqual(51);
    expect(r.confidence).toBeGreaterThanOrEqual(60);
    expect(r.explanation.length).toBeGreaterThan(20);
    expect(r.recommendedAction).toBe('Further Professional Risk Guidance Needed');
    const actions = await AuditLogModel.find({ 'entity.id': id, category: 'assessment' }).sort({ seq: 1 }).lean();
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(['assessment.started', 'assessment.scenario_selected', 'assessment.answered', 'assessment.rules_evaluated', 'assessment.scored', 'assessment.recommended']));
  });

  it('a confirmed-fraud answer makes the result rule-driven [FR-17]', async () => {
    const res = await post('/api/v1/assessments', requestor, { personaKey: 'finance_officer', text: 'suspected fraud on a vendor payment account' });
    const id = res.body.data._id;
    await answerUntilDone(id, { fin_q06_fraud_suspected: true, fin_q06a_fraud_confirmed: 'confirmed', fin_q03_amount: 500, gen_q_status: 'contained' }, genericAnswer);
    const sub = await post(`/api/v1/assessments/${id}/submit`, requestor);
    expect(sub.body.data.result).toMatchObject({ classification: 'issue', ruleDriven: true, ruleKey: 'sheet_fraud_confirmed_eq_confirmed' });
  });

  it('decision: accept closes; override needs a 25+ char reason; escalate keeps it open; closing without decision is impossible at the model layer [AI-01, FR-22, FR-23]', async () => {
    const res = await post('/api/v1/assessments', requestor, { personaKey: 'finance_officer', text: 'unauthorized wire transfer without approval' });
    const id = res.body.data._id;
    await answerUntilDone(id, {}, genericAnswer);
    await post(`/api/v1/assessments/${id}/submit`, requestor);

    const badOverride = await post(`/api/v1/assessments/${id}/decision`, requestor, { type: 'override', overriddenTo: 'risk', reason: 'too short' });
    expect(badOverride.status).toBe(400);
    const esc = await post(`/api/v1/assessments/${id}/decision`, requestor, { type: 'escalate', reason: 'Needs the CFO' });
    expect(esc.body.data.status).toBe('escalated');
    const acc = await post(`/api/v1/assessments/${id}/decision`, requestor, { type: 'accept' });
    expect(acc.body.data.status).toBe('closed');
    expect(acc.body.data.decision.type).toBe('accept');
    expect(acc.body.data.timing.durationSec).toBeGreaterThanOrEqual(0);
    expect(await AuditLogModel.countDocuments({ action: 'decision.recorded', 'entity.id': id })).toBe(2);

    // Model-layer invariant: no code path can close without a decision.
    const doc = await AssessmentModel.findById(id);
    doc!.decision = undefined as never;
    await expect(doc!.save()).rejects.toThrow(/AI-01/);
    // …and even a raw update cannot bypass the API contract: there is no endpoint that sets closed.
    await mongoose.connection.db!.collection('assessments').updateOne({ _id: doc!._id }, { $set: { status: 'awaiting_decision' } });
    const again = await post(`/api/v1/assessments/${id}/decision`, requestor, { type: 'override', overriddenTo: 'risk', reason: 'Reviewed with the treasury lead; exposure is contained and reversed.' });
    expect(again.body.data.status).toBe('closed');
    expect(again.body.data.decision.overriddenTo).toBe('risk');
  });

  it('requestors see only their own assessments; another requestor cannot read it [DASH-04]', async () => {
    const res = await post('/api/v1/assessments', requestor, { personaKey: 'finance_officer' });
    const other = await login('requestor@paid.local');
    const list = await request(app).get('/api/v1/assessments').set(requestor);
    expect(list.body.data.total).toBe(1);
    const denied = await request(app).get(`/api/v1/assessments/${res.body.data._id}`).set(other);
    expect(denied.status).toBe(404); // different PAID tenant → not found
    const auditor = await login('audit@dev.local');
    const ok = await request(app).get(`/api/v1/assessments/${res.body.data._id}`).set(auditor);
    expect(ok.status).toBe(200);
  });

  it('same-department review access cannot mutate another requestor intake [SEC-01, DASH-04]', async () => {
    const owner = await login('requestor@paid.local');
    const colleague = await login('colleague@paid.local');
    const started = await post('/api/v1/assessments', owner, { personaKey: 'finance_officer' });
    expect(started.status).toBe(201);
    const id = started.body.data._id as string;

    // PAID review scope still grants the Finance colleague read access.
    expect((await request(app).get(`/api/v1/assessments/${id}`).set(colleague)).status).toBe(200);

    const denied = await Promise.all([
      post(`/api/v1/assessments/${id}/persona`, colleague, { personaKey: 'it_support' }),
      post(`/api/v1/assessments/${id}/messages`, colleague, { text: 'I should not be able to describe someone else’s incident.' }),
      post(`/api/v1/assessments/${id}/submit`, colleague),
    ]);
    expect(denied.map((r) => r.status)).toEqual([403, 403, 403]);
    expect(denied.map((r) => r.body.error.code)).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);
    const colleagueUser = await UserModel.findOne({ email: 'colleague@paid.local' }).lean();
    expect(await AuditLogModel.countDocuments({ action: 'access.denied', actorUserId: colleagueUser!._id, 'payload.code': 'FORBIDDEN' })).toBe(3);

    const stored = await AssessmentModel.findById(id).lean();
    expect(stored).toMatchObject({ personaKey: 'finance_officer', phase: 'describe', status: 'in_progress' });
    expect(stored!.openingText).toBeUndefined();
  });
});
