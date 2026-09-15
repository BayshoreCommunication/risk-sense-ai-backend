/**
 * npm run seed:showcase — wipe every operational record and rebuild a guided demo dataset.
 *
 * Purpose: after running this, each of the four roles can sign in and find populated, self-explanatory
 * screens. The previous demo seed only filled the `acme` tenant, so the administrator, system administrator
 * and auditor (who live in `tac`) saw empty tables everywhere. It also referenced scenario keys that do not
 * exist in the content library, so scenario names never resolved.
 *
 * What it deletes: users, sessions, OTP state, assessments, transcripts, audit logs, retention/conformance
 * runs and flags, archives, cached reports.
 * What it keeps: tenants, departments and the whole content library (personas, scenarios, questions, rules,
 * scoring matrices, datasets) — those come from `npm run seed` / `seed:content`.
 *
 * Refuses to run in production.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { connectDb } from '../lib/db';
import { AssessmentMessageModel, AssessmentModel } from '../modules/assessments/model';
import { audit } from '../modules/audit/service';
import { AuditLogModel } from '../modules/audit/model';
import { AssessmentConformanceFlagModel, ConformanceRunModel } from '../modules/conformance/model';
import { AssessmentArchiveModel, RetentionRunModel } from '../modules/retention/model';
import { retentionService } from '../modules/retention/service';
import { conformanceService } from '../modules/conformance/service';
import { DrStatusModel } from '../modules/system/dr.model';
import { ReportModel } from '../modules/reports/model';
import { SessionModel } from '../modules/auth/model';
import { DepartmentModel, TenantModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';
import { seed } from './seed';

const DAY = 86400e3;
const now = Date.now();

/** Deterministic pseudo-random so two runs produce the same demo. */
function rnd(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const r = rnd(20260915);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

/** Matrix thresholds from the starter scoring sheet. */
const classify = (score: number) => (score <= 25 ? 'monitor_only' : score <= 50 ? 'risk' : score <= 75 ? 'elevated_risk' : 'issue');

type Fact = { key: string; value: unknown; source: 'mcq' | 'ai' | 'system'; confidence: number; flagged: boolean; questionKey?: string; evidence?: string };

/**
 * Three fully written incidents, one per persona, using the real question/fact keys of the active content.
 * Each carries the transcript a requestor would actually have produced.
 */
const STORIES = [
  {
    personaKey: 'finance_officer',
    scenarioKey: 'fin_unauthorized_transaction',
    sector: 'financial',
    opening: 'A vendor wire of $250,000 went out yesterday without the second approval and nobody can find the payment request.',
    turns: [
      { q: 'fin_q01_process', text: 'Which financial process or business activity was affected?', a: 'Vendor payment run for the quarterly infrastructure invoices.', fact: { key: 'affected_process', value: 'vendor payment run', source: 'ai' as const, confidence: 0.91 } },
      { q: 'fin_q02_funds', text: 'Does this incident involve customer funds, company funds, or both?', a: 'Company funds', fact: { key: 'funds_type', value: 'company', source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q03_amount', text: 'Approximately how much money is involved in this incident (USD)?', a: '250000', fact: { key: 'amount_usd', value: 250000, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q04_authorized', text: 'Was the transaction authorized according to company procedures?', a: 'No', fact: { key: 'authorized', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q05_approvals', text: 'Were all required approvals obtained before the transaction?', a: 'No', fact: { key: 'approvals_obtained', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q18_unauthorized_tx', text: 'Was a transaction executed without authorization?', a: 'Yes', fact: { key: 'unauthorized_transaction', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q10_controls_bypassed', text: 'Were any internal controls bypassed, overridden, or found to be ineffective?', a: 'Yes', fact: { key: 'controls_bypassed', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q13_loss_liability', text: 'Could this incident result in financial loss or legal liability for the organization?', a: 'Yes', fact: { key: 'loss_or_liability', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_status', text: 'Is the incident still active, or has it been contained or resolved?', a: 'Contained', fact: { key: 'incident_status', value: 'contained', source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_similar_incident', text: 'Has a similar incident occurred previously within your department or organization?', a: 'No', fact: { key: 'similar_incident_before', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_actions', text: 'What corrective actions have already been taken?', a: 'Treasury has been informed and a bank recall was filed the same morning.', fact: { key: 'corrective_actions', value: 'bank recall filed', source: 'ai' as const, confidence: 0.88 } },
    ],
    score: 78,
    explanation: 'A $250,000 vendor payment left the company without the required second approval, and internal controls were bypassed. The incident is contained and a bank recall has been filed, but the exposure and the control failure together put this at the top of the range.',
    drivers: ['amount_usd = 250000', 'authorized = false', 'controls_bypassed = true'],
    action: 'Escalate for Formal Investigation',
  },
  {
    personaKey: 'it_support',
    scenarioKey: 'it_malware_ransomware',
    sector: 'it',
    opening: 'Three laptops in the finance team started encrypting files after someone opened an invoice attachment this morning.',
    turns: [
      { q: 'it_q06_malware', text: 'What type of attack was involved?', a: 'Ransomware', fact: { key: 'attack_type', value: 'ransomware', source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q11_systems_count', text: 'How many systems or accounts were affected?', a: '3', fact: { key: 'affected_count', value: 3, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q03_privileged', text: 'Were any privileged or administrator accounts involved?', a: 'No', fact: { key: 'privileged_accounts_involved', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q00_data_exposed', text: 'Was any sensitive or confidential data exposed?', a: 'Yes', fact: { key: 'sensitive_data_exposed', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q05_controls_bypassed', text: 'Were any security controls bypassed or ineffective?', a: 'Yes', fact: { key: 'controls_bypassed', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q08_notification', text: 'Is regulatory or customer notification required?', a: 'No', fact: { key: 'notification_required', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q27_impact', text: 'What is the estimated financial impact (USD)?', a: '15000', fact: { key: 'amount_usd', value: 15000, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q09_containment', text: 'What containment actions were taken?', a: 'The three laptops were isolated from the network within twenty minutes and rebuilt from clean images.', fact: { key: 'containment_actions', value: 'isolated and reimaged', source: 'ai' as const, confidence: 0.86 } },
      { q: 'gen_q_status', text: 'Is the incident still active, or has it been contained or resolved?', a: 'Contained', fact: { key: 'incident_status', value: 'contained', source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_similar_incident', text: 'Has a similar incident occurred previously within your department or organization?', a: 'Yes', fact: { key: 'similar_incident_before', value: true, source: 'mcq' as const, confidence: 1 } },
    ],
    score: 64,
    explanation: 'Ransomware reached three finance laptops through an emailed attachment and sensitive files were exposed before the machines were isolated. No privileged accounts were involved and containment was fast, which keeps this below the top band, but a similar incident has happened before.',
    drivers: ['attack_type = ransomware', 'sensitive_data_exposed = true', 'similar_incident_before = true'],
    action: 'Manage the Risk',
  },
  {
    personaKey: 'healthcare_compliance_officer',
    scenarioKey: 'hc_patient_safety_incident',
    sector: 'healthcare',
    opening: 'A patient on ward three received a double dose of their evening medication because two nurses each recorded the round.',
    turns: [
      { q: 'hc_q04_safety_compromised', text: 'Was patient safety compromised?', a: 'Yes', fact: { key: 'patient_safety_compromised', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'hc_q06_injury', text: 'Did the incident cause injury or create a risk of injury?', a: 'Yes', fact: { key: 'injury_or_risk', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'hc_q01_care_delayed', text: 'Was patient care delayed?', a: 'No', fact: { key: 'patient_care_delayed', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'hc_q05_cause', text: 'What was the primary cause of the incident?', a: 'Human error', fact: { key: 'incident_cause', value: 'human_error', source: 'mcq' as const, confidence: 1 } },
      { q: 'hc_q07_patients_affected', text: 'How many patients were affected?', a: '1', fact: { key: 'patients_affected', value: 1, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_regulatory_trigger', text: 'Does this incident trigger a regulatory reporting obligation?', a: 'Yes', fact: { key: 'regulatory_reporting_triggered', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_status', text: 'Is the incident still active, or has it been contained or resolved?', a: 'Resolved', fact: { key: 'incident_status', value: 'resolved', source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_similar_incident', text: 'Has a similar incident occurred previously within your department or organization?', a: 'No', fact: { key: 'similar_incident_before', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_actions', text: 'What corrective actions have already been taken?', a: 'The patient was observed overnight with no adverse effect and the medication round is now signed off by a single named nurse.', fact: { key: 'corrective_actions', value: 'single sign-off introduced', source: 'ai' as const, confidence: 0.84 } },
    ],
    score: 71,
    explanation: 'A double medication dose reached one patient because the evening round was recorded twice. The patient was observed with no adverse effect and the process has been changed, but the event caused a risk of injury and triggers a reporting obligation.',
    drivers: ['patient_safety_compromised = true', 'injury_or_risk = true', 'regulatory_reporting_triggered = true'],
    action: 'Escalate for Formal Investigation',
  },
] as const;

type Story = (typeof STORIES)[number];

interface BuildInput {
  tenant: { _id: mongoose.Types.ObjectId; slug: string; plan: string; features: { fullAudit?: boolean } };
  requestorId: mongoose.Types.ObjectId;
  departmentId?: mongoose.Types.ObjectId;
  story: Story;
  startedAt: Date;
  /** How far the assessment got. */
  state: 'in_progress' | 'intake_complete' | 'awaiting_decision' | 'error_review' | 'escalated' | 'accepted' | 'overridden';
  /** Forces a low confidence so the assessment lands in the administrator's mandatory-review queue (AI-03). */
  lowConfidence?: boolean;
  escalateToUserId?: mongoose.Types.ObjectId;
  deciderId?: mongoose.Types.ObjectId;
  /** Writes the audit trail so reconstruction and chain verification have something to show. */
  withAudit: boolean;
}

/** FREE tenants log the lifecycle skeleton only (FR-24); PAID logs everything (FR-26). */
const payload = (full: boolean, a: Record<string, unknown>, b: Record<string, unknown>) => (full ? a : b);

async function buildAssessment(input: BuildInput) {
  const { tenant, story, startedAt, state } = input;
  const full = Boolean(tenant.features?.fullAudit);
  const answered = state === 'in_progress' ? Math.max(2, Math.floor(story.turns.length / 2)) : story.turns.length;
  const turns = story.turns.slice(0, answered);
  const facts: Fact[] = turns.map((t) => ({
    key: t.fact.key,
    value: t.fact.value,
    source: t.fact.source,
    confidence: t.fact.confidence,
    flagged: t.fact.confidence < 0.7,
    questionKey: t.q,
    evidence: t.fact.source === 'ai' ? t.a : undefined,
  }));

  const intakeCompletedAt = new Date(startedAt.getTime() + (240 + Math.floor(r() * 600)) * 1000);
  const submittedAt = new Date(intakeCompletedAt.getTime() + 15_000);
  const scored = state !== 'in_progress' && state !== 'intake_complete';
  const score = state === 'error_review' ? 0 : story.score;
  const computed = classify(score);
  const confidence = input.lowConfidence ? 34 : 70 + Math.floor(r() * 25);
  const decidedAt = new Date(submittedAt.getTime() + (900 + Math.floor(r() * 3 * 86400)) * 1000);
  const closed = state === 'accepted' || state === 'overridden';
  const overriddenTo = state === 'overridden' ? (computed === 'issue' ? 'elevated_risk' : 'issue') : undefined;

  const doc = await AssessmentModel.create({
    tenantId: tenant._id,
    requestorId: input.requestorId,
    departmentId: input.departmentId,
    status: state === 'accepted' || state === 'overridden' ? 'closed' : state === 'escalated' ? 'escalated' : state,
    phase: state === 'in_progress' ? 'questions' : 'done',
    openingText: story.opening,
    personaKey: story.personaKey,
    personaSource: 'ai',
    scenarioKey: story.scenarioKey,
    scenarioSource: 'ai',
    sector: story.sector,
    versions: { promptVersion: 'v1', aiProvider: 'demo' },
    answers: turns.map((t) => ({ questionKey: t.q, text: t.fact.source === 'ai' ? t.a : undefined, value: t.fact.source === 'mcq' ? t.fact.value : undefined, answeredAt: startedAt })),
    facts,
    askedQuestionKeys: turns.map((t) => t.q),
    currentQuestionKey: state === 'in_progress' ? story.turns[answered]?.q : undefined,
    createdAt: startedAt,
    ...(scored
      ? {
          result: {
            score,
            classification: computed,
            computedClassification: computed,
            ruleDriven: false,
            confidence,
            professionalConsult: confidence < 60,
            mandatoryReview: confidence < 40,
            explanation: story.explanation,
            keyDrivers: [...story.drivers],
            recommendedAction: confidence < 60 ? 'Further Professional Risk Guidance Needed' : story.action,
            nextSteps: [],
            factors: { impact: { value: 4, weight: 20, contribution: 16, matchedMapping: 0 }, severity: { value: 4, weight: 20, contribution: 16, matchedMapping: 0 } },
            computedAt: submittedAt,
          },
        }
      : {}),
    ...(state === 'escalated'
      ? { decision: { type: 'escalate', byUserId: input.requestorId, reason: 'Needs a second reviewer before this is closed.', decidedAt }, escalatedToUserId: input.escalateToUserId }
      : closed
        ? {
            decision: {
              type: state === 'overridden' ? 'override' : 'accept',
              byUserId: input.deciderId ?? input.requestorId,
              overriddenTo,
              reason: state === 'overridden' ? 'Reviewed with the department lead; the exposure is wider than the score suggests and the classification was raised.' : undefined,
              decidedAt,
            },
          }
        : {}),
    timing: {
      startedAt,
      ...(state !== 'in_progress' ? { intakeCompletedAt } : {}),
      ...(scored ? { submittedAt } : {}),
      ...(closed ? { closedAt: decidedAt, durationSec: Math.round((decidedAt.getTime() - startedAt.getTime()) / 1000) } : {}),
    },
  });

  // Transcript, so the chat view and the audit reconstruction read like a real conversation.
  const msgs: Record<string, unknown>[] = [
    { role: 'user', kind: 'answer', content: story.opening },
    { role: 'assistant', kind: 'info', content: `Scenario: ${story.scenarioKey.replace(/_/g, ' ')}` },
  ];
  for (const t of turns) {
    msgs.push({ role: 'assistant', kind: 'question', content: t.text, questionKey: t.q });
    msgs.push({ role: 'user', kind: 'answer', content: t.a, questionKey: t.q });
  }
  if (scored) msgs.push({ role: 'assistant', kind: 'result', content: story.explanation });
  if (state === 'escalated') msgs.push({ role: 'user', kind: 'decision', content: 'Escalated for a second review' });
  if (closed) msgs.push({ role: 'user', kind: 'decision', content: state === 'overridden' ? `Overridden to ${overriddenTo}` : 'Accepted the recommendation' });
  await AssessmentMessageModel.create(msgs.map((m) => ({ ...m, tenantId: tenant._id, assessmentId: doc._id })));

  if (!input.withAudit) return doc;

  const tid = String(tenant._id);
  const actor = { id: String(input.requestorId), role: 'requestor' };
  const entity = { type: 'assessment', id: String(doc._id) };
  await audit.write({ tenantId: tid, category: 'assessment', action: 'assessment.started', actor, entity, payload: payload(full, { personaKey: story.personaKey, personaSource: 'ai', openingText: story.opening }, { personaKey: story.personaKey }) });
  await audit.write({ tenantId: tid, category: 'assessment', action: 'assessment.scenario_selected', actor, entity, payload: { scenarioKey: story.scenarioKey, source: 'ai', confidence: 0.82, versions: { promptVersion: 'v1' } } });
  for (const t of turns) {
    await audit.write({
      tenantId: tid,
      category: 'assessment',
      action: 'assessment.answered',
      actor,
      entity,
      payload: payload(full, { questionKey: t.q, answer: t.fact.value, facts: [{ key: t.fact.key, value: t.fact.value }], branched: [] }, { questionKey: t.q, branched: 0 }),
    });
  }
  if (scored) {
    await audit.write({ tenantId: tid, category: 'assessment', action: 'assessment.rules_evaluated', actor, entity, payload: payload(full, { fired: [], winner: null }, { fired: 0 }) });
    await audit.write({ tenantId: tid, category: 'assessment', action: 'assessment.scored', actor, entity, payload: payload(full, { score, computedClassification: computed, factors: { impact: { value: 4 } } }, { score, classification: computed }) });
    await audit.write({ tenantId: tid, category: 'assessment', action: 'assessment.recommended', actor, entity, payload: payload(full, { classification: computed, ruleDriven: false, confidence, recommendedAction: story.action, explanation: story.explanation }, { classification: computed, confidence }) });
  }
  if (state === 'escalated' || closed) {
    await audit.write({
      tenantId: tid,
      category: 'decision',
      action: 'decision.recorded',
      actor: { id: String(input.deciderId ?? input.requestorId), role: 'requestor' },
      entity,
      payload: { type: state === 'overridden' ? 'override' : state === 'escalated' ? 'escalate' : 'accept', overriddenTo: overriddenTo ?? null, escalatedToUserId: input.escalateToUserId ? String(input.escalateToUserId) : null, aiClassification: computed, ...(full ? { reason: state === 'overridden' ? 'Reviewed with the department lead.' : null } : {}) },
    });
  }
  return doc;
}

/** Older rows that only exist to give the analytics charts a twelve-month shape. */
async function buildHistory(tenantId: mongoose.Types.ObjectId, requestorIds: mongoose.Types.ObjectId[], departmentIds: (mongoose.Types.ObjectId | undefined)[], count: number) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const story = pick(STORIES);
    const ageDays = 14 + Math.floor(350 * r() ** 1.3);
    const startedAt = new Date(now - ageDays * DAY - Math.floor(r() * DAY));
    if ([0, 6].includes(startedAt.getUTCDay()) && r() < 0.7) continue;
    const score = Math.min(100, Math.max(1, Math.round(story.score + (r() + r() - 1) * 45)));
    const cls = classify(score);
    // Spans the whole band on purpose: below 60 triggers Professional Consult (FR-20) and below 40 the
    // mandatory-review flag (AI-03), so both administrator queues have real content.
    const confidence = Math.round(30 + r() * 68);
    const roll = r();
    // Anything the engine flagged for mandatory review (AI-03) stays pending, otherwise the administrator's
    // queue would be empty because history rows are almost all closed.
    const status = confidence < 40 ? 'awaiting_decision' : roll < 0.08 ? 'escalated' : roll < 0.14 ? 'awaiting_decision' : 'closed';
    const overridden = status === 'closed' && r() < 0.22;
    const submittedAt = new Date(startedAt.getTime() + 600_000);
    const closedAt = status === 'closed' ? new Date(submittedAt.getTime() + (900 + r() * 2 * 86400) * 1000) : undefined;
    const requestorId = pick(requestorIds);
    rows.push({
      tenantId,
      requestorId,
      departmentId: pick(departmentIds),
      status,
      phase: 'done',
      personaKey: story.personaKey,
      personaSource: 'ai',
      scenarioKey: story.scenarioKey,
      scenarioSource: 'ai',
      sector: story.sector,
      versions: { promptVersion: 'v1', aiProvider: 'demo' },
      openingText: story.opening,
      facts: [{ key: 'incident_status', value: 'contained', source: 'mcq', confidence: 1, flagged: false }],
      createdAt: startedAt,
      result: {
        score, classification: cls, computedClassification: cls, ruleDriven: r() < 0.08, confidence,
        professionalConsult: confidence < 60, mandatoryReview: confidence < 40,
        explanation: story.explanation, keyDrivers: [...story.drivers], recommendedAction: story.action, nextSteps: [],
        factors: { impact: { value: 3, weight: 20, contribution: 12, matchedMapping: 0 } }, computedAt: submittedAt,
      },
      ...(status === 'closed'
        ? { decision: { type: overridden ? 'override' : 'accept', byUserId: requestorId, overriddenTo: overridden ? (cls === 'issue' ? 'elevated_risk' : 'issue') : undefined, reason: overridden ? 'Reviewed with the department lead and adjusted after discussion.' : undefined, decidedAt: closedAt } }
        : status === 'escalated'
          ? { decision: { type: 'escalate', byUserId: requestorId, decidedAt: submittedAt } }
          : {}),
      timing: { startedAt, intakeCompletedAt: new Date(startedAt.getTime() + 540_000), submittedAt, ...(closedAt ? { closedAt, durationSec: Math.round((closedAt.getTime() - startedAt.getTime()) / 1000) } : {}) },
    });
  }
  if (rows.length) await AssessmentModel.insertMany(rows);
  return rows.length;
}

export async function seedShowcase() {
  if (env.NODE_ENV === 'production') throw new Error('seed:showcase must never run against production');

  // 1. Wipe everything operational. Content and tenants survive.
  const wiped: Record<string, number> = {};
  for (const [name, model] of [
    ['assessments', AssessmentModel], ['assessmentMessages', AssessmentMessageModel], ['auditLogs', AuditLogModel],
    ['sessions', SessionModel], ['users', UserModel], ['retentionRuns', RetentionRunModel],
    ['assessmentArchives', AssessmentArchiveModel], ['conformanceRuns', ConformanceRunModel],
    ['assessmentConformanceFlags', AssessmentConformanceFlagModel], ['reports', ReportModel],
  ] as const) {
    wiped[name] = (await (model as mongoose.Model<unknown>).collection.deleteMany({})).deletedCount ?? 0;
  }
  for (const c of ['otpCodes', 'otpIssueLocks', 'auditArchiveManifests', 'drStatuses']) {
    try { wiped[c] = (await mongoose.connection.db!.collection(c).deleteMany({})).deletedCount ?? 0; } catch { /* collection may not exist */ }
  }

  // 2. Recreate tenants, departments and one account per role.
  await seed();

  const tenants = Object.fromEntries((await TenantModel.find().lean()).map((t) => [t.slug, t]));
  const users = Object.fromEntries((await UserModel.find().lean()).map((u) => [u.email, u]));
  const depts = Object.fromEntries((await DepartmentModel.find().lean()).map((d) => [d.name, d]));
  const built: Record<string, number> = {};

  // 3. PAID customer tenant (acme): the full review + escalation + analytics story.
  const acme = tenants.acme!;
  const finance = depts.Finance!;
  const it = depts.IT!;
  const acmeStates: BuildInput['state'][] = ['in_progress', 'intake_complete', 'awaiting_decision', 'awaiting_decision', 'escalated', 'accepted', 'overridden', 'error_review'];
  let day = 1;
  for (const state of acmeStates) {
    await buildAssessment({
      tenant: acme as never,
      requestorId: users['requestor@paid.local']!._id,
      departmentId: finance._id,
      story: STORIES[0],
      startedAt: new Date(now - day++ * DAY),
      state,
      lowConfidence: state === 'awaiting_decision' && day % 2 === 0,
      escalateToUserId: users['colleague@paid.local']!._id,
      deciderId: users['requestor@paid.local']!._id,
      withAudit: true,
    });
  }
  for (const state of ['awaiting_decision', 'escalated', 'accepted'] as BuildInput['state'][]) {
    await buildAssessment({
      tenant: acme as never, requestorId: users['itlead@paid.local']!._id, departmentId: it._id, story: STORIES[1],
      startedAt: new Date(now - day++ * DAY), state, escalateToUserId: users['requestor@paid.local']!._id,
      deciderId: users['itlead@paid.local']!._id, withAudit: true,
    });
  }
  built.acmeShowcase = acmeStates.length + 3;
  built.acmeHistory = await buildHistory(acme._id, [users['requestor@paid.local']!._id, users['itlead@paid.local']!._id, users['colleague@paid.local']!._id], [finance._id, it._id], 220);

  // 4. TAC tenant: this is where the administrator, system administrator and auditor sign in, so it needs
  //    its own history — otherwise every one of their screens is empty.
  const tac = tenants.tac!;
  day = 1;
  for (const story of STORIES) {
    for (const state of ['awaiting_decision', 'escalated', 'accepted', 'overridden'] as BuildInput['state'][]) {
      await buildAssessment({
        tenant: tac as never, requestorId: users['requestor@tac.local']!._id, story,
        startedAt: new Date(now - day++ * DAY), state,
        lowConfidence: state === 'awaiting_decision' && story === STORIES[2],
        escalateToUserId: users['requestor@tac.local']!._id, deciderId: users['requestor@tac.local']!._id, withAudit: true,
      });
    }
  }
  // The TAC requestor also needs an intake to resume, one ready to submit and a score-zero error review,
  // so the administrator and auditor can see those states somewhere.
  for (const state of ['in_progress', 'intake_complete', 'error_review'] as BuildInput['state'][]) {
    await buildAssessment({
      tenant: tac as never, requestorId: users['requestor@tac.local']!._id, story: STORIES[0],
      startedAt: new Date(now - day++ * DAY), state, deciderId: users['requestor@tac.local']!._id, withAudit: true,
    });
  }
  built.tacShowcase = STORIES.length * 4 + 3;
  built.tacHistory = await buildHistory(tac._id, [users['requestor@tac.local']!._id], [undefined], 120);

  // 5. FREE tenant: requestor-only, minimal audit payloads, so the reconstruction view shows "partial".
  const pub = tenants.public!;
  day = 1;
  for (const state of ['in_progress', 'awaiting_decision', 'accepted'] as BuildInput['state'][]) {
    await buildAssessment({
      tenant: pub as never, requestorId: users['requestor@dev.local']!._id, story: STORIES[1],
      startedAt: new Date(now - day++ * DAY), state, deciderId: users['requestor@dev.local']!._id, withAudit: true,
    });
  }
  built.freeShowcase = 3;
  built.freeHistory = await buildHistory(pub._id, [users['requestor@dev.local']!._id], [undefined], 25);

  // 6. System-administrator screens. These run the real services so the records are genuine rather than
  //    hand-written: a dry run and an enforced run per tenant, plus a conformance scan.
  const ops: Record<string, number> = {};
  for (const t of [pub, acme, tac]) {
    await retentionService.run({ dryRun: true, trigger: 'manual', actor: null, tenantId: String(t._id) });
    await retentionService.run({ dryRun: false, trigger: 'scheduler', actor: null, tenantId: String(t._id) });
  }
  ops.retentionRuns = await RetentionRunModel.countDocuments();
  const scans = await conformanceService.scan({ trigger: 'scheduler', actor: null });
  ops.conformanceRuns = Array.isArray(scans) ? scans.length : 0;
  ops.conformanceFlags = await AssessmentConformanceFlagModel.countDocuments();

  // Operator-recorded DR evidence (never provider telemetry, NFR-06): the PAID tenants have a passed drill,
  // the FREE tenant has nothing recorded yet so the screen shows both states.
  const sysadmin = users['sysadmin@dev.local']!._id;
  for (const t of [acme, tac]) {
    await DrStatusModel.updateOne(
      { tenantId: t._id },
      { $set: { provider: 'MongoDB Atlas Cloud Backup', backupsEnabled: true, lastBackupAt: new Date(now - 6 * 3600e3), lastRestoreDrillAt: new Date(now - 45 * DAY), lastRestoreDrillOutcome: 'passed', evidenceRef: 'docs/ai/DRRunbook.md#drill-log', recordedBy: sysadmin } },
      { upsert: true },
    );
  }
  ops.drStatuses = await DrStatusModel.countDocuments();

  return { wiped, built, ops, tenants: Object.keys(tenants), users: Object.keys(users).length };
}

if (require.main === module) {
  connectDb()
    .then(() => seedShowcase())
    .then((res) => {
      console.log(JSON.stringify(res, null, 2));
      return mongoose.disconnect();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
