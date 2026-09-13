/**
 * The content template contract (T-006, FR-13). Column names here are what the upload parser
 * (`parse.ts`) reads and what `npm run templates` writes into the XLSX handed to TAC.
 */
import ExcelJS from 'exceljs';

export const TEMPLATE_VERSION = 1;

export const TEMPLATE_COLUMNS = {
  personas: [
    ['persona_key', 'Unique key, lowercase, e.g. finance_officer', 'required'],
    ['name', 'Display name, e.g. Finance Officer', 'required'],
    ['sector', 'financial | healthcare | it | general', 'required'],
    ['description', '2–3 sentences: what this role does', 'required'],
    ['responsibilities', 'Semicolon-separated list', 'required'],
    ['activities', 'Semicolon-separated day-to-day activities', 'optional'],
    ['common_risks', 'Semicolon-separated typical risks for this role', 'required'],
    ['vocabulary', 'Semicolon-separated terms the AI should understand/use', 'optional'],
    ['policies', 'Semicolon-separated policy references', 'optional'],
    ['detect_hints', 'Semicolon-separated words/phrases that suggest this persona (FR-04)', 'required'],
    ['default_scenario_key', 'scenario_key used when no scenario matches (FR-05)', 'required'],
  ],
  scenarios: [
    ['scenario_key', 'Unique key, e.g. fin_unauthorized_wire', 'required'],
    ['persona_key', 'Must match a persona_key', 'required'],
    ['name', 'Short name shown to the user before scenario questions', 'required'],
    ['description', 'What happened, in plain words', 'required'],
    ['business_context', 'Where/when this typically occurs', 'required'],
    ['learning_objective', 'What the assessment should establish', 'optional'],
    ['risk_indicators', 'Semicolon-separated signals of higher risk', 'required'],
    ['conversation_flow', 'Ordered question_keys, semicolon-separated (branches attach via questions.branch_*)', 'required'],
    ['required_fact_keys', 'Semicolon-separated fact keys that must exist before submit (FR-03)', 'required'],
    ['expected_classification', 'monitor_only | risk | elevated_risk | issue (typical case; used for tests)', 'required'],
    ['reasoning_example', 'One paragraph as the explanation should read (AI-02)', 'required'],
    ['action_monitor_only', 'Decision Recommendation | Next steps for this class', 'required'],
    ['action_risk', 'Decision Recommendation | Next steps', 'required'],
    ['action_elevated_risk', 'Decision Recommendation | Next steps', 'required'],
    ['action_issue', 'Decision Recommendation | Next steps', 'required'],
  ],
  questions: [
    ['question_key', 'Unique key, e.g. fin_q06_fraud_suspected', 'required'],
    ['text', 'The question as the chatbot asks it', 'required'],
    ['type', 'mcq | yes_no | free_text | number', 'required'],
    ['options', 'For mcq: label=value pairs, semicolon-separated, e.g. Customer funds=customer;Company funds=company;Both=both', 'mcq only'],
    ['fact_key', 'Where the answer lands, snake_case, e.g. fraud_suspected (FR-06)', 'required'],
    ['required', 'true | false — must be answered before submit', 'required'],
    ['persona_keys', 'Semicolon-separated persona_keys this question belongs to', 'required'],
    ['scenario_keys', 'Semicolon-separated scenario_keys (empty = all scenarios of the personas)', 'optional'],
    ['sectors', 'financial;healthcare;it', 'required'],
    ['category', 'e.g. Cybersecurity, Security Controls, Risk Mitigation, Root Cause', 'optional'],
    ['branch_on_value', 'Answer value that opens follow-up questions, e.g. yes', 'optional'],
    ['branch_question_keys', 'Semicolon-separated follow-up question_keys shown when branch_on_value matches (FR-07)', 'optional'],
    ['scoring_hint', 'Free text for TAC: which factor this influences, e.g. severity +2 when yes', 'optional'],
  ],
  scoring: [
    ['factor', 'controlEffectiveness | impact | severity | likelihood | duration | regulatorySensitivity', 'required'],
    ['weight_percent', 'All six must sum to 100', 'required'],
    ['scale_min', 'e.g. 1', 'required'],
    ['scale_max', 'e.g. 5', 'required'],
    ['mapping', 'Rules turning facts into a value: fact_key op value => factor_value; semicolon-separated, first match wins. e.g. amount_usd > 100000 => 5; amount_usd > 10000 => 3', 'required'],
    ['thresholds', 'Only on first row: monitor_only 0-25; risk 26-50; elevated_risk 51-75; issue 76-100', 'required'],
    ['hard_rules', 'Only on first row: condition => classification; semicolon-separated. e.g. fraud_confirmed = yes => issue', 'required'],
    ['professional_consult_below_confidence', 'Only on first row: default 60', 'required'],
  ],
} as const;

export type SheetName = keyof typeof TEMPLATE_COLUMNS;
export const SHEET_NAMES = Object.keys(TEMPLATE_COLUMNS) as SheetName[];

export type RawRow = Record<string, string>;
export type RawContent = { version?: number } & Partial<Record<SheetName, RawRow[]>>;

export const SAMPLE: Required<Record<SheetName, RawRow[]>> = {
  personas: [
    {
      persona_key: 'finance_officer',
      name: 'Finance Officer',
      sector: 'financial',
      description: 'Approves payments, reconciles bank accounts, maintains the ledger and supports audits.',
      responsibilities: 'Vendor payments;Expense approval;Bank reconciliation;Month-end close',
      activities: 'Review invoices;Release wires;Post journal entries',
      common_risks: 'Duplicate payment;Unauthorized transfer;Invoice fraud;Control bypass',
      vocabulary: 'AP;GL;wire;dual authorization;SOX;reconciliation',
      policies: 'Payment Approval Policy v2;SOX Control Matrix',
      detect_hints: 'payment;invoice;wire;ledger;vendor;reconciliation',
      default_scenario_key: 'fin_unauthorized_transaction',
    },
  ],
  scenarios: [
    {
      scenario_key: 'fin_unauthorized_transaction',
      persona_key: 'finance_officer',
      name: 'Unauthorized or unapproved transaction',
      description: 'A payment or transfer was executed without the required approvals or outside procedure.',
      business_context: 'Accounts payable and treasury operations in a financial-services firm.',
      learning_objective: 'Establish authorization, amount, controls bypassed, containment and exposure.',
      risk_indicators: 'dual authorization skipped;amount above threshold;external beneficiary;incident still active',
      conversation_flow: 'fin_q01_process;fin_q03_amount;fin_q04_authorized;fin_q06_fraud_suspected;fin_q10_controls_bypassed;fin_q14_status;fin_q19_actions',
      required_fact_keys: 'affected_process;amount_usd;authorized;fraud_suspected;controls_bypassed;incident_status',
      expected_classification: 'elevated_risk',
      reasoning_example:
        'Dual authorization was bypassed and the amount exceeds the approval threshold, so control effectiveness is low and impact is high; the incident is contained, which limits duration.',
      action_monitor_only: 'No further action | Monitor',
      action_risk: 'Manage the Risk | Manage the Risk',
      action_elevated_risk: 'Further Professional Risk Guidance Needed | Disclose/Report Issue',
      action_issue: 'Contact Law Enforcement | Disclose/Report Issue',
    },
  ],
  questions: [
    { question_key: 'fin_q01_process', text: 'Which financial process or business activity was affected?', type: 'free_text', options: '', fact_key: 'affected_process', required: 'true', persona_keys: 'finance_officer', scenario_keys: '', sectors: 'financial', category: '', branch_on_value: '', branch_question_keys: '', scoring_hint: '' },
    { question_key: 'fin_q03_amount', text: 'Approximately how much money is involved in this incident?', type: 'number', options: '', fact_key: 'amount_usd', required: 'true', persona_keys: 'finance_officer', scenario_keys: '', sectors: 'financial', category: '', branch_on_value: '', branch_question_keys: '', scoring_hint: 'impact: >100k => 5, >10k => 3' },
    { question_key: 'fin_q04_authorized', text: 'Was the transaction authorized according to company procedures?', type: 'yes_no', options: '', fact_key: 'authorized', required: 'true', persona_keys: 'finance_officer', scenario_keys: '', sectors: 'financial', category: '', branch_on_value: '', branch_question_keys: '', scoring_hint: 'controlEffectiveness: no => 5' },
    { question_key: 'fin_q06_fraud_suspected', text: 'Does this incident involve a suspected fraudulent transaction?', type: 'yes_no', options: '', fact_key: 'fraud_suspected', required: 'true', persona_keys: 'finance_officer', scenario_keys: '', sectors: 'financial', category: '', branch_on_value: 'yes', branch_question_keys: 'fin_q06a_fraud_confirmed;fin_q06b_account_frozen;fin_q06c_team_notified;fin_q06d_exposure', scoring_hint: 'severity +2 when yes' },
    { question_key: 'fin_q06a_fraud_confirmed', text: 'Was the fraud confirmed or is it only suspected?', type: 'mcq', options: 'Confirmed=confirmed;Suspected=suspected', fact_key: 'fraud_confirmed', required: 'false', persona_keys: 'finance_officer', scenario_keys: '', sectors: 'financial', category: 'Fraud', branch_on_value: '', branch_question_keys: '', scoring_hint: 'hard rule: confirmed => issue' },
    { question_key: 'fin_q06b_account_frozen', text: 'Has the account been frozen?', type: 'yes_no', options: '', fact_key: 'account_frozen', required: 'false', persona_keys: 'finance_officer', scenario_keys: '', sectors: 'financial', category: 'Fraud', branch_on_value: '', branch_question_keys: '', scoring_hint: '' },
    { question_key: 'fin_q06c_team_notified', text: 'Has the fraud investigation team been notified?', type: 'yes_no', options: '', fact_key: 'fraud_team_notified', required: 'false', persona_keys: 'finance_officer', scenario_keys: '', sectors: 'financial', category: 'Fraud', branch_on_value: '', branch_question_keys: '', scoring_hint: '' },
    { question_key: 'fin_q06d_exposure', text: 'What is the estimated financial exposure?', type: 'number', options: '', fact_key: 'financial_exposure_usd', required: 'false', persona_keys: 'finance_officer', scenario_keys: '', sectors: 'financial', category: 'Fraud', branch_on_value: '', branch_question_keys: '', scoring_hint: 'impact' },
    { question_key: 'fin_q10_controls_bypassed', text: 'Were any internal controls bypassed, overridden, or found to be ineffective?', type: 'yes_no', options: '', fact_key: 'controls_bypassed', required: 'true', persona_keys: 'finance_officer', scenario_keys: '', sectors: 'financial', category: 'Security Controls', branch_on_value: '', branch_question_keys: '', scoring_hint: 'controlEffectiveness: yes => 5' },
    { question_key: 'fin_q14_status', text: 'Is the incident still active, or has it been contained or resolved?', type: 'mcq', options: 'Still active=active;Contained=contained;Resolved=resolved', fact_key: 'incident_status', required: 'true', persona_keys: 'finance_officer', scenario_keys: '', sectors: 'financial', category: '', branch_on_value: '', branch_question_keys: '', scoring_hint: 'duration: active => 4, contained => 2, resolved => 1' },
    { question_key: 'fin_q19_actions', text: 'What immediate corrective actions have been taken to reduce or contain the risk?', type: 'free_text', options: '', fact_key: 'corrective_actions', required: 'false', persona_keys: 'finance_officer', scenario_keys: '', sectors: 'financial', category: 'Risk Mitigation', branch_on_value: '', branch_question_keys: '', scoring_hint: '' },
  ],
  scoring: [
    { factor: 'impact', weight_percent: '25', scale_min: '1', scale_max: '5', mapping: 'amount_usd > 100000 => 5; amount_usd > 10000 => 3; amount_usd > 0 => 2', thresholds: 'monitor_only 0-25; risk 26-50; elevated_risk 51-75; issue 76-100', hard_rules: 'fraud_confirmed = confirmed => issue; records_affected > 500 => issue; patient_safety_compromised = yes => issue', professional_consult_below_confidence: '60' },
    { factor: 'likelihood', weight_percent: '20', scale_min: '1', scale_max: '5', mapping: 'similar_incident_before = yes => 4; similar_incident_before = no => 2', thresholds: '', hard_rules: '', professional_consult_below_confidence: '' },
    { factor: 'severity', weight_percent: '20', scale_min: '1', scale_max: '5', mapping: 'fraud_suspected = yes => 4; authorized = no => 3', thresholds: '', hard_rules: '', professional_consult_below_confidence: '' },
    { factor: 'controlEffectiveness', weight_percent: '15', scale_min: '1', scale_max: '5', mapping: 'controls_bypassed = yes => 5; authorized = no => 4', thresholds: '', hard_rules: '', professional_consult_below_confidence: '' },
    { factor: 'regulatorySensitivity', weight_percent: '15', scale_min: '1', scale_max: '5', mapping: 'regulatory_reporting_triggered = yes => 5; customer_data_exposed = yes => 4', thresholds: '', hard_rules: '', professional_consult_below_confidence: '' },
    { factor: 'duration', weight_percent: '5', scale_min: '1', scale_max: '5', mapping: 'incident_status = active => 4; incident_status = contained => 2; incident_status = resolved => 1', thresholds: '', hard_rules: '', professional_consult_below_confidence: '' },
  ],
};

/** Builds the XLSX handed to TAC: README + one sheet per entity (header, description, required, sample rows). */
export async function buildTemplateWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RiskSense AI';

  const readme = wb.addWorksheet('README');
  readme.columns = [{ width: 110 }];
  [
    `RiskSense AI — content template (v${TEMPLATE_VERSION})`,
    '',
    'Fill the four sheets: personas, scenarios, questions, scoring. Row 1 = column names (do not rename). Row 2 = description. Row 3 = required/optional. Data starts at row 4.',
    'Lists inside a cell are separated by semicolons ( ; ). Keys are lowercase snake_case and must be unique within their sheet.',
    'Every scenario needs at least one question in conversation_flow (FR-12). Every persona needs 15–25 scenarios for launch (FR-11); 5 per persona is enough to start development.',
    'Branch questions (FR-07): set branch_on_value + branch_question_keys on the parent question; the follow-ups are separate rows.',
    'The scoring sheet needs numbers from TAC: weights (sum 100), fact→factor mappings, thresholds, hard rules. The sample rows are illustrative, not final.',
    'Upload the finished file in the Administrator dashboard → Datasets. Rows with errors are reported per row; nothing is applied until the whole file validates (FR-13).',
    'Sample rows (Finance Officer) come from the BRD Financial Services question set — replace or extend them.',
  ].forEach((line) => readme.addRow([line]));
  readme.getRow(1).font = { bold: true, size: 14 };

  for (const sheetName of SHEET_NAMES) {
    const cols = TEMPLATE_COLUMNS[sheetName];
    const ws = wb.addWorksheet(sheetName);
    ws.columns = cols.map(([key]) => ({ key, width: Math.min(48, Math.max(18, key.length + 6)) }));
    ws.addRow(cols.map(([key]) => key));
    ws.addRow(cols.map(([, desc]) => desc));
    ws.addRow(cols.map(([, , req]) => req));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
    ws.getRow(2).font = { italic: true, color: { argb: 'FF555555' } };
    ws.getRow(2).alignment = { wrapText: true, vertical: 'top' };
    ws.getRow(3).font = { color: { argb: 'FF888888' } };
    ws.views = [{ state: 'frozen', ySplit: 3 }];
    for (const row of SAMPLE[sheetName]) ws.addRow(cols.map(([key]) => row[key] ?? ''));
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
