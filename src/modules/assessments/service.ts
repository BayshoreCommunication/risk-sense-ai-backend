import { Types, type PipelineStage } from 'mongoose';
import { AppError, notFound } from '../../lib/errors';
import type { AuthTenant, AuthUser } from '../../middleware/auth';
import { getAi } from '../ai/service';
import { audit } from '../audit/service';
import { UserModel } from '../users/model';
import { rulesService } from '../rules/service';
import { simulate, type MatrixLike } from '../scoring/compute';
import { scoringService } from '../scoring/service';
import { conditionText, type Facts } from '../shared/conditions';
import { CLASSIFICATIONS, type Classification } from '../shared/enums';
import { applyBranch, initialQueue, missingRequired, nextQuestion, structuredValue, type FlowNode, type QuestionLite } from './branching';
import { activePersonas, activeScenarios, contentTenantId, pinVersions, questionMap, scenarioByKey } from './content';
import { reconstruct } from './reconstruct';
import { ASSESSMENT_STATUSES, AssessmentMessageModel, AssessmentModel, type AssessmentStatus } from './model';
import { PENDING_STATUSES, type DecisionBody, type ListQuery, type MessageBody, type StartBody } from './schema';

const LOW_CONFIDENCE = 0.7; // FR-06: flag, never drop
const PERSONA_MIN_CONFIDENCE = 0.6; // FR-04
const SCENARIO_MIN_CONFIDENCE = 0.5; // FR-05

const PLACEHOLDERS = new Set(['unknown', 'n/a', 'na', 'none', 'not stated', 'not specified', 'unclear', '']);
const isPlaceholder = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && PLACEHOLDERS.has(v.trim().toLowerCase()));

type Doc = InstanceType<typeof AssessmentModel>;

function factsOf(doc: Doc): Facts {
  const out: Facts = {};
  for (const f of doc.facts) out[f.key] = f.value as never;
  return out;
}

function setFact(doc: Doc, fact: { key: string; value: unknown; source: 'mcq' | 'ai' | 'system'; questionKey?: string; confidence?: number; evidence?: string }) {
  const confidence = fact.confidence ?? 1;
  const existing = doc.facts.find((f) => f.key === fact.key);
  const next = { key: fact.key, value: fact.value, source: fact.source, questionKey: fact.questionKey, confidence, flagged: confidence < LOW_CONFIDENCE, evidence: fact.evidence };
  if (existing) Object.assign(existing, next);
  else doc.facts.push(next as never);
}

async function say(doc: Doc, role: 'assistant' | 'user' | 'system', kind: 'info' | 'question' | 'answer' | 'clarification' | 'result' | 'decision', content: string, extra: { questionKey?: string; question?: unknown } = {}) {
  return AssessmentMessageModel.create({ tenantId: doc.tenantId, assessmentId: doc._id, role, kind, content, ...extra });
}

const questionSnapshot = (q: QuestionLite) => ({ key: q.key, text: q.text, type: q.type, factKey: q.factKey, required: q.required, options: q.options });

/** FREE tenants only keep the lifecycle skeleton in the audit log (FR-24, Section 5); PAID keeps everything (FR-26). */
function auditPayload(tenant: AuthTenant, full: Record<string, unknown>, minimal: Record<string, unknown>) {
  return tenant.features.fullAudit ? full : minimal;
}

async function loadFor(user: AuthUser, id: string): Promise<Doc> {
  if (!Types.ObjectId.isValid(id)) throw notFound('assessment');
  const doc = await AssessmentModel.findOne({ _id: id, tenantId: user.tenantId });
  if (!doc) throw notFound('assessment');
  const own = String(doc.requestorId) === user.id;
  const sameDept = doc.departmentId && user.departmentIds.includes(String(doc.departmentId));
  const escalatee = doc.escalatedToUserId && String(doc.escalatedToUserId) === user.id; // T-061
  if (user.role === 'requestor' && !own && !sameDept && !escalatee && !user.crossDepartmentAccess) throw new AppError('FORBIDDEN', 'not your assessment');
  return doc;
}

async function flowContext(doc: Doc) {
  const ct = await contentTenantId(String(doc.tenantId));
  const scenario = await scenarioByKey(ct, doc.scenarioKey!);
  if (!scenario) throw new AppError('CONFLICT', 'the scenario of this assessment is no longer active');
  const flow = scenario.conversationFlow as FlowNode[];
  const questions = await questionMap(ct, flow.map((n) => n.questionKey));
  return { ct, scenario, flow, questions };
}

/** Advances the queue; persists the next question as an assistant message. Returns what the client renders. */
async function advance(doc: Doc, ctx: Awaited<ReturnType<typeof flowContext>>) {
  const facts = factsOf(doc);
  const { question, queue } = nextQuestion({ queue: doc.queue, asked: doc.askedQuestionKeys, flow: ctx.flow, facts, questions: ctx.questions });
  doc.queue = queue as never;
  if (question) {
    doc.currentQuestionKey = question.key;
    doc.phase = 'questions';
    await say(doc, 'assistant', 'question', question.text, { questionKey: question.key, question: questionSnapshot(question) });
    return { nextQuestion: questionSnapshot(question), intakeComplete: false, missingRequired: [] as string[] };
  }
  // Queue empty: are all required facts present? If not, re-ask the question that produces the first missing fact once.
  const missing = missingRequired(ctx.scenario.requiredFactKeys, facts);
  for (const factKey of missing) {
    const producer = [...ctx.questions.values()].find((q) => q.factKey === factKey);
    const reAsked = doc.askedQuestionKeys.filter((k) => k === producer?.key).length;
    if (producer && reAsked < 2) {
      doc.currentQuestionKey = producer.key;
      doc.askedQuestionKeys = doc.askedQuestionKeys.filter((k) => k !== producer.key) as never; // allow one more ask
      await say(doc, 'assistant', 'clarification', `I still need this to continue: ${producer.text}`, { questionKey: producer.key, question: questionSnapshot(producer) });
      return { nextQuestion: questionSnapshot(producer), intakeComplete: false, missingRequired: missing };
    }
  }
  doc.currentQuestionKey = undefined;
  doc.phase = 'done';
  doc.status = 'intake_complete';
  doc.timing!.intakeCompletedAt = new Date();
  await say(doc, 'assistant', 'info', 'Thank you — I have everything I need. Submit the assessment to get the result.');
  return { nextQuestion: null, intakeComplete: true, missingRequired: missing };
}

/**
 * T-061 escalation routing (PAID `reviewDashboard`): who may receive this assessment. Requestors of the same
 * tenant who either share the assessment's department or hold cross-department access; never the caller.
 * Administrators are content owners (TAC), not decision makers, so they are not targets (Overview.md roles).
 */
async function escalationCandidates(user: AuthUser, tenant: AuthTenant, doc: Doc) {
  if (!tenant.features.reviewDashboard) return [];
  const reach: Record<string, unknown>[] = [{ crossDepartmentAccess: true }];
  if (doc.departmentId) reach.push({ departmentIds: doc.departmentId });
  const users = await UserModel.find({ tenantId: user.tenantId, role: 'requestor', status: 'active', _id: { $ne: user.id }, $or: reach })
    .sort({ name: 1 })
    .select('name email departmentIds crossDepartmentAccess')
    .lean();
  return users.map((u) => ({ _id: String(u._id), name: u.name, email: u.email, departmentIds: u.departmentIds.map(String), crossDepartmentAccess: u.crossDepartmentAccess }));
}

export const assessmentsService = {
  /** T-031/T-032: create the session; choose or infer the persona (FR-04). */
  async start(user: AuthUser, tenant: AuthTenant, body: StartBody) {
    const ct = await contentTenantId(user.tenantId);
    const personas = await activePersonas(ct);
    if (personas.length === 0) throw new AppError('CONFLICT', 'no active personas are configured yet');
    const ai = getAi();
    const doc = new AssessmentModel({
      tenantId: user.tenantId,
      requestorId: user.id,
      departmentId: user.departmentIds[0],
      openingText: body.text?.trim(),
      versions: { promptVersion: ai.promptVersion, aiProvider: ai.provider },
    });
    if (body.text) await say(doc, 'user', 'answer', body.text.trim());

    if (body.personaKey) {
      const p = personas.find((x) => x.key === body.personaKey);
      if (!p) throw new AppError('VALIDATION_ERROR', `persona "${body.personaKey}" is not active`);
      doc.personaKey = p.key;
      doc.personaSource = 'user';
    } else {
      const inferred = await ai.inferPersona({ text: body.text!, personas: personas.map((p) => ({ key: p.key, name: p.name, description: p.description, detectHints: p.detectHints })) });
      const p = inferred.personaKey ? personas.find((x) => x.key === inferred.personaKey) : undefined;
      if (p && inferred.confidence >= PERSONA_MIN_CONFIDENCE) {
        doc.personaKey = p.key;
        doc.personaSource = 'ai';
        await say(doc, 'assistant', 'info', `It sounds like you work as a ${p.name}. You can change this if it is wrong.`);
      } else {
        doc.personaCandidates = personas.map((x) => x.key) as never;
        doc.phase = 'persona';
        await say(doc, 'assistant', 'question', 'Which of these roles best describes you?', { question: { key: '__persona', type: 'mcq', options: personas.map((x) => ({ id: x.key, label: x.name })) } });
      }
    }
    await doc.save();
    await audit.write({
      tenantId: user.tenantId,
      category: 'assessment',
      action: 'assessment.started',
      actor: user,
      entity: { type: 'assessment', id: String(doc._id) },
      payload: auditPayload(tenant, { personaKey: doc.personaKey, personaSource: doc.personaSource, openingText: doc.openingText }, { personaKey: doc.personaKey }),
    });
    if (doc.personaKey) return this.afterPersona(doc, user, tenant);
    return this.view(doc);
  },

  /** FR-04: manual choice or override of the AI proposal (only before the questions phase). */
  async setPersona(user: AuthUser, tenant: AuthTenant, id: string, personaKey: string) {
    const doc = await loadFor(user, id);
    if (doc.phase === 'questions' || doc.phase === 'done') throw new AppError('CONFLICT', 'the persona cannot change once questions have started');
    const ct = await contentTenantId(user.tenantId);
    const p = (await activePersonas(ct)).find((x) => x.key === personaKey);
    if (!p) throw new AppError('VALIDATION_ERROR', `persona "${personaKey}" is not active`);
    doc.personaKey = p.key;
    doc.personaSource = 'user';
    doc.personaCandidates = [] as never;
    await say(doc, 'user', 'answer', p.name);
    await audit.write({ tenantId: user.tenantId, category: 'assessment', action: 'assessment.persona_set', actor: user, entity: { type: 'assessment', id }, payload: { personaKey } });
    return this.afterPersona(doc, user, tenant);
  },

  /** Persona known → pick the scenario from the opening text, or ask for a description first (FR-05). */
  async afterPersona(doc: Doc, user: AuthUser, tenant: AuthTenant) {
    if (!doc.openingText) {
      doc.phase = 'describe';
      await say(doc, 'assistant', 'question', 'Please describe what happened, in your own words.', { question: { key: '__describe', type: 'free_text' } });
      await doc.save();
      return this.view(doc);
    }
    return this.selectScenarioAndBegin(doc, user, tenant, doc.openingText);
  },

  async selectScenarioAndBegin(doc: Doc, user: AuthUser, tenant: AuthTenant, text: string) {
    const ct = await contentTenantId(user.tenantId);
    const persona = (await activePersonas(ct)).find((p) => p.key === doc.personaKey)!;
    const scenarios = await activeScenarios(ct, persona.key);
    if (scenarios.length === 0) throw new AppError('CONFLICT', `persona "${persona.key}" has no active scenarios`);
    const picked = await getAi().selectScenario({
      personaName: persona.name,
      text,
      scenarios: scenarios.map((s) => ({ key: s.key, name: s.name, description: s.description, riskIndicators: s.riskIndicators })),
    });
    let scenario = picked.scenarioKey && picked.confidence >= SCENARIO_MIN_CONFIDENCE ? scenarios.find((s) => s.key === picked.scenarioKey) : undefined;
    let source: 'ai' | 'default' = 'ai';
    if (!scenario) {
      scenario = scenarios.find((s) => s.key === persona.defaultScenarioKey) ?? scenarios[0]!;
      source = 'default';
    }
    doc.scenarioKey = scenario.key;
    doc.scenarioSource = source;
    doc.sector = persona.sector;
    // Never spread a Mongoose subdocument back into itself (circular getters); set a plain object.
    const pins = await pinVersions(user.tenantId, ct, persona as never, scenario as never, persona.sector);
    doc.set('versions', { promptVersion: doc.versions?.promptVersion, aiProvider: doc.versions?.aiProvider, ...pins });
    doc.queue = initialQueue(scenario.conversationFlow as FlowNode[]) as never;
    await say(doc, 'assistant', 'info', `Scenario: ${scenario.name}`);
    const ctx = await flowContext(doc);
    const step = await advance(doc, ctx);
    await doc.save();
    await audit.write({
      tenantId: user.tenantId,
      category: 'assessment',
      action: 'assessment.scenario_selected',
      actor: user,
      entity: { type: 'assessment', id: String(doc._id) },
      payload: { scenarioKey: scenario.key, source, confidence: picked.confidence, versions: doc.versions },
    });
    return { ...(await this.view(doc)), ...step };
  },

  /** T-035/T-036: one turn of the intake. */
  async answer(user: AuthUser, tenant: AuthTenant, id: string, body: MessageBody) {
    const doc = await loadFor(user, id);
    if (doc.status !== 'in_progress') throw new AppError('CONFLICT', `assessment is ${doc.status}`);

    if (doc.phase === 'persona') {
      const key = String(body.value ?? body.text ?? '');
      return this.setPersona(user, tenant, id, key);
    }
    if (doc.phase === 'describe') {
      const text = String(body.text ?? body.value ?? '').trim();
      if (text.length < 10) throw new AppError('VALIDATION_ERROR', 'please describe the incident in a few words');
      doc.openingText = text;
      await say(doc, 'user', 'answer', text);
      return this.selectScenarioAndBegin(doc, user, tenant, text);
    }

    const ctx = await flowContext(doc);
    const key = body.questionKey ?? doc.currentQuestionKey;
    if (!key) throw new AppError('CONFLICT', 'no question is pending');
    if (key !== doc.currentQuestionKey) throw new AppError('CONFLICT', `the pending question is "${doc.currentQuestionKey}"`);
    const q = ctx.questions.get(key);
    if (!q) throw new AppError('CONFLICT', 'question is no longer active');

    const raw = body.value ?? body.text!;
    let branchValue: unknown;
    if (q.type === 'free_text' || (body.value === undefined && body.text)) {
      // Free text (or a typed answer to a structured question): the model maps it to facts (FR-06). Never scores.
      const persona = (await activePersonas(ctx.ct)).find((p) => p.key === doc.personaKey);
      const extracted = await getAi().extractFacts({
        question: { key: q.key, text: q.text, factKey: q.factKey, type: q.type },
        answer: String(raw),
        factCatalog: [...ctx.questions.values()].map((x) => ({ key: x.factKey, hint: x.text })),
        vocabulary: persona?.vocabulary ?? [],
      });
      doc.answers.push({ questionKey: q.key, text: String(raw), answeredAt: new Date() } as never);
      await say(doc, 'user', 'answer', String(raw), { questionKey: q.key });
      const known = new Set([...ctx.questions.values()].map((x) => x.factKey));
      // Side facts the answer clearly stated (only catalogued keys, FR-30). They may only FILL gaps:
      // never overwrite a fact that already exists (a clicked MCQ/yes-no/number answer beats a model guess),
      // never accept placeholders, never accept low confidence.
      for (const f of extracted.facts) {
        if (f.key === q.factKey || !known.has(f.key)) continue;
        if (doc.facts.some((x) => x.key === f.key)) continue;
        if (f.confidence < LOW_CONFIDENCE || isPlaceholder(f.value)) continue;
        setFact(doc, { key: f.key, value: f.value, source: 'ai', questionKey: q.key, confidence: f.confidence, evidence: f.evidence });
      }
      // The asked fact is "settled" when it was extracted, fits the question type and is not low-confidence.
      const asked = extracted.facts.find((f) => f.key === q.factKey);
      const coerced = asked ? (q.type !== 'free_text' ? structuredValue(q, asked.value) : { ok: true as const, value: asked.value }) : null;
      const settled = Boolean(asked && coerced?.ok && asked.confidence >= 0.5);
      if (!settled && !doc.clarification) {
        // Ask once for clarification; the question stays current (FR-06: flag, do not drop).
        doc.clarification = extracted.clarification ?? `Could you clarify: ${q.text}`;
        await say(doc, 'assistant', 'clarification', doc.clarification, { questionKey: q.key, question: questionSnapshot(q) });
        await doc.save();
        return { ...(await this.view(doc)), nextQuestion: questionSnapshot(q), intakeComplete: false, missingRequired: [] as string[] };
      }
      const value = coerced && coerced.ok ? coerced.value : (asked?.value ?? String(raw));
      setFact(doc, { key: q.factKey, value, source: 'ai', questionKey: q.key, confidence: settled ? asked!.confidence : Math.min(asked?.confidence ?? 0.3, 0.4), evidence: String(raw) });
      branchValue = value;
    } else {
      const sv = structuredValue(q, raw);
      if (!sv.ok) throw new AppError('VALIDATION_ERROR', sv.error);
      doc.answers.push({ questionKey: q.key, value: raw, answeredAt: new Date() } as never);
      const label = q.type === 'mcq' ? (q.options.find((o) => o.id === raw || o.factValue === raw)?.label ?? String(raw)) : q.type === 'yes_no' ? (sv.value ? 'Yes' : 'No') : String(sv.value);
      await say(doc, 'user', 'answer', label, { questionKey: q.key });
      setFact(doc, { key: q.factKey, value: sv.value, source: 'mcq', questionKey: q.key, confidence: 1 });
      branchValue = sv.value;
    }
    doc.clarification = undefined;
    doc.askedQuestionKeys.push(q.key);
    const { queue, branched } = applyBranch({ question: q, value: branchValue, queue: doc.queue, asked: doc.askedQuestionKeys });
    doc.queue = queue as never;
    const step = await advance(doc, ctx);
    await doc.save();
    await audit.write({
      tenantId: user.tenantId,
      category: 'assessment',
      action: 'assessment.answered',
      actor: user,
      entity: { type: 'assessment', id },
      payload: auditPayload(tenant, { questionKey: q.key, answer: raw, facts: doc.facts.filter((f) => f.questionKey === q.key), branched }, { questionKey: q.key, branched: branched.length }),
    });
    return { ...(await this.view(doc)), ...step };
  },

  /** T-054: rules → scoring → explanation. Only after intake is complete (FR-08). */
  async submit(user: AuthUser, tenant: AuthTenant, id: string) {
    const doc = await loadFor(user, id);
    if (doc.status !== 'intake_complete') throw new AppError('MISSING_REQUIRED_FACTS', `assessment is ${doc.status}; finish the intake first`);
    const ctx = await flowContext(doc);
    const facts = factsOf(doc);
    const missing = missingRequired(ctx.scenario.requiredFactKeys, facts);
    if (missing.length) throw new AppError('MISSING_REQUIRED_FACTS', `missing required facts: ${missing.join(', ')}`, { missing });

    const matrix = await scoringService.currentMatrix(ctx.ct, doc.sector ?? undefined);
    if (!matrix) throw new AppError('CONFLICT', 'no active scoring matrix');
    const rules = await rulesService.activeRules(ctx.ct, doc.sector ?? undefined);
    const factConfidences = Object.fromEntries(doc.facts.map((f) => [f.key, f.confidence]));
    const r = simulate({ matrix: matrix as unknown as MatrixLike, rules, facts, requiredFactKeys: ctx.scenario.requiredFactKeys, factConfidences });
    await audit.write({ tenantId: user.tenantId, category: 'assessment', action: 'assessment.rules_evaluated', actor: user, entity: { type: 'assessment', id }, payload: auditPayload(tenant, { fired: r.rule?.fired ?? [], winner: r.rule?.ruleKey ?? null }, { fired: r.rule?.fired.length ?? 0 }) });
    await audit.write({ tenantId: user.tenantId, category: 'assessment', action: 'assessment.scored', actor: user, entity: { type: 'assessment', id }, payload: auditPayload(tenant, { score: r.score, computedClassification: r.computedClassification, factors: r.factors, matrix: doc.versions?.matrix }, { score: r.score, classification: r.classification }) });

    const rule = r.rule ? rules.find((x) => x.id === r.rule!.ruleId) : undefined;
    const explanation = await getAi().explain({
      classification: r.classification,
      score: r.score,
      ruleDriven: r.ruleDriven,
      rule: rule ? { name: rule.name, condition: conditionText(rule.trigger) } : null,
      factors: Object.entries(r.factors).map(([k, f]) => ({
        key: k,
        value: f.value,
        weight: f.weight,
        points: Math.round(f.contribution * 10) / 10,
        matched: f.matchedMapping === null ? null : conditionText((matrix as unknown as MatrixLike).factors[k as keyof MatrixLike['factors']].mapping[f.matchedMapping]?.when),
      })),
      facts: doc.facts.map((f) => ({ key: f.key, value: f.value })),
      reasoningExample: ctx.scenario.reasoningExample ?? null,
    });
    const actions = (ctx.scenario.recommendedActions as Record<string, { decisionRecommendation?: string; nextSteps?: string[] } | undefined> | undefined)?.[r.classification];
    const recommendedAction = r.professionalConsult ? 'Further Professional Risk Guidance Needed' : (rule?.forcedAction ?? actions?.decisionRecommendation ?? 'Manage the Risk');

    doc.result = {
      score: r.score,
      classification: r.classification,
      computedClassification: r.computedClassification,
      ruleDriven: r.ruleDriven,
      ruleKey: r.rule?.ruleKey,
      ruleName: r.rule?.ruleName,
      confidence: r.confidence,
      professionalConsult: r.professionalConsult,
      mandatoryReview: r.mandatoryReview,
      explanation: explanation.explanation,
      keyDrivers: explanation.keyDrivers,
      recommendedAction,
      nextSteps: actions?.nextSteps ?? [],
      factors: r.factors,
      computedAt: new Date(),
    } as never;
    doc.status = r.errorReview ? 'error_review' : 'awaiting_decision';
    doc.timing!.submittedAt = new Date();
    await say(doc, 'assistant', 'result', explanation.explanation);
    await doc.save();
    await audit.write({ tenantId: user.tenantId, category: 'assessment', action: 'assessment.recommended', actor: user, entity: { type: 'assessment', id }, payload: auditPayload(tenant, { classification: r.classification, ruleDriven: r.ruleDriven, confidence: r.confidence, recommendedAction, explanation: explanation.explanation }, { classification: r.classification, confidence: r.confidence }) });
    return this.view(doc);
  },

  /** T-060: the human decision. The only path that can close an assessment (AI-01, FR-22, FR-23). */
  async decide(user: AuthUser, tenant: AuthTenant, id: string, body: DecisionBody) {
    const doc = await loadFor(user, id);
    if (!['awaiting_decision', 'escalated', 'error_review'].includes(doc.status)) throw new AppError('CONFLICT', `assessment is ${doc.status}`);
    if (doc.status === 'error_review' && body.type === 'accept') throw new AppError('DECISION_REQUIRED', 'a score of 0 cannot be accepted; override with a classification or escalate (FR-18)');
    doc.decision = { type: body.type, byUserId: new Types.ObjectId(user.id), reason: body.reason?.trim(), overriddenTo: body.overriddenTo, decidedAt: new Date() } as never;
    let target: { _id: string; name: string } | undefined;
    if (body.type === 'escalate') {
      if (body.escalateToUserId) {
        if (!tenant.features.reviewDashboard) throw new AppError('FEATURE_DISABLED', 'escalation routing is a PAID feature; escalate without a reviewer instead');
        target = (await escalationCandidates(user, tenant, doc)).find((c) => c._id === body.escalateToUserId);
        if (!target) throw new AppError('VALIDATION_ERROR', 'the chosen reviewer cannot receive this assessment (not in its department, or no cross-department access)', { field: 'escalateToUserId' });
      }
      doc.escalatedToUserId = target ? new Types.ObjectId(target._id) : undefined;
      doc.status = 'escalated';
      await say(doc, 'user', 'decision', `Escalated${target ? ` to ${target.name}` : ''}${body.reason ? `: ${body.reason}` : ''}`);
    } else {
      doc.status = 'closed';
      doc.timing!.closedAt = new Date();
      doc.timing!.durationSec = Math.round((Date.now() - new Date(doc.timing!.startedAt!).getTime()) / 1000);
      await say(doc, 'user', 'decision', body.type === 'accept' ? 'Accepted the recommendation' : `Overridden to ${body.overriddenTo}: ${body.reason}`);
    }
    await doc.save();
    await audit.write({
      tenantId: user.tenantId,
      category: 'decision',
      action: 'decision.recorded',
      actor: user,
      entity: { type: 'assessment', id },
      payload: { type: body.type, overriddenTo: body.overriddenTo ?? null, escalatedToUserId: target?._id ?? null, aiClassification: doc.result?.classification ?? null, ...(tenant.features.fullAudit ? { reason: body.reason ?? null } : {}) },
    });
    return this.view(doc);
  },

  /**
   * T-063 / FR-26: rebuild the lifecycle from the audit log alone, check each entry's hash, and compare the
   * rebuilt state with the stored document (FR-30 conformance). Readers: administrator, system_administrator, audit.
   */
  async reconstructFromAudit(user: AuthUser, tenant: AuthTenant, id: string) {
    const doc = await loadFor(user, id);
    const entries = await audit.forEntity(user.tenantId, 'assessment', id);
    const integrity = audit.verifyEntries(entries as never);
    const r = reconstruct(entries as never);
    const differences: { field: string; fromAudit: unknown; stored: unknown }[] = [];
    const cmp = (field: string, a: unknown, b: unknown) => {
      if (a === null || a === undefined) return; // not reconstructible → not a difference
      if (JSON.stringify(a) !== JSON.stringify(b ?? null)) differences.push({ field, fromAudit: a, stored: b ?? null });
    };
    cmp('personaKey', r.state.personaKey, doc.personaKey);
    cmp('scenarioKey', r.state.scenarioKey, doc.scenarioKey);
    cmp('status', r.state.status === 'unknown' ? null : r.state.status, doc.status);
    cmp('result.score', r.state.score, doc.result?.score);
    cmp('result.classification', r.state.classification, doc.result?.classification);
    cmp('result.confidence', r.state.confidence, doc.result?.confidence);
    cmp('decision.type', r.state.decisions.at(-1)?.type ?? null, doc.decision?.type);
    if (r.completeness === 'full') {
      const stored = Object.fromEntries(doc.facts.map((f) => [f.key, f.value]));
      for (const [k, v] of Object.entries(r.state.facts)) cmp(`facts.${k}`, v, stored[k]);
      for (const k of Object.keys(stored)) if (!(k in r.state.facts)) differences.push({ field: `facts.${k}`, fromAudit: null, stored: stored[k] });
    }
    return {
      assessmentId: id,
      plan: tenant.plan,
      fullAudit: tenant.features.fullAudit,
      entries: entries.length,
      integrity,
      completeness: r.completeness,
      missing: r.missing,
      timeline: r.timeline,
      state: r.state,
      conformance: { matches: differences.length === 0, differences },
    };
  },

  /** T-061: reviewers the caller may escalate this assessment to (empty on FREE tenants). */
  async escalationTargets(user: AuthUser, tenant: AuthTenant, id: string) {
    const doc = await loadFor(user, id);
    return escalationCandidates(user, tenant, doc);
  },

  async get(user: AuthUser, id: string) {
    return this.view(await loadFor(user, id));
  },

  async messages(user: AuthUser, id: string) {
    const doc = await loadFor(user, id);
    return AssessmentMessageModel.find({ assessmentId: doc._id }).sort({ createdAt: 1, _id: 1 }).lean();
  },

  /**
   * DASH-01/DASH-04 review dashboard. Scope: requestors see their own assessments; on PAID tenants with
   * `reviewDashboard` they also see their departments' (or everything with `crossDepartmentAccess`);
   * administrators / system administrators / auditors see the whole tenant. Filters: status or `pending`,
   * classification, persona, scenario, department, date range. `pending_first` sorting is done in the
   * database so it survives pagination. `counts` (per status, within the non-status filters) feed the tabs.
   */
  async list(user: AuthUser, tenant: AuthTenant, q: ListQuery) {
    const scope: Record<string, unknown> = { tenantId: new Types.ObjectId(user.tenantId) };
    if (user.role === 'requestor') {
      const me = new Types.ObjectId(user.id);
      const mine: Record<string, unknown>[] = [{ requestorId: me }, { escalatedToUserId: me }]; // own + routed to me (T-061)
      if (tenant.features.reviewDashboard && user.crossDepartmentAccess) {
        // whole tenant
      } else if (tenant.features.reviewDashboard && user.departmentIds.length) {
        scope.$or = [...mine, { departmentId: { $in: user.departmentIds.map((d) => new Types.ObjectId(d)) } }];
      } else scope.$or = mine;
    }
    // Everything except the status dimension — the tab counts are computed on this.
    const base: Record<string, unknown> = { ...scope };
    if (q.classification) base['result.classification'] = q.classification;
    if (q.personaKey) base.personaKey = q.personaKey;
    if (q.scenarioKey) base.scenarioKey = q.scenarioKey;
    if (q.departmentId) base.departmentId = new Types.ObjectId(q.departmentId);
    if (q.mandatoryReview) base['result.mandatoryReview'] = true;
    if (q.escalatedToMe) base.escalatedToUserId = new Types.ObjectId(user.id);
    if (q.from || q.to) base.createdAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
    const filter: Record<string, unknown> = { ...base };
    if (q.status) filter.status = q.status;
    else if (q.pending) filter.status = { $in: PENDING_STATUSES };

    const order: Record<string, 1 | -1> = q.sort === 'oldest' ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 };
    const pipeline: PipelineStage[] = [
      { $match: filter },
      ...(q.sort === 'pending_first' ? [{ $addFields: { _pending: { $cond: [{ $in: ['$status', PENDING_STATUSES] }, 0, 1] } } }] : []),
      { $sort: q.sort === 'pending_first' ? { _pending: 1, ...order } : order },
      { $skip: (q.page - 1) * q.limit },
      { $limit: q.limit },
      { $lookup: { from: 'users', localField: 'requestorId', foreignField: '_id', as: 'requestor' } },
      { $lookup: { from: 'departments', localField: 'departmentId', foreignField: '_id', as: 'department' } },
      { $lookup: { from: 'users', localField: 'escalatedToUserId', foreignField: '_id', as: 'escalatedTo' } },
      { $unwind: { path: '$requestor', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$department', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$escalatedTo', preserveNullAndEmptyArrays: true } },
      {
        // List rows carry what the dashboard shows (class, confidence, explanation, action — FR-21) and nothing
        // heavier: no answers/facts/queue, no factor breakdown, no other user fields (PII stays minimal).
        $project: {
          status: 1,
          phase: 1,
          personaKey: 1,
          scenarioKey: 1,
          sector: 1,
          requestorId: 1,
          departmentId: 1,
          createdAt: 1,
          timing: 1,
          'result.score': 1,
          'result.classification': 1,
          'result.confidence': 1,
          'result.ruleDriven': 1,
          'result.professionalConsult': 1,
          'result.mandatoryReview': 1,
          'result.recommendedAction': 1,
          'result.explanation': 1,
          'result.computedAt': 1,
          'decision.type': 1,
          'decision.overriddenTo': 1,
          'decision.decidedAt': 1,
          'requestor.name': 1,
          'requestor.email': 1,
          'department.name': 1,
          escalatedToUserId: 1,
          'escalatedTo.name': 1,
        },
      },
    ];
    const [items, total, grouped] = await Promise.all([
      AssessmentModel.aggregate(pipeline),
      AssessmentModel.countDocuments(filter),
      AssessmentModel.aggregate<{ _id: string; n: number }>([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    const byStatus = Object.fromEntries(ASSESSMENT_STATUSES.map((s) => [s, 0])) as Record<AssessmentStatus, number>;
    for (const g of grouped) byStatus[g._id as AssessmentStatus] = g.n;
    const counts = { ...byStatus, pending: PENDING_STATUSES.reduce((n, s) => n + byStatus[s], 0), all: grouped.reduce((n, g) => n + g.n, 0) };
    return {
      items: items.map((it) => ({ ...it, result: it.result?.computedAt ? it.result : null, decision: it.decision?.type ? it.decision : null })),
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.max(1, Math.ceil(total / q.limit)),
      counts,
    };
  },

  async view(doc: Doc) {
    const o = doc.toObject();
    const escalatedTo = o.escalatedToUserId ? await UserModel.findById(o.escalatedToUserId).select('name').lean() : null;
    return {
      _id: String(o._id),
      status: o.status,
      phase: o.phase,
      personaKey: o.personaKey,
      personaSource: o.personaSource,
      personaCandidates: o.personaCandidates,
      scenarioKey: o.scenarioKey,
      scenarioSource: o.scenarioSource,
      sector: o.sector,
      currentQuestionKey: o.currentQuestionKey,
      clarification: o.clarification,
      facts: o.facts,
      result: o.result?.computedAt ? o.result : null,
      decision: o.decision?.type ? o.decision : null,
      escalatedTo: escalatedTo ? { _id: String(escalatedTo._id), name: escalatedTo.name } : null,
      timing: o.timing,
      versions: o.versions,
      createdAt: o.createdAt,
      classifications: CLASSIFICATIONS as readonly Classification[],
    };
  },
};
