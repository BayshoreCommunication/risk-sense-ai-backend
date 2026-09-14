/**
 * npm run seed:demo — twelve months of synthetic assessments for the PAID demo tenant (acme), so the
 * analytics dashboard (DASH-03), the review dashboard and the load test (T-092) have realistic data.
 * Idempotent: skips when demo rows already exist. Rows are tagged `versions.aiProvider = 'demo'`.
 * Never run against production (env guard below).
 */
import mongoose from 'mongoose';
import { connectDb } from '../lib/db';
import { env } from '../config/env';
import { AssessmentModel } from '../modules/assessments/model';
import { CLASSIFICATIONS } from '../modules/shared/enums';
import { DepartmentModel, TenantModel } from '../modules/tenants/model';
import { UserModel } from '../modules/users/model';

const DAY = 86400e3;
const PERSONAS = [
  { key: 'finance_officer', scenarios: ['unauthorized_wire', 'fin_unauthorized_transaction', 'vendor_fraud'] },
  { key: 'it_support', scenarios: ['phishing_click', 'lost_device', 'unpatched_server'] },
  { key: 'healthcare_compliance_officer', scenarios: ['hc_patient_safety_incident', 'phi_disclosure'] },
];

function rnd(seed: number) {
  // deterministic LCG so re-seeding on another machine gives the same shape
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export async function seedDemo(count = 900) {
  if (env.NODE_ENV === 'production') throw new Error('seed:demo must never run in production');
  const acme = await TenantModel.findOne({ slug: 'acme' });
  if (!acme) throw new Error('run npm run seed first');
  const existing = await AssessmentModel.countDocuments({ tenantId: acme._id, 'versions.aiProvider': 'demo' });
  if (existing > 0) return { skipped: true, existing };
  const departments = await DepartmentModel.find({ tenantId: acme._id }).lean();
  const requestors = await UserModel.find({ tenantId: acme._id, role: 'requestor' }).lean();
  if (!departments.length || !requestors.length) throw new Error('acme has no departments/requestors — run npm run seed');
  const r = rnd(42);
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < count; i++) {
    const persona = PERSONAS[Math.floor(r() * PERSONAS.length)]!;
    const scenarioKey = persona.scenarios[Math.floor(r() * persona.scenarios.length)]!;
    const requestor = requestors[Math.floor(r() * requestors.length)]!;
    const departmentId = requestor.departmentIds[0] ?? departments[Math.floor(r() * departments.length)]!._id;
    // more recent months are busier (growth) + weekday bias
    const ageDays = Math.floor(365 * r() ** 1.4);
    const startedAt = new Date(now - ageDays * DAY - r() * DAY);
    if ([0, 6].includes(startedAt.getUTCDay()) && r() < 0.7) continue;
    const score = Math.min(100, Math.max(1, Math.round(35 + (r() + r() + r() - 1.5) * 40)));
    const cls = score <= 25 ? 'monitor_only' : score <= 50 ? 'risk' : score <= 75 ? 'elevated_risk' : 'issue';
    const confidence = Math.round(55 + r() * 45);
    const ruleDriven = r() < 0.08;
    const finalCls = ruleDriven ? 'issue' : cls;
    const intakeSec = 240 + Math.round(r() * 900);
    const intakeCompletedAt = new Date(startedAt.getTime() + intakeSec * 1000);
    const submittedAt = new Date(intakeCompletedAt.getTime() + 15e3);
    const roll = r();
    const status = ageDays < 2 && roll < 0.4 ? 'in_progress' : roll < 0.08 ? 'escalated' : roll < 0.12 ? 'awaiting_decision' : 'closed';
    const decisionRoll = r();
    const overridden = status === 'closed' && decisionRoll < 0.22;
    const idx = CLASSIFICATIONS.indexOf(finalCls as never);
    const overriddenTo = overridden ? CLASSIFICATIONS[Math.max(0, Math.min(3, idx + (r() < 0.6 ? 1 : -1)))] : undefined;
    const closedAt = status === 'closed' ? new Date(submittedAt.getTime() + (600 + r() * 3 * 86400) * 1000) : undefined;
    rows.push({
      tenantId: acme._id,
      requestorId: requestor._id,
      departmentId,
      status,
      phase: status === 'in_progress' ? 'questions' : 'done',
      personaKey: persona.key,
      personaSource: r() < 0.7 ? 'ai' : 'user',
      scenarioKey,
      scenarioSource: 'ai',
      sector: persona.key === 'it_support' ? 'it' : persona.key === 'finance_officer' ? 'financial' : 'healthcare',
      versions: { promptVersion: 'v1', aiProvider: 'demo' },
      openingText: '[demo] synthetic assessment for dashboards',
      facts: [{ key: 'demo_fact', value: score, source: 'system', confidence: 1, flagged: false }],
      createdAt: startedAt,
      ...(status !== 'in_progress'
        ? { result: { score, classification: finalCls, computedClassification: cls, confidence, ruleDriven, ruleKey: ruleDriven ? 'sheet_demo_rule' : undefined, professionalConsult: confidence < 60, mandatoryReview: confidence < 40, explanation: 'Synthetic demo explanation.', keyDrivers: [], recommendedAction: confidence < 60 ? 'Further Professional Risk Guidance Needed' : 'Manage the Risk', nextSteps: [], factors: { impact: { value: 2, weight: 25, contribution: 12.5, matchedMapping: 0 } }, computedAt: submittedAt } }
        : {}),
      ...(status === 'closed'
        ? { decision: { type: overridden ? 'override' : 'accept', byUserId: requestor._id, overriddenTo, reason: overridden ? 'Demo override: reviewed with the department lead and adjusted.' : undefined, decidedAt: closedAt } }
        : status === 'escalated'
          ? { decision: { type: 'escalate', byUserId: requestor._id, decidedAt: submittedAt } }
          : {}),
      timing: { startedAt, ...(status !== 'in_progress' ? { intakeCompletedAt, submittedAt } : {}), ...(closedAt ? { closedAt, durationSec: Math.round((closedAt.getTime() - startedAt.getTime()) / 1000) } : {}) },
    });
  }
  await AssessmentModel.insertMany(rows);
  return { skipped: false, inserted: rows.length };
}

if (require.main === module) {
  connectDb()
    .then(() => seedDemo())
    .then((r) => {
      console.log(JSON.stringify(r));
      return mongoose.disconnect();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
