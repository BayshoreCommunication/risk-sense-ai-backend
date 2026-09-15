import { Types } from 'mongoose';
import { withMongoTransaction } from '../../lib/db';
import { AppError, notFound } from '../../lib/errors';
import type { AuthUser } from '../../middleware/auth';
import { audit } from '../audit/service';
import { PersonaModel } from '../personas/model';
import { personasService } from '../personas/service';
import { QuestionModel } from '../questions/model';
import { questionsService } from '../questions/service';
import { ScenarioModel } from '../scenarios/model';
import { scenariosService } from '../scenarios/service';
import { rulesService } from '../rules/service';
import { RuleModel } from '../rules/model';
import { scoringService } from '../scoring/service';
import { ScoringMatrixModel } from '../scoring/model';
import { DatasetModel } from './model';
import { parseUpload, type ParsedContent, type RowError } from './parse';
import { TEMPLATE_VERSION } from './template';

async function load(tenantId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound('dataset');
  const doc = await DatasetModel.findOne({ _id: id, tenantId });
  if (!doc) throw notFound('dataset');
  return doc;
}

/**
 * Cross-reference checks that need the database: keys may be satisfied by rows in the same file
 * OR by content already current in the tenant. Mirrors what scenario activation will enforce, so a
 * validated dataset activates without surprises (FR-12, FR-03, FR-07).
 */
async function crossValidate(tenantId: string, parsed: ParsedContent): Promise<RowError[]> {
  const errors: RowError[] = [];
  const filePersonas = new Set(parsed.personas.map((p) => p.body.key));
  const fileScenarios = new Set(parsed.scenarios.map((s) => s.body.key));
  const fileQuestions = new Map(parsed.questions.map((q) => [q.body.key, q.body]));

  const [dbPersonas, dbQuestions, dbScenarios] = await Promise.all([
    PersonaModel.find({ tenantId, isCurrent: true, status: 'active' }).select('key').lean(),
    QuestionModel.find({ tenantId, status: 'active' }).select('key factKey branchTrigger').lean(),
    ScenarioModel.find({ tenantId, isCurrent: true, status: 'active' }).select('key').lean(),
  ]);
  const personaKnown = (k: string) => filePersonas.has(k) || dbPersonas.some((p) => p.key === k);
  const scenarioKnown = (k: string) => fileScenarios.has(k) || dbScenarios.some((s) => s.key === k);
  const questionInfo = (k: string) => {
    const f = fileQuestions.get(k);
    if (f) return { factKey: f.factKey, branchKeys: f.branchTrigger?.questionKeys ?? [] };
    const d = dbQuestions.find((q) => q.key === k);
    return d ? { factKey: d.factKey, branchKeys: d.branchTrigger?.questionKeys ?? [] } : null;
  };

  for (const p of parsed.personas) {
    if (p.body.defaultScenarioKey && !scenarioKnown(p.body.defaultScenarioKey)) {
      errors.push({ sheet: 'personas', row: p.row, column: 'default_scenario_key', message: `scenario "${p.body.defaultScenarioKey}" not in file or database` });
    }
  }
  for (const q of parsed.questions) {
    for (const pk of q.body.tags.personaKeys) if (!personaKnown(pk)) errors.push({ sheet: 'questions', row: q.row, column: 'persona_keys', message: `persona "${pk}" not in file or database` });
    for (const sk of q.body.tags.scenarioKeys) if (!scenarioKnown(sk)) errors.push({ sheet: 'questions', row: q.row, column: 'scenario_keys', message: `scenario "${sk}" not in file or database` });
    for (const bk of q.body.branchTrigger?.questionKeys ?? []) if (!questionInfo(bk)) errors.push({ sheet: 'questions', row: q.row, column: 'branch_question_keys', message: `question "${bk}" not in file or database` });
  }
  for (const s of parsed.scenarios) {
    if (!personaKnown(s.body.personaKey)) errors.push({ sheet: 'scenarios', row: s.row, column: 'persona_key', message: `persona "${s.body.personaKey}" not in file or database` });
    if (s.body.conversationFlow.length === 0) errors.push({ sheet: 'scenarios', row: s.row, column: 'conversation_flow', message: 'at least one question is required (FR-12)' });
    // Reachable questions: flow + transitive branches.
    const reachable = new Set<string>();
    const produced = new Set<string>();
    let frontier = s.body.conversationFlow.map((n) => n.questionKey);
    while (frontier.length) {
      const next: string[] = [];
      for (const k of frontier) {
        if (reachable.has(k)) continue;
        const info = questionInfo(k);
        if (!info) {
          errors.push({ sheet: 'scenarios', row: s.row, column: 'conversation_flow', message: `question "${k}" not in file or database` });
          continue;
        }
        reachable.add(k);
        produced.add(info.factKey);
        next.push(...info.branchKeys);
      }
      frontier = next;
    }
    for (const f of s.body.requiredFactKeys) {
      if (!produced.has(f)) errors.push({ sheet: 'scenarios', row: s.row, column: 'required_fact_keys', message: `no reachable question produces fact "${f}" (FR-03)` });
    }
  }
  if (parsed.scoring.length) {
    const rows = parsed.scoring.map((r) => r.raw);
    const m = scoringService.parseSheet(rows);
    m.errors.forEach((msg) => errors.push({ sheet: 'scoring', row: 0, column: 'mapping', message: msg }));
    const first = rows.find((r) => r.hard_rules?.trim());
    if (first) rulesService.parseSheetRules(first.hard_rules!).errors.forEach((msg) => errors.push({ sheet: 'scoring', row: 0, column: 'hard_rules', message: msg }));
  }
  return errors;
}

export const datasetsService = {
  list(tenantId: string) {
    return DatasetModel.find({ tenantId }).sort({ seq: -1 }).select('-content').lean();
  },

  async get(tenantId: string, id: string) {
    return load(tenantId, id);
  },

  /** Parse + validate + store. Status `validated` (ready for review) or `rejected` (row errors). Never applies anything. */
  async upload(tenantId: string, input: { fileName: string; buffer?: Buffer; json?: unknown }, actor: AuthUser) {
    const parsed = await parseUpload(input);
    const errors = [...parsed.errors, ...(parsed.errors.length ? [] : await crossValidate(tenantId, parsed))];
    const last = await DatasetModel.findOne({ tenantId }).sort({ seq: -1 }).select('seq').lean();
    const { errors: _e, ...content } = parsed;
    const doc = await DatasetModel.create({
      tenantId,
      seq: (last?.seq ?? 0) + 1,
      fileName: input.fileName,
      format: input.buffer ? 'xlsx' : 'json',
      templateVersion: TEMPLATE_VERSION,
      status: errors.length ? 'rejected' : 'validated',
      counts: {
        personas: parsed.personas.length,
        scenarios: parsed.scenarios.length,
        questions: parsed.questions.length,
        scoring: parsed.scoring.length,
        skippedRows: parsed.skippedRows,
      },
      validationErrors: errors,
      content,
      authorId: actor.id,
    });
    await audit.write({
      tenantId,
      category: 'dataset',
      action: errors.length ? 'dataset.rejected' : 'dataset.uploaded',
      actor,
      entity: { type: 'dataset', id: String(doc._id), version: doc.seq },
      payload: { fileName: input.fileName, counts: doc.counts, errorCount: errors.length },
    });
    return doc;
  },

  /** Four-eyes: the reviewer must not be the author (AI-06). */
  async approve(tenantId: string, id: string, reviewer: AuthUser) {
    const doc = await load(tenantId, id);
    if (doc.status !== 'validated') throw new AppError('CONFLICT', `dataset is ${doc.status}; only validated datasets can be approved`);
    if (String(doc.authorId) === reviewer.id) throw new AppError('SELF_APPROVAL', 'A dataset must be approved by an administrator other than its author (AI-06)');
    doc.status = 'approved';
    doc.reviewerId = new Types.ObjectId(reviewer.id);
    doc.approvedAt = new Date();
    await doc.save();
    await audit.write({ tenantId, category: 'dataset', action: 'dataset.approved', actor: reviewer, entity: { type: 'dataset', id, version: doc.seq }, payload: { authorId: String(doc.authorId) } });
    return doc;
  },

  /** Applies all reviewed content and its audit trail in one MongoDB transaction (FR-13). */
  async activate(tenantId: string, id: string, actor: AuthUser) {
    const doc = await load(tenantId, id);
    if (doc.status !== 'approved') throw new AppError('NOT_APPROVED', `dataset is ${doc.status}; approve it first (AI-06)`);
    try {
      return await withMongoTransaction(async () => {
        // Re-read under the transaction snapshot so a concurrent activation cannot apply the same dataset twice.
        const txDoc = await load(tenantId, id);
        if (txDoc.status !== 'approved') throw new AppError('NOT_APPROVED', `dataset is ${txDoc.status}; approve it first (AI-06)`);
        const content = txDoc.content as ParsedContent;
        const applied = emptyApplied();

        for (const p of content.personas) {
          const current = await PersonaModel.findOne({ tenantId, key: p.body.key, isCurrent: true }).lean();
          const target = current ? await personasService.update(tenantId, String(current._id), p.body, actor) : await personasService.create(tenantId, p.body, actor);
          await personasService.activate(tenantId, String(target._id), actor);
          applied.personas.push(p.body.key);
        }
        for (const q of content.questions) {
          const existing = await QuestionModel.findOne({ tenantId, key: q.body.key }).lean();
          if (existing) {
            if (existing.status === 'retired') await QuestionModel.updateOne({ _id: existing._id }, { $set: { status: 'active', retiredAt: null } });
            const { key: _k, ...patch } = q.body;
            await questionsService.update(tenantId, String(existing._id), patch, actor);
          } else {
            await questionsService.create(tenantId, q.body, actor);
          }
          applied.questions.push(q.body.key);
        }
        for (const s of content.scenarios) {
          const current = await ScenarioModel.findOne({ tenantId, key: s.body.key, isCurrent: true }).lean();
          const { key: _k, ...patch } = s.body;
          const target = current ? await scenariosService.update(tenantId, String(current._id), patch, actor) : await scenariosService.create(tenantId, s.body, actor);
          await scenariosService.activate(tenantId, String(target._id), actor);
          applied.scenarios.push(s.body.key);
        }
        // Scoring sheet → matrix + hard rules. The dataset reviewer is the approval record (AI-05, AI-06).
        if (content.scoring.length && txDoc.reviewerId) {
          const reviewer: AuthUser = { ...actor, id: String(txDoc.reviewerId), role: 'administrator' };
          const rows = content.scoring.map((r) => r.raw);
          const parsedMatrix = scoringService.parseSheet(rows);
          if (parsedMatrix.body) {
            const currentMatrix = await ScoringMatrixModel.findOne({ tenantId, key: parsedMatrix.body.key, isCurrent: true }).lean();
            const { key: _mk, ...mpatch } = parsedMatrix.body;
            const target = currentMatrix
              ? await scoringService.update(tenantId, String(currentMatrix._id), mpatch, actor)
              : await scoringService.create(tenantId, parsedMatrix.body, actor);
            // The reviewed dataset author is the maker. Activation may be performed by either admin,
            // including the reviewer, without turning that operator into the recorded content author.
            target.createdBy = txDoc.authorId;
            await target.save();
            await scoringService.approve(tenantId, String(target._id), reviewer, `dataset #${txDoc.seq}`);
            await scoringService.activate(tenantId, String(target._id), actor);
            applied.matrix = `${parsedMatrix.body.key} v${target.version}`;
          }
          const first = rows.find((r) => r.hard_rules?.trim());
          if (first) {
            for (const r of rulesService.parseSheetRules(first.hard_rules!).rules) {
              const open = await RuleModel.findOne({ tenantId, key: r.key, status: { $in: ['draft', 'approved'] } }).sort({ version: -1 }).lean();
              const current = open ?? (await RuleModel.findOne({ tenantId, key: r.key, isCurrent: true, status: 'active' }).lean());
              const { key: _rk, ...rpatch } = r;
              const target = current ? await rulesService.update(tenantId, String(current._id), rpatch, actor) : await rulesService.create(tenantId, { ...r, sectors: [] }, actor);
              target.createdBy = txDoc.authorId;
              await target.save();
              await rulesService.approve(tenantId, String(target._id), reviewer, `dataset #${txDoc.seq}`);
              await rulesService.activate(tenantId, String(target._id), actor);
              applied.rules.push(r.key);
            }
          }
        }

        txDoc.status = 'active';
        txDoc.activatedBy = new Types.ObjectId(actor.id);
        txDoc.activatedAt = new Date();
        txDoc.applied = applied;
        await txDoc.save();
        await audit.write({ tenantId, category: 'dataset', action: 'dataset.activated', actor, entity: { type: 'dataset', id, version: txDoc.seq }, payload: { applied } });
        return txDoc;
      });
    } catch (err) {
      const failure = err instanceof Error ? err.message : String(err);
      const applied = emptyApplied();
      // The content transaction has rolled back. Persist only the deterministic failure outcome afterward.
      const failed = await DatasetModel.findOneAndUpdate(
        { _id: id, tenantId, status: 'approved' },
        { $set: { status: 'failed', failure, applied } },
        { new: true },
      );
      if (failed) {
        await audit.write({ tenantId, category: 'dataset', action: 'dataset.failed', actor, entity: { type: 'dataset', id, version: failed.seq }, payload: { failure, applied } });
      }
      throw err;
    }
  },
};

function emptyApplied() {
  return {
    personas: [] as string[],
    scenarios: [] as string[],
    questions: [] as string[],
    rules: [] as string[],
    matrix: undefined as string | undefined,
  };
}
