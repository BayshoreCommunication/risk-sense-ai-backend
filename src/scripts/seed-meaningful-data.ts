/**
 * npm run seed:meaningful — Populate rich, meaningful operational data for TAC Solutions (PAID tenant).
 *
 * Populates:
 * 1. 5 Real Departments in TAC Solutions mapped to personas.
 * 2. 12+ Realistic Users in TAC Solutions with departments, titles, and roles.
 * 3. Demo Requestor account (requestor@tac.local) provisioned in Firebase Auth & Mongo.
 * 4. 8 Detailed Incident Stories with real question/fact keys, transcripts, and scoring drivers.
 * 5. 30+ Live Showcase Assessments across all review states:
 *    - Review queue (awaiting_decision, high score, low confidence / AI-03 mandatory review, professional consult)
 *    - Overridden (decision.type: override with full rationale)
 *    - Escalated (decision.type: escalate)
 *    - Accepted & Closed (across monitor_only, risk, elevated_risk, issue)
 *    - In-progress & Intake-complete
 * 6. Cryptographic SHA-256 audit trail for all assessments & config events for /audit.
 * 7. 160+ 12-month historical assessments for /admin/reports and /admin/analytics charts.
 * 8. Real Conformance, Retention, and Disaster Recovery operational records.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

import { connectDb, disconnectDb } from '../lib/db';
import { AssessmentMessageModel, AssessmentModel } from '../modules/assessments/model';
import { audit } from '../modules/audit/service';
import { conformanceService } from '../modules/conformance/service';
import { RetentionRunModel } from '../modules/retention/model';
import { DrStatusModel } from '../modules/system/dr.model';
import { DepartmentModel, TenantModel } from '../modules/tenants/model';
import { UserModel, type Role } from '../modules/users/model';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const DAY = 86400e3;
const now = Date.now();

function rnd(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const r = rnd(20260916);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const classify = (score: number) => (score <= 25 ? 'monitor_only' : score <= 50 ? 'risk' : score <= 75 ? 'elevated_risk' : 'issue');

type Fact = { key: string; value: unknown; source: 'mcq' | 'ai' | 'system'; confidence: number; flagged: boolean; questionKey?: string; evidence?: string };

const STORIES = [
  {
    personaKey: 'finance_officer',
    scenarioKey: 'fin_unauthorized_transaction',
    sector: 'financial',
    opening: 'An unauthorized payment run of $320,000 was initiated from the secondary treasury account to an overseas supplier without executive dual-authorization.',
    turns: [
      { q: 'fin_q01_process', text: 'Which financial process or business activity was affected?', a: 'Vendor accounts payable and batch treasury release.', fact: { key: 'affected_process', value: 'accounts payable', source: 'ai' as const, confidence: 0.94 } },
      { q: 'fin_q02_funds', text: 'Does this incident involve customer funds, company funds, or both?', a: 'Company funds', fact: { key: 'funds_type', value: 'company', source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q03_amount', text: 'Approximately how much money is involved in this incident (USD)?', a: '320000', fact: { key: 'amount_usd', value: 320000, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q04_authorized', text: 'Was the transaction authorized according to company procedures?', a: 'No', fact: { key: 'authorized', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q05_approvals', text: 'Were all required approvals obtained before the transaction?', a: 'No', fact: { key: 'approvals_obtained', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q18_unauthorized_tx', text: 'Was a transaction executed without authorization?', a: 'Yes', fact: { key: 'unauthorized_transaction', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q10_controls_bypassed', text: 'Were any internal controls bypassed, overridden, or found to be ineffective?', a: 'Yes', fact: { key: 'controls_bypassed', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q13_loss_liability', text: 'Could this incident result in financial loss or legal liability for the organization?', a: 'Yes', fact: { key: 'loss_or_liability', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_status', text: 'Is the incident still active, or has it been contained or resolved?', a: 'Contained', fact: { key: 'incident_status', value: 'contained', source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_similar_incident', text: 'Has a similar incident occurred previously within your department or organization?', a: 'No', fact: { key: 'similar_incident_before', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_actions', text: 'What corrective actions have already been taken?', a: 'SWIFT wire recall submitted and banking portal credentials immediately rotated.', fact: { key: 'corrective_actions', value: 'wire recall submitted', source: 'ai' as const, confidence: 0.90 } },
    ],
    score: 84,
    explanation: 'An unauthorized $320,000 corporate payment was executed bypassing dual-authorization controls. Although bank recall was initiated within 2 hours, the substantial financial exposure and direct internal control failure mandate an issue classification.',
    drivers: ['amount_usd = 320000', 'authorized = false', 'controls_bypassed = true', 'loss_or_liability = true'],
    action: 'Escalate for Formal Investigation',
  },
  {
    personaKey: 'it_support',
    scenarioKey: 'it_malware_ransomware',
    sector: 'it',
    opening: 'BlackCat/ALPHV ransomware payload detected across eight workstations in billing operations following a targeted macro-enabled invoice phishing campaign.',
    turns: [
      { q: 'it_q06_malware', text: 'What type of attack was involved?', a: 'Ransomware', fact: { key: 'attack_type', value: 'ransomware', source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q11_systems_count', text: 'How many systems or accounts were affected?', a: '8', fact: { key: 'affected_count', value: 8, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q03_privileged', text: 'Were any privileged or administrator accounts involved?', a: 'No', fact: { key: 'privileged_accounts_involved', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q00_data_exposed', text: 'Was any sensitive or confidential data exposed?', a: 'Yes', fact: { key: 'sensitive_data_exposed', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q05_controls_bypassed', text: 'Were any security controls bypassed or ineffective?', a: 'Yes', fact: { key: 'controls_bypassed', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q08_notification', text: 'Is regulatory or customer notification required?', a: 'Yes', fact: { key: 'notification_required', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q27_impact', text: 'What is the estimated financial impact (USD)?', a: '45000', fact: { key: 'amount_usd', value: 45000, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q09_containment', text: 'What containment actions were taken?', a: 'Network switch ports isolated, EDR host isolation applied, systems wiped and re-imaged from golden image.', fact: { key: 'containment_actions', value: 'EDR isolated and reimaged', source: 'ai' as const, confidence: 0.92 } },
      { q: 'gen_q_status', text: 'Is the incident still active, or has it been contained or resolved?', a: 'Contained', fact: { key: 'incident_status', value: 'contained', source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_similar_incident', text: 'Has a similar incident occurred previously within your department or organization?', a: 'Yes', fact: { key: 'similar_incident_before', value: true, source: 'mcq' as const, confidence: 1 } },
    ],
    score: 79,
    explanation: 'Ransomware deployment affected 8 endpoint devices with verified exposure of local billing spreadsheets. Rapid host-level isolation prevented lateral movement to primary databases, but repeat incident history and notification obligations keep this elevated.',
    drivers: ['attack_type = ransomware', 'sensitive_data_exposed = true', 'notification_required = true', 'similar_incident_before = true'],
    action: 'Escalate for Formal Investigation',
  },
  {
    personaKey: 'healthcare_compliance_officer',
    scenarioKey: 'hc_patient_safety_incident',
    sector: 'healthcare',
    opening: 'Pediatric patient in oncology received an incorrect infusion rate due to an uncalibrated volumetric pump; patient monitored in PICU with no adverse hemodynamic outcome.',
    turns: [
      { q: 'hc_q04_safety_compromised', text: 'Was patient safety compromised?', a: 'Yes', fact: { key: 'patient_safety_compromised', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'hc_q06_injury', text: 'Did the incident cause injury or create a risk of injury?', a: 'Yes', fact: { key: 'injury_or_risk', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'hc_q01_care_delayed', text: 'Was patient care delayed?', a: 'No', fact: { key: 'patient_care_delayed', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'hc_q05_cause', text: 'What was the primary cause of the incident?', a: 'Equipment malfunction', fact: { key: 'incident_cause', value: 'equipment_malfunction', source: 'mcq' as const, confidence: 1 } },
      { q: 'hc_q07_patients_affected', text: 'How many patients were affected?', a: '1', fact: { key: 'patients_affected', value: 1, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_regulatory_trigger', text: 'Does this incident trigger a regulatory reporting obligation?', a: 'Yes', fact: { key: 'regulatory_reporting_triggered', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_status', text: 'Is the incident still active, or has it been contained or resolved?', a: 'Resolved', fact: { key: 'incident_status', value: 'resolved', source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_similar_incident', text: 'Has a similar incident occurred previously within your department or organization?', a: 'No', fact: { key: 'similar_incident_before', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_actions', text: 'What corrective actions have already been taken?', a: 'Infusion pump quarantined for biomedical engineering inspection; lot calibration verified hospital-wide.', fact: { key: 'corrective_actions', value: 'pump quarantined', source: 'ai' as const, confidence: 0.89 } },
    ],
    score: 72,
    explanation: 'Infusion equipment calibration error created potential risk of toxicity for a pediatric patient. Immediate clinical intervention and continuous PICU monitoring prevented injury, but mandatory Safe Medical Devices Act reporting is triggered.',
    drivers: ['patient_safety_compromised = true', 'injury_or_risk = true', 'regulatory_reporting_triggered = true'],
    action: 'Manage the Risk',
  },
  {
    personaKey: 'it_support',
    scenarioKey: 'it_data_exposure',
    sector: 'it',
    opening: 'Misconfigured AWS S3 bucket permissions left an unencrypted backup containing 42,000 customer KYC document scans accessible via public internet for 18 hours.',
    turns: [
      { q: 'it_q00_data_exposed', text: 'Was any sensitive or confidential data exposed?', a: 'Yes', fact: { key: 'sensitive_data_exposed', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q11_systems_count', text: 'How many systems or accounts were affected?', a: '42000', fact: { key: 'affected_count', value: 42000, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q03_privileged', text: 'Were any privileged or administrator accounts involved?', a: 'Yes', fact: { key: 'privileged_accounts_involved', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q05_controls_bypassed', text: 'Were any security controls bypassed or ineffective?', a: 'Yes', fact: { key: 'controls_bypassed', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q08_notification', text: 'Is regulatory or customer notification required?', a: 'Yes', fact: { key: 'notification_required', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q27_impact', text: 'What is the estimated financial impact (USD)?', a: '85000', fact: { key: 'amount_usd', value: 85000, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_status', text: 'Is the incident still active, or has it been contained or resolved?', a: 'Contained', fact: { key: 'incident_status', value: 'contained', source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_actions', text: 'What corrective actions have already been taken?', a: 'S3 Block Public Access applied at organization level, CloudTrail access logs preserved for forensic audit.', fact: { key: 'corrective_actions', value: 'S3 block applied', source: 'ai' as const, confidence: 0.95 } },
    ],
    score: 88,
    explanation: 'Public S3 bucket misconfiguration exposed 42,000 high-risk PII identity documents. Involves privileged infrastructure role and triggers mandatory GDPR and state breach notification requirements.',
    drivers: ['sensitive_data_exposed = true', 'privileged_accounts_involved = true', 'notification_required = true', 'affected_count = 42000'],
    action: 'Escalate for Formal Investigation',
  },
  {
    personaKey: 'finance_officer',
    scenarioKey: 'fin_aml_kyc_gap',
    sector: 'financial',
    opening: 'Automated AML transaction monitoring flagged 14 consecutive structured cash deposits of $9,850 each across three regional branches under a single beneficial ownership group.',
    turns: [
      { q: 'fin_q01_process', text: 'Which financial process or business activity was affected?', a: 'Anti-Money Laundering transaction surveillance.', fact: { key: 'affected_process', value: 'AML surveillance', source: 'ai' as const, confidence: 0.93 } },
      { q: 'fin_q03_amount', text: 'Approximately how much money is involved in this incident (USD)?', a: '137900', fact: { key: 'amount_usd', value: 137900, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q04_authorized', text: 'Was the transaction authorized according to company procedures?', a: 'Yes', fact: { key: 'authorized', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q10_controls_bypassed', text: 'Were any internal controls bypassed, overridden, or found to be ineffective?', a: 'No', fact: { key: 'controls_bypassed', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q13_loss_liability', text: 'Could this incident result in financial loss or legal liability for the organization?', a: 'Yes', fact: { key: 'loss_or_liability', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_regulatory_trigger', text: 'Does this incident trigger a regulatory reporting obligation?', a: 'Yes', fact: { key: 'regulatory_reporting_triggered', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_status', text: 'Is the incident still active, or has it been contained or resolved?', a: 'Under Investigation', fact: { key: 'incident_status', value: 'under_investigation', source: 'mcq' as const, confidence: 1 } },
    ],
    score: 68,
    explanation: 'Systematic structured deposits pattern identified directly beneath CTR threshold. Accounts frozen pending FinCEN Suspicious Activity Report (SAR) filing; potential regulatory sanction if reporting timeline missed.',
    drivers: ['amount_usd = 137900', 'regulatory_reporting_triggered = true', 'loss_or_liability = true'],
    action: 'Manage the Risk',
  },
  {
    personaKey: 'healthcare_compliance_officer',
    scenarioKey: 'hc_medical_record_breach',
    sector: 'healthcare',
    opening: 'A physical folder containing 85 handwritten psychiatric intake assessments was misplaced during a department relocation and found in an unsecured common storage corridor.',
    turns: [
      { q: 'hc_q04_safety_compromised', text: 'Was patient safety compromised?', a: 'No', fact: { key: 'patient_safety_compromised', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'hc_q06_injury', text: 'Did the incident cause injury or create a risk of injury?', a: 'No', fact: { key: 'injury_or_risk', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'hc_q07_patients_affected', text: 'How many patients were affected?', a: '85', fact: { key: 'patients_affected', value: 85, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_regulatory_trigger', text: 'Does this incident trigger a regulatory reporting obligation?', a: 'Yes', fact: { key: 'regulatory_reporting_triggered', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_status', text: 'Is the incident still active, or has it been contained or resolved?', a: 'Contained', fact: { key: 'incident_status', value: 'contained', source: 'mcq' as const, confidence: 1 } },
    ],
    score: 55,
    explanation: 'Physical breach of highly sensitive psychiatric records. CCTV confirms folder was undisturbed for 4 hours prior to discovery by facilities supervisor, but HIPAA breach risk assessment is required.',
    drivers: ['patients_affected = 85', 'regulatory_reporting_triggered = true'],
    action: 'Manage the Risk',
  },
  {
    personaKey: 'it_support',
    scenarioKey: 'it_unauthorized_access',
    sector: 'it',
    opening: 'Brute-force password spray attack successfully compromised a legacy staging VPN gateway account lacking multi-factor authentication enforcement.',
    turns: [
      { q: 'it_q03_privileged', text: 'Were any privileged or administrator accounts involved?', a: 'No', fact: { key: 'privileged_accounts_involved', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q00_data_exposed', text: 'Was any sensitive or confidential data exposed?', a: 'No', fact: { key: 'sensitive_data_exposed', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q05_controls_bypassed', text: 'Were any security controls bypassed or ineffective?', a: 'Yes', fact: { key: 'controls_bypassed', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'it_q08_notification', text: 'Is regulatory or customer notification required?', a: 'No', fact: { key: 'notification_required', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_status', text: 'Is the incident still active, or has it been contained or resolved?', a: 'Resolved', fact: { key: 'incident_status', value: 'resolved', source: 'mcq' as const, confidence: 1 } },
    ],
    score: 42,
    explanation: 'VPN access compromise on isolated development environment. Attacker session terminated within 8 minutes of SIEM anomalous geo-login alert; zero access to customer data or internal production networks.',
    drivers: ['controls_bypassed = true', 'sensitive_data_exposed = false'],
    action: 'Monitor Only',
  },
  {
    personaKey: 'finance_officer',
    scenarioKey: 'fin_control_bypass',
    sector: 'financial',
    opening: 'Quarterly financial report drafts sent via unencrypted personal email by an external consultant working on preliminary tax consolidation.',
    turns: [
      { q: 'fin_q01_process', text: 'Which financial process or business activity was affected?', a: 'Tax reporting and audit consolidation.', fact: { key: 'affected_process', value: 'tax reporting', source: 'ai' as const, confidence: 0.91 } },
      { q: 'fin_q10_controls_bypassed', text: 'Were any internal controls bypassed, overridden, or found to be ineffective?', a: 'Yes', fact: { key: 'controls_bypassed', value: true, source: 'mcq' as const, confidence: 1 } },
      { q: 'fin_q13_loss_liability', text: 'Could this incident result in financial loss or legal liability for the organization?', a: 'No', fact: { key: 'loss_or_liability', value: false, source: 'mcq' as const, confidence: 1 } },
      { q: 'gen_q_status', text: 'Is the incident still active, or has it been contained or resolved?', a: 'Resolved', fact: { key: 'incident_status', value: 'resolved', source: 'mcq' as const, confidence: 1 } },
    ],
    score: 22,
    explanation: 'Consultant used non-corporate email channel in technical breach of DLP policy. No non-public material information exposed to third parties; consultant confirmed deletion and signed NDA compliance attestation.',
    drivers: ['controls_bypassed = true', 'loss_or_liability = false'],
    action: 'Monitor Only',
  },
] as const;

type Story = (typeof STORIES)[number];

interface BuildAssessmentInput {
  tenant: { _id: mongoose.Types.ObjectId; slug: string; plan: string; features: { fullAudit?: boolean } };
  requestorId: mongoose.Types.ObjectId;
  departmentId?: mongoose.Types.ObjectId;
  story: Story;
  startedAt: Date;
  state: 'in_progress' | 'intake_complete' | 'awaiting_decision' | 'error_review' | 'escalated' | 'accepted' | 'overridden';
  lowConfidence?: boolean;
  escalateToUserId?: mongoose.Types.ObjectId;
  deciderId?: mongoose.Types.ObjectId;
  overrideReason?: string;
  withAudit: boolean;
}

const payload = (full: boolean, a: Record<string, unknown>, b: Record<string, unknown>) => (full ? a : b);

async function buildAssessment(input: BuildAssessmentInput) {
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

  const intakeCompletedAt = new Date(startedAt.getTime() + (240 + Math.floor(r() * 400)) * 1000);
  const submittedAt = new Date(intakeCompletedAt.getTime() + 15_000);
  const scored = state !== 'in_progress' && state !== 'intake_complete';
  const score = state === 'error_review' ? 0 : story.score;
  const computed = classify(score);
  const confidence = input.lowConfidence ? 34 : Math.round(72 + r() * 24);
  const decidedAt = new Date(submittedAt.getTime() + (900 + Math.floor(r() * 2 * 86400)) * 1000);
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
            nextSteps: ['Notify Incident Commander', 'Preserve Forensic Evidence', 'Update Risk Register'],
            factors: { impact: { value: 4, weight: 25, contribution: 20, matchedMapping: 0 }, severity: { value: 4, weight: 25, contribution: 20, matchedMapping: 0 } },
            computedAt: submittedAt,
          },
        }
      : {}),
    ...(state === 'escalated'
      ? { decision: { type: 'escalate', byUserId: input.requestorId, reason: 'Escalated to Enterprise Risk Committee for emergency review.', decidedAt }, escalatedToUserId: input.escalateToUserId }
      : closed
        ? {
            decision: {
              type: state === 'overridden' ? 'override' : 'accept',
              byUserId: input.deciderId ?? input.requestorId,
              overriddenTo,
              reason: state === 'overridden'
                ? (input.overrideReason ?? 'Overridden by Administrator: High-value intellectual property was on the target server; elevated risk warranted.')
                : undefined,
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

  const msgs: Record<string, unknown>[] = [
    { role: 'user', kind: 'answer', content: story.opening },
    { role: 'assistant', kind: 'info', content: `Scenario: ${story.scenarioKey.replace(/_/g, ' ')}` },
  ];
  for (const t of turns) {
    msgs.push({ role: 'assistant', kind: 'question', content: t.text, questionKey: t.q });
    msgs.push({ role: 'user', kind: 'answer', content: String(t.a), questionKey: t.q });
  }
  if (scored) msgs.push({ role: 'assistant', kind: 'result', content: story.explanation });
  if (state === 'escalated') msgs.push({ role: 'user', kind: 'decision', content: 'Escalated to Enterprise Risk Committee' });
  if (closed) msgs.push({ role: 'user', kind: 'decision', content: state === 'overridden' ? `Overridden to ${overriddenTo}` : 'Accepted the recommendation' });
  await AssessmentMessageModel.create(msgs.map((m) => ({ ...m, tenantId: tenant._id, assessmentId: doc._id })));

  if (!input.withAudit) return doc;

  const tid = String(tenant._id);
  const actor = { id: String(input.requestorId), role: 'requestor' };
  const entity = { type: 'assessment', id: String(doc._id) };
  await audit.write({ tenantId: tid, category: 'assessment', action: 'assessment.started', actor, entity, payload: payload(full, { personaKey: story.personaKey, personaSource: 'ai', openingText: story.opening }, { personaKey: story.personaKey }) });
  await audit.write({ tenantId: tid, category: 'assessment', action: 'assessment.scenario_selected', actor, entity, payload: { scenarioKey: story.scenarioKey, source: 'ai', confidence: 0.88, versions: { promptVersion: 'v1' } } });
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
      actor: { id: String(input.deciderId ?? input.requestorId), role: state === 'overridden' ? 'administrator' : 'requestor' },
      entity,
      payload: {
        type: state === 'overridden' ? 'override' : state === 'escalated' ? 'escalate' : 'accept',
        overriddenTo: overriddenTo ?? null,
        escalatedToUserId: input.escalateToUserId ? String(input.escalateToUserId) : null,
        aiClassification: computed,
        ...(full ? { reason: state === 'overridden' ? (input.overrideReason ?? 'Overridden by Administrator.') : 'Accepted recommendation.' } : {}),
      },
    });
  }
  return doc;
}

async function buildHistory(tenantId: mongoose.Types.ObjectId, requestorIds: mongoose.Types.ObjectId[], departmentIds: mongoose.Types.ObjectId[], count: number) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const story = pick(STORIES);
    const ageDays = 7 + Math.floor(350 * r() ** 1.2);
    const startedAt = new Date(now - ageDays * DAY - Math.floor(r() * DAY));
    if ([0, 6].includes(startedAt.getUTCDay()) && r() < 0.6) continue;
    const score = Math.min(100, Math.max(10, Math.round(story.score + (r() + r() - 1) * 35)));
    const cls = classify(score);
    const confidence = Math.round(35 + r() * 60);
    const roll = r();
    const status = confidence < 40 ? 'awaiting_decision' : roll < 0.06 ? 'escalated' : roll < 0.12 ? 'awaiting_decision' : 'closed';
    const overridden = status === 'closed' && r() < 0.18;
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
        score,
        classification: cls,
        computedClassification: cls,
        ruleDriven: r() < 0.05,
        confidence,
        professionalConsult: confidence < 60,
        mandatoryReview: confidence < 40,
        explanation: story.explanation,
        keyDrivers: [...story.drivers],
        recommendedAction: story.action,
        nextSteps: ['Risk Register Updated', 'Controls Reviewed'],
        factors: { impact: { value: 3, weight: 25, contribution: 15, matchedMapping: 0 } },
        computedAt: submittedAt,
      },
      ...(status === 'closed'
        ? { decision: { type: overridden ? 'override' : 'accept', byUserId: requestorId, overriddenTo: overridden ? (cls === 'issue' ? 'elevated_risk' : 'issue') : undefined, reason: overridden ? 'Adjusted classification after senior leadership review.' : undefined, decidedAt: closedAt } }
        : status === 'escalated'
          ? { decision: { type: 'escalate', byUserId: requestorId, reason: 'Escalated to Enterprise Risk Committee.', decidedAt: submittedAt } }
          : {}),
      timing: { startedAt, intakeCompletedAt: new Date(startedAt.getTime() + 540_000), submittedAt, ...(closedAt ? { closedAt, durationSec: Math.round((closedAt.getTime() - startedAt.getTime()) / 1000) } : {}) },
    });
  }
  if (rows.length) await AssessmentModel.insertMany(rows);
  return rows.length;
}

export async function seedMeaningfulData() {
  await connectDb();
  console.log('Connected to MongoDB Atlas.');

  const tac = await TenantModel.findOne({ slug: 'tac' });
  if (!tac) throw new Error('Tenant "tac" not found');

  // Ensure TAC has full features
  await TenantModel.updateOne(
    { _id: tac._id },
    {
      $set: {
        'features.departmentMapping': true,
        'features.reviewDashboard': true,
        'features.reports': true,
        'features.fullAudit': true,
      },
    },
  );

  console.log('1. Creating realistic departments for TAC Solutions...');
  const deptData = [
    { name: 'Information Security & Cyber Defense', personas: ['it_support'] },
    { name: 'Financial Crime & Treasury Compliance', personas: ['finance_officer'] },
    { name: 'Clinical Safety & Healthcare Privacy', personas: ['healthcare_compliance_officer'] },
    { name: 'Cloud Infrastructure & DevOps', personas: ['it_support'] },
    { name: 'Legal & Regulatory Risk', personas: ['compliance_officer', 'finance_officer'] },
  ];

  const depts: Record<string, mongoose.Types.ObjectId> = {};
  for (const d of deptData) {
    const doc = await DepartmentModel.findOneAndUpdate(
      { tenantId: tac._id, name: d.name },
      { $set: { personaIds: [] } },
      { upsert: true, new: true },
    );
    depts[d.name] = doc._id;
  }
  const allDeptIds = Object.values(depts);
  console.log(`✓ 5 Departments created/updated for TAC.`);

  // 2. Setup Firebase Admin to provision requestor@tac.local in Firebase Auth
  console.log('2. Provisioning demo requestor in Firebase Auth...');
  let firebaseAuth: ReturnType<typeof getAuth> | null = null;
  try {
    const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '', 'base64').toString('utf8'));
    const app = getApps()[0] ?? initializeApp({ credential: cert(sa), projectId: process.env.FIREBASE_PROJECT_ID });
    firebaseAuth = getAuth(app);
  } catch (err) {
    console.warn('Firebase init warning:', (err as Error).message);
  }

  let requestorFbUid = 'dev:requestor@tac.local';
  if (firebaseAuth) {
    try {
      const existing = await firebaseAuth.getUserByEmail('requestor@tac.local');
      requestorFbUid = existing.uid;
      await firebaseAuth.updateUser(existing.uid, { password: 'RiskSense2026!', emailVerified: true, displayName: 'David Kim (Demo Requestor)' });
      console.log(`✓ Updated Firebase user for requestor@tac.local: ${existing.uid}`);
    } catch (err) {
      if ((err as { code?: string }).code === 'auth/user-not-found') {
        const created = await firebaseAuth.createUser({
          email: 'requestor@tac.local',
          password: 'RiskSense2026!',
          emailVerified: true,
          displayName: 'David Kim (Demo Requestor)',
        });
        requestorFbUid = created.uid;
        console.log(`✓ Created Firebase user for requestor@tac.local: ${created.uid}`);
      }
    }
  }

  // 3. Realistic Users in TAC
  console.log('3. Provisioning rich user directory for TAC Solutions...');
  const usersToCreate = [
    { email: 'admin@dev.local', name: 'Alex Morgan', role: 'administrator' as Role, dept: depts['Information Security & Cyber Defense'], cross: true },
    { email: 'admin2@dev.local', name: 'Sarah Chen', role: 'administrator' as Role, dept: depts['Financial Crime & Treasury Compliance'], cross: true },
    { email: 'sysadmin@dev.local', name: 'Marcus Vance', role: 'system_administrator' as Role, dept: depts['Cloud Infrastructure & DevOps'], cross: true },
    { email: 'audit@dev.local', name: 'Elena Rostova', role: 'audit' as Role, dept: depts['Legal & Regulatory Risk'], cross: true },
    { email: 'requestor@tac.local', name: 'David Kim', role: 'requestor' as Role, dept: depts['Financial Crime & Treasury Compliance'], cross: false, fbUid: requestorFbUid },
    { email: 'secops@tac.local', name: 'Rachel Torres', role: 'requestor' as Role, dept: depts['Information Security & Cyber Defense'], cross: true },
    { email: 'clinical@tac.local', name: 'Dr. James Wilson', role: 'requestor' as Role, dept: depts['Clinical Safety & Healthcare Privacy'], cross: false },
    { email: 'cloud@tac.local', name: 'Priya Patel', role: 'requestor' as Role, dept: depts['Cloud Infrastructure & DevOps'], cross: false },
    { email: 'regulatory@tac.local', name: 'Michael Chang', role: 'requestor' as Role, dept: depts['Legal & Regulatory Risk'], cross: false },
    { email: 'treasury@tac.local', name: 'Emily Watson', role: 'requestor' as Role, dept: depts['Financial Crime & Treasury Compliance'], cross: false },
    { email: 'analyst@tac.local', name: 'Daniel Brooks', role: 'requestor' as Role, dept: depts['Cloud Infrastructure & DevOps'], cross: false },
    { email: 'privacy@tac.local', name: 'Sophia Martinez', role: 'requestor' as Role, dept: depts['Clinical Safety & Healthcare Privacy'], cross: false },
    { email: 'intel@tac.local', name: "Liam O'Connor", role: 'requestor' as Role, dept: depts['Information Security & Cyber Defense'], cross: false },
    { email: 'compliance@tac.local', name: 'Jessica Taylor', role: 'requestor' as Role, dept: depts['Legal & Regulatory Risk'], cross: false },
  ];

  const userDocs: Record<string, mongoose.Types.ObjectId> = {};
  for (const u of usersToCreate) {
    const doc = await UserModel.findOneAndUpdate(
      { email: u.email },
      {
        $set: {
          name: u.name,
          role: u.role,
          tenantId: tac._id,
          departmentIds: u.dept ? [u.dept] : [],
          crossDepartmentAccess: u.cross,
          status: 'active',
          ...(u.fbUid ? { firebaseUid: u.fbUid } : {}),
        },
        ...(u.fbUid ? {} : { $setOnInsert: { firebaseUid: `dev:${u.email}` } }),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    userDocs[u.email] = doc._id;
  }
  console.log(`✓ ${usersToCreate.length} users provisioned in TAC with departments and roles.`);

  // 4. Create Audit Logs for Configuration Events
  const adminId = userDocs['admin@dev.local']!;
  const sysadminId = userDocs['sysadmin@dev.local']!;

  await audit.write({
    tenantId: String(tac._id),
    category: 'config',
    action: 'tenant.departments_configured',
    actor: { id: String(sysadminId), role: 'system_administrator' },
    entity: { type: 'tenant', id: String(tac._id) },
    payload: { departmentCount: deptData.length, names: deptData.map((d) => d.name) },
  });

  await audit.write({
    tenantId: String(tac._id),
    category: 'config',
    action: 'tenant.directory_synced',
    actor: { id: String(sysadminId), role: 'system_administrator' },
    entity: { type: 'tenant', id: String(tac._id) },
    payload: { totalUsers: usersToCreate.length, active: usersToCreate.length },
  });

  // 5. Build Rich Showcase Assessments for TAC
  console.log('4. Building showcase assessments across all states in TAC...');
  const reqId = userDocs['requestor@tac.local']!;
  const secopsId = userDocs['secops@tac.local']!;
  const clinicalId = userDocs['clinical@tac.local']!;
  const treasuryId = userDocs['treasury@tac.local']!;

  const showcaseConfigs: {
    story: Story;
    state: BuildAssessmentInput['state'];
    reqId: mongoose.Types.ObjectId;
    deptId: mongoose.Types.ObjectId;
    daysAgo: number;
    lowConf?: boolean;
    deciderId?: mongoose.Types.ObjectId;
    escalateToUserId?: mongoose.Types.ObjectId;
    overrideReason?: string;
  }[] = [
    // --- REVIEW QUEUE (Awaiting Decision) ---
    { story: STORIES[0], state: 'awaiting_decision', reqId: treasuryId, deptId: depts['Financial Crime & Treasury Compliance'], daysAgo: 1 },
    { story: STORIES[1], state: 'awaiting_decision', reqId: secopsId, deptId: depts['Information Security & Cyber Defense'], daysAgo: 2 },
    { story: STORIES[3], state: 'awaiting_decision', reqId: secopsId, deptId: depts['Cloud Infrastructure & DevOps'], daysAgo: 2 },
    { story: STORIES[4], state: 'awaiting_decision', reqId: reqId, deptId: depts['Financial Crime & Treasury Compliance'], daysAgo: 3 },
    // Low confidence / Mandatory review (AI-03)
    { story: STORIES[2], state: 'awaiting_decision', reqId: clinicalId, deptId: depts['Clinical Safety & Healthcare Privacy'], daysAgo: 1, lowConf: true },
    { story: STORIES[5], state: 'awaiting_decision', reqId: clinicalId, deptId: depts['Clinical Safety & Healthcare Privacy'], daysAgo: 3, lowConf: true },
    // Professional consult needed (FR-20)
    { story: STORIES[6], state: 'awaiting_decision', reqId: secopsId, deptId: depts['Information Security & Cyber Defense'], daysAgo: 4 },

    // --- OVERRIDDEN ASSESSMENTS (decision.type: override) ---
    {
      story: STORIES[6],
      state: 'overridden',
      reqId: secopsId,
      deptId: depts['Information Security & Cyber Defense'],
      daysAgo: 5,
      deciderId: adminId,
      overrideReason: 'Overridden by Administrator: High-value intellectual property was on the target server; elevated risk warranted.',
    },
    {
      story: STORIES[5],
      state: 'overridden',
      reqId: clinicalId,
      deptId: depts['Clinical Safety & Healthcare Privacy'],
      daysAgo: 7,
      deciderId: adminId,
      overrideReason: 'Overridden by Compliance: Regulatory reporting to OCR/HHS is mandatory within 60 days under HIPAA rules.',
    },
    {
      story: STORIES[7],
      state: 'overridden',
      reqId: treasuryId,
      deptId: depts['Financial Crime & Treasury Compliance'],
      daysAgo: 8,
      deciderId: userDocs['admin2@dev.local']!,
      overrideReason: 'Overridden: Recurring policy violation by external consultant requires heightened monitoring status.',
    },

    // --- ESCALATED ASSESSMENTS (decision.type: escalate) ---
    { story: STORIES[0], state: 'escalated', reqId: reqId, deptId: depts['Financial Crime & Treasury Compliance'], daysAgo: 4, escalateToUserId: adminId },
    { story: STORIES[1], state: 'escalated', reqId: secopsId, deptId: depts['Information Security & Cyber Defense'], daysAgo: 6, escalateToUserId: userDocs['admin2@dev.local']! },
    { story: STORIES[3], state: 'escalated', reqId: secopsId, deptId: depts['Cloud Infrastructure & DevOps'], daysAgo: 9, escalateToUserId: adminId },

    // --- ACCEPTED & CLOSED ASSESSMENTS ---
    { story: STORIES[0], state: 'accepted', reqId: treasuryId, deptId: depts['Financial Crime & Treasury Compliance'], daysAgo: 10, deciderId: adminId },
    { story: STORIES[1], state: 'accepted', reqId: secopsId, deptId: depts['Information Security & Cyber Defense'], daysAgo: 12, deciderId: adminId },
    { story: STORIES[2], state: 'accepted', reqId: clinicalId, deptId: depts['Clinical Safety & Healthcare Privacy'], daysAgo: 14, deciderId: userDocs['admin2@dev.local']! },
    { story: STORIES[3], state: 'accepted', reqId: secopsId, deptId: depts['Cloud Infrastructure & DevOps'], daysAgo: 16, deciderId: adminId },
    { story: STORIES[4], state: 'accepted', reqId: reqId, deptId: depts['Financial Crime & Treasury Compliance'], daysAgo: 18, deciderId: reqId },
    { story: STORIES[5], state: 'accepted', reqId: clinicalId, deptId: depts['Clinical Safety & Healthcare Privacy'], daysAgo: 20, deciderId: clinicalId },
    { story: STORIES[6], state: 'accepted', reqId: secopsId, deptId: depts['Information Security & Cyber Defense'], daysAgo: 22, deciderId: reqId },
    { story: STORIES[7], state: 'accepted', reqId: treasuryId, deptId: depts['Financial Crime & Treasury Compliance'], daysAgo: 25, deciderId: treasuryId },

    // --- IN PROGRESS & INTAKE COMPLETE ---
    { story: STORIES[0], state: 'in_progress', reqId: reqId, deptId: depts['Financial Crime & Treasury Compliance'], daysAgo: 0 },
    { story: STORIES[1], state: 'in_progress', reqId: secopsId, deptId: depts['Information Security & Cyber Defense'], daysAgo: 0 },
    { story: STORIES[2], state: 'intake_complete', reqId: clinicalId, deptId: depts['Clinical Safety & Healthcare Privacy'], daysAgo: 1 },
  ];

  let showcaseCount = 0;
  for (const cfg of showcaseConfigs) {
    await buildAssessment({
      tenant: tac as never,
      requestorId: cfg.reqId,
      departmentId: cfg.deptId,
      story: cfg.story,
      startedAt: new Date(now - cfg.daysAgo * DAY),
      state: cfg.state,
      lowConfidence: cfg.lowConf,
      deciderId: cfg.deciderId,
      escalateToUserId: cfg.escalateToUserId,
      overrideReason: cfg.overrideReason,
      withAudit: true,
    });
    showcaseCount++;
  }
  console.log(`✓ ${showcaseCount} detailed showcase assessments created with cryptographic audit chain.`);

  // 6. Build 12-Month Historical Distribution for TAC Reports & Analytics
  console.log('5. Generating 12-month analytics history (160+ assessments across all departments)...');
  const allRequestorIds = [reqId, secopsId, clinicalId, treasuryId, userDocs['regulatory@tac.local']!, userDocs['cloud@tac.local']!];
  const historyCount = await buildHistory(tac._id, allRequestorIds, allDeptIds, 160);
  console.log(`✓ ${historyCount} historical assessments generated for 12-month analytics.`);

  // 7. Record System Operational Records (DR, Retention, Conformance)
  console.log('6. Updating DR, Retention, and Conformance operational state...');
  await DrStatusModel.updateOne(
    { tenantId: tac._id },
    {
      $set: {
        provider: 'MongoDB Atlas Cloud Backup (Automated Continuous)',
        backupsEnabled: true,
        lastBackupAt: new Date(now - 2 * 3600e3),
        lastRestoreDrillAt: new Date(now - 28 * DAY),
        lastRestoreDrillOutcome: 'passed',
        evidenceRef: 'docs/ai/DRRunbook.md#drill-log-q3',
        recordedBy: sysadminId,
      },
    },
    { upsert: true },
  );

  await RetentionRunModel.create([
    {
      tenantId: tac._id,
      dryRun: false,
      trigger: 'scheduler',
      enforced: true,
      stats: { candidateAssessments: 14, archivedAssessments: 0, retainedAssessments: 182, auditEntriesChecked: 450, chainValid: true },
      createdAt: new Date(now - 1 * DAY),
    },
    {
      tenantId: tac._id,
      dryRun: true,
      trigger: 'manual',
      enforced: false,
      stats: { candidateAssessments: 14, archivedAssessments: 0, retainedAssessments: 182, auditEntriesChecked: 420, chainValid: true },
      createdAt: new Date(now - 7 * DAY),
    },
  ]);

  await conformanceService.scan({ trigger: 'scheduler', actor: null });

  console.log('=====================================================');
  console.log('SUCCESS: TAC Solutions data population complete!');
  console.log(`- Departments:  ${deptData.length}`);
  console.log(`- Users:        ${usersToCreate.length}`);
  console.log(`- Showcase:     ${showcaseCount}`);
  console.log(`- History:      ${historyCount}`);
  console.log(`- Total ASMTS:  ${await AssessmentModel.countDocuments({ tenantId: tac._id })}`);
  console.log(`- Audit Logs:   ${await (await import('../modules/audit/model')).AuditLogModel.countDocuments({ tenantId: String(tac._id) })}`);
  console.log('=====================================================');

  await disconnectDb();
}

if (require.main === module) {
  seedMeaningfulData().catch((err) => {
    console.error('Population script failed:', err);
    process.exit(1);
  });
}
