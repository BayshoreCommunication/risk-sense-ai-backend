/**
 * Turns an uploaded XLSX/JSON into API bodies and a row-level error list (FR-13).
 * Nothing here touches the database; cross-reference checks against existing content live in service.ts.
 */
import ExcelJS from 'exceljs';
import { KEY_REGEX } from '../shared/enums';
import { PersonaBody } from '../personas/schema';
import { QuestionBody } from '../questions/schema';
import { ScenarioBody } from '../scenarios/schema';
import { SHEET_NAMES, TEMPLATE_COLUMNS, type RawContent, type RawRow, type SheetName } from './template';

export interface RowError {
  sheet: SheetName | 'file';
  row: number; // 1-based spreadsheet row (data starts at 4) or array index+1 for JSON
  column?: string;
  message: string;
}

export interface ParsedContent {
  personas: { row: number; body: PersonaBody }[];
  scenarios: { row: number; body: ScenarioBody }[];
  questions: { row: number; body: QuestionBody }[];
  scoring: { row: number; raw: RawRow }[]; // applied by T-026; validated structurally here
  errors: RowError[];
  skippedRows: number;
}

const list = (s: string | undefined) =>
  (s ?? '')
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);

const cell = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return String(v.result ?? '');
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
};

/** Coerces a spreadsheet answer value to what facts store: booleans for yes/no/true/false, numbers when numeric. */
export function coerceValue(s: string): string | number | boolean {
  const t = s.trim();
  const low = t.toLowerCase();
  if (['yes', 'true'].includes(low)) return true;
  if (['no', 'false'].includes(low)) return false;
  if (t !== '' && !Number.isNaN(Number(t))) return Number(t);
  return t;
}

/** Reads the workbook into raw string rows keyed by template column names. Rows 2–3 (description/required) are skipped by shape. */
export async function readWorkbook(buffer: Buffer): Promise<{ content: RawContent; errors: RowError[]; skippedRows: number }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    return { content: {}, errors: [{ sheet: 'file', row: 0, message: 'Not a readable .xlsx workbook' }], skippedRows: 0 };
  }
  const content: RawContent = {};
  const errors: RowError[] = [];
  let skippedRows = 0;
  for (const sheetName of SHEET_NAMES) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) {
      if (sheetName !== 'scoring') errors.push({ sheet: sheetName, row: 0, message: `sheet "${sheetName}" is missing` });
      continue;
    }
    const expected = TEMPLATE_COLUMNS[sheetName].map(([k]) => k);
    const header = (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map(cell);
    const missing = expected.filter((k) => !header.includes(k));
    if (missing.length) {
      errors.push({ sheet: sheetName, row: 1, message: `missing columns: ${missing.join(', ')}` });
      continue;
    }
    const rows: RawRow[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const values = (row.values as ExcelJS.CellValue[]).slice(1).map(cell);
      const rec: RawRow = {};
      header.forEach((h, i) => (rec[h] = values[i] ?? ''));
      const first = rec[expected[0]!] ?? '';
      // Template rows 2–3 hold the description and the required/optional legend; they are not data.
      const legend = ['required', 'optional', 'mcq only', 'factor'].includes(first.toLowerCase());
      const isData = !legend && (sheetName === 'scoring' ? /^[a-zA-Z]+$/.test(first) : KEY_REGEX.test(first));
      if (!isData) {
        if (Object.values(rec).some((v) => v !== '')) skippedRows++; // description/required rows or junk
        return;
      }
      rows.push({ ...rec, __row: String(rowNumber) });
    });
    content[sheetName] = rows;
  }
  return { content, errors, skippedRows };
}

function rowNum(r: RawRow, index: number) {
  return r.__row ? Number(r.__row) : index + 1;
}

/** Maps template rows to API bodies, validating each with the same Zod schemas the REST endpoints use. */
export function normalize(content: RawContent, baseErrors: RowError[] = [], skippedRows = 0): ParsedContent {
  const out: ParsedContent = { personas: [], scenarios: [], questions: [], scoring: [], errors: [...baseErrors], skippedRows };
  const push = (sheet: SheetName, row: number, issues: { path: (string | number)[]; message: string }[]) =>
    issues.forEach((i) => out.errors.push({ sheet, row, column: i.path.join('.') || undefined, message: i.message }));

  (content.personas ?? []).forEach((r, i) => {
    const row = rowNum(r, i);
    const body = {
      key: r.persona_key,
      name: r.name,
      sector: r.sector,
      description: r.description,
      responsibilities: list(r.responsibilities),
      activities: list(r.activities),
      commonRisks: list(r.common_risks),
      vocabulary: list(r.vocabulary),
      policies: list(r.policies),
      detectHints: list(r.detect_hints),
      defaultScenarioKey: r.default_scenario_key || undefined,
    };
    const parsed = PersonaBody.safeParse(body);
    if (parsed.success) out.personas.push({ row, body: parsed.data });
    else push('personas', row, parsed.error.issues);
  });

  const action = (s: string | undefined) => {
    if (!s || !s.trim()) return undefined;
    const [rec, steps] = s.split('|').map((x) => x.trim());
    return { decisionRecommendation: rec ?? '', nextSteps: list(steps) };
  };
  (content.scenarios ?? []).forEach((r, i) => {
    const row = rowNum(r, i);
    const body = {
      key: r.scenario_key,
      personaKey: r.persona_key,
      name: r.name,
      description: r.description,
      businessContext: r.business_context,
      learningObjective: r.learning_objective || undefined,
      riskIndicators: list(r.risk_indicators),
      conversationFlow: list(r.conversation_flow).map((questionKey) => ({ questionKey })),
      requiredFactKeys: list(r.required_fact_keys),
      expectedClassification: r.expected_classification || undefined,
      reasoningExample: r.reasoning_example || undefined,
      recommendedActions: {
        monitor_only: action(r.action_monitor_only),
        risk: action(r.action_risk),
        elevated_risk: action(r.action_elevated_risk),
        issue: action(r.action_issue),
      },
    };
    const parsed = ScenarioBody.safeParse(body);
    if (parsed.success) out.scenarios.push({ row, body: parsed.data });
    else push('scenarios', row, parsed.error.issues);
  });

  (content.questions ?? []).forEach((r, i) => {
    const row = rowNum(r, i);
    const options = list(r.options).map((pair) => {
      const [label, value] = pair.split('=').map((x) => x.trim());
      const id = (value ?? label ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
      return { id, label: label ?? '', factValue: coerceValue(value ?? label ?? '') };
    });
    const branchKeys = list(r.branch_question_keys);
    const body = {
      key: r.question_key,
      text: r.text,
      type: r.type,
      options,
      factKey: r.fact_key,
      required: (r.required ?? 'true').trim().toLowerCase() !== 'false',
      tags: {
        personaKeys: list(r.persona_keys),
        scenarioKeys: list(r.scenario_keys),
        sectors: list(r.sectors),
        category: r.category || undefined,
      },
      branchTrigger: branchKeys.length ? { onValue: coerceValue(r.branch_on_value ?? ''), questionKeys: branchKeys } : undefined,
      scoringHint: r.scoring_hint || undefined,
    };
    const parsed = QuestionBody.safeParse(body);
    if (parsed.success) out.questions.push({ row, body: parsed.data });
    else push('questions', row, parsed.error.issues);
  });

  // Scoring: structural checks only (six factors, weights sum 100). Applied by T-026.
  const scoring = content.scoring ?? [];
  if (scoring.length) {
    const factors = scoring.map((r) => r.factor);
    const expected = ['controlEffectiveness', 'impact', 'severity', 'likelihood', 'duration', 'regulatorySensitivity'];
    const unknown = factors.filter((f) => !expected.includes(f));
    unknown.forEach((f) => out.errors.push({ sheet: 'scoring', row: 0, column: 'factor', message: `unknown factor "${f}"` }));
    const missing = expected.filter((f) => !factors.includes(f));
    if (missing.length) out.errors.push({ sheet: 'scoring', row: 0, column: 'factor', message: `missing factors: ${missing.join(', ')}` });
    const sum = scoring.reduce((a, r) => a + Number(r.weight_percent || 0), 0);
    if (Math.round(sum) !== 100) out.errors.push({ sheet: 'scoring', row: 0, column: 'weight_percent', message: `weights sum to ${sum}, expected 100` });
    scoring.forEach((r, i) => out.scoring.push({ row: rowNum(r, i), raw: r }));
  }

  // Duplicate keys inside the file.
  for (const [sheet, items] of [
    ['personas', out.personas],
    ['scenarios', out.scenarios],
    ['questions', out.questions],
  ] as const) {
    const seen = new Map<string, number>();
    for (const it of items) {
      const k = (it.body as { key: string }).key;
      if (seen.has(k)) out.errors.push({ sheet, row: it.row, column: 'key', message: `duplicate key "${k}" (first at row ${seen.get(k)})` });
      else seen.set(k, it.row);
    }
  }
  return out;
}

export async function parseUpload(input: { buffer?: Buffer; json?: unknown }): Promise<ParsedContent> {
  if (input.buffer) {
    const { content, errors, skippedRows } = await readWorkbook(input.buffer);
    return normalize(content, errors, skippedRows);
  }
  const json = (input.json ?? {}) as RawContent;
  const stringified: RawContent = {};
  for (const sheet of SHEET_NAMES) {
    const rows = json[sheet];
    if (!Array.isArray(rows)) continue;
    stringified[sheet] = rows.map((r) => Object.fromEntries(Object.entries(r as Record<string, unknown>).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])));
  }
  return normalize(stringified);
}
