import mongoose, { Types, type Connection } from 'mongoose';
import { LEGACY_RULE_KEY_INDEX, RULE_VERSION_INDEXES } from './indexes';
import { RULE_STATUSES, type RuleStatus } from './model';

const COLLECTION = 'rules';

export interface RuleMigrationRow {
  _id: unknown;
  tenantId?: unknown;
  key?: unknown;
  status?: unknown;
  versionGroupId?: unknown;
  version?: unknown;
  isCurrent?: unknown;
}

export interface RuleBackfillOperation {
  id: string;
  tenantId: string;
  key: string;
  status: RuleStatus;
  versionGroupId: string;
  version: 1;
  isCurrent: boolean;
}

export interface RuleBackfillPlan {
  total: number;
  alreadyVersioned: number;
  operations: RuleBackfillOperation[];
  issues: string[];
}

export interface ObservedIndex {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  collation?: Record<string, unknown>;
  partialFilterExpression?: Record<string, unknown>;
}

export interface RuleIndexPlan {
  legacyIndexNames: string[];
  satisfied: string[];
  create: string[];
  issues: string[];
}

export interface RuleMigrationReport {
  database: string;
  collection: typeof COLLECTION;
  apply: boolean;
  backfill: RuleBackfillPlan;
  indexes: RuleIndexPlan;
  changed: { backfilled: number; droppedIndexes: string[]; createdIndexes: string[] };
  ready: boolean;
}

const asId = (value: unknown) => (value == null ? '' : String(value));
const hasValue = (value: unknown) => value !== undefined && value !== null;

/** Pure, deterministic preflight: never guesses when a document is only partly versioned. */
export function planRuleBackfill(rows: readonly RuleMigrationRow[]): RuleBackfillPlan {
  const operations: RuleBackfillOperation[] = [];
  const issues: string[] = [];
  let alreadyVersioned = 0;

  const projected = rows.map((row) => {
    const id = asId(row._id);
    const tenantId = asId(row.tenantId);
    const key = typeof row.key === 'string' ? row.key : '';
    const status = row.status as RuleStatus;
    if (!Types.ObjectId.isValid(id)) issues.push(`rule ${id || '(missing _id)'} has a non-ObjectId _id`);
    if (!Types.ObjectId.isValid(tenantId)) issues.push(`rule ${id || '(missing _id)'} has a missing/invalid tenantId`);
    if (!key) issues.push(`rule ${id || '(missing _id)'} has a missing/invalid key`);
    if (!RULE_STATUSES.includes(status)) issues.push(`rule ${id || '(missing _id)'} has unsupported status "${String(row.status)}"`);

    const present = [row.versionGroupId, row.version, row.isCurrent].map(hasValue);
    if (present.every((v) => !v)) {
      const op = { id, tenantId, key, status, versionGroupId: id, version: 1 as const, isCurrent: status === 'active' };
      operations.push(op);
      return op;
    }
    if (!present.every(Boolean)) {
      issues.push(`rule ${id} is partially versioned; refusing to infer missing fields`);
      return { id, tenantId, key, status, versionGroupId: asId(row.versionGroupId), version: row.version, isCurrent: row.isCurrent };
    }

    alreadyVersioned++;
    return { id, tenantId, key, status, versionGroupId: asId(row.versionGroupId), version: row.version, isCurrent: row.isCurrent };
  });

  const logicalV1 = new Map<string, string>();
  const current = new Map<string, string>();
  const groupVersion = new Map<string, string>();
  const groupIdentity = new Map<string, string>();
  const validGroups = new Map<string, string>();
  const groupsWithVersionOne = new Set<string>();
  for (const row of projected) {
    const validGroup = Types.ObjectId.isValid(row.versionGroupId);
    if (!validGroup) issues.push(`rule ${row.id} has a missing/invalid versionGroupId`);
    if (!Number.isInteger(row.version) || Number(row.version) < 1) issues.push(`rule ${row.id} has invalid version ${String(row.version)}`);
    if (typeof row.isCurrent !== 'boolean') issues.push(`rule ${row.id} has non-boolean isCurrent`);
    if (typeof row.isCurrent === 'boolean' && row.isCurrent !== (row.status === 'active')) {
      issues.push(`rule ${row.id} violates current/active semantics`);
    }

    const logicalKey = `${row.tenantId}/${row.key}`;
    if (row.version === 1) recordUnique(logicalV1, logicalKey, row.id, 'multiple version-1 rule groups share', issues);
    if (row.isCurrent === true) recordUnique(current, logicalKey, row.id, 'multiple current rules share', issues);
    recordUnique(groupVersion, `${row.tenantId}/${row.versionGroupId}/${String(row.version)}`, row.id, 'duplicate rule group/version', issues);

    const groupKey = `${row.tenantId}/${row.versionGroupId}`;
    if (validGroup) {
      validGroups.set(groupKey, row.versionGroupId);
      if (row.version === 1) groupsWithVersionOne.add(groupKey);
    }
    const identity = `${row.tenantId}/${row.key}`;
    const priorIdentity = groupIdentity.get(groupKey);
    if (priorIdentity && priorIdentity !== identity) issues.push(`version group ${row.versionGroupId} spans multiple tenant/key identities`);
    else groupIdentity.set(groupKey, identity);
  }
  for (const [groupKey, groupId] of validGroups) {
    if (!groupsWithVersionOne.has(groupKey)) issues.push(`version group ${groupId} has no version 1`);
  }

  return { total: rows.length, alreadyVersioned, operations, issues: [...new Set(issues)].sort() };
}

/** Pure index preflight. Only an exact legacy unique index is eligible to be dropped. */
export function planRuleIndexes(indexes: readonly ObservedIndex[]): RuleIndexPlan {
  const legacyIndexNames = indexes
    .filter(
      (index) =>
        sameKey(index.key, LEGACY_RULE_KEY_INDEX.key) &&
        index.unique === true &&
        index.sparse !== true &&
        !index.collation &&
        !index.partialFilterExpression,
    )
    .map((index) => index.name)
    .filter((name): name is string => Boolean(name));
  const satisfied: string[] = [];
  const create: string[] = [];
  const issues: string[] = [];

  for (const target of RULE_VERSION_INDEXES) {
    const exact = indexes.find((index) => matchesIndex(index, target));
    if (exact) {
      satisfied.push(target.name);
      continue;
    }
    const sameName = indexes.find((index) => index.name === target.name);
    if (sameName) {
      issues.push(`index ${target.name} exists with an unexpected definition`);
      continue;
    }
    const incompatibleSameKey = indexes.find(
      (index) => sameKey(index.key, target.key) && !matchesIndex(index, target) && !legacyIndexNames.includes(index.name ?? ''),
    );
    if (incompatibleSameKey) {
      issues.push(`index ${incompatibleSameKey.name ?? '(unnamed)'} conflicts with target ${target.name}`);
      continue;
    }
    create.push(target.name);
  }

  return {
    legacyIndexNames: [...new Set(legacyIndexNames)].sort(),
    satisfied: satisfied.sort(),
    create: create.sort(),
    issues: [...new Set(issues)].sort(),
  };
}

export async function inspectRuleVersionMigration(connection: Connection = mongoose.connection): Promise<RuleMigrationReport> {
  const db = connection.db;
  if (!db) throw new Error('MongoDB is not connected');
  const exists = await db.listCollections({ name: COLLECTION }, { nameOnly: true }).hasNext();
  if (!exists) throw new Error(`refusing migration: expected collection "${COLLECTION}" does not exist in database "${connection.name}"`);
  const collection = db.collection(COLLECTION);
  const [rows, indexes] = await Promise.all([
    collection
      .find({}, { projection: { _id: 1, tenantId: 1, key: 1, status: 1, versionGroupId: 1, version: 1, isCurrent: 1 } })
      .sort({ _id: 1 })
      .toArray(),
    collection.indexes() as Promise<ObservedIndex[]>,
  ]);
  const backfill = planRuleBackfill(rows as unknown as RuleMigrationRow[]);
  const indexPlan = planRuleIndexes(indexes);
  return {
    database: connection.name,
    collection: COLLECTION,
    apply: false,
    backfill,
    indexes: indexPlan,
    changed: { backfilled: 0, droppedIndexes: [], createdIndexes: [] },
    ready: backfill.issues.length === 0 && indexPlan.issues.length === 0,
  };
}

export async function migrateRuleVersions(
  options: { apply: boolean; expectedDatabase?: string },
  connection: Connection = mongoose.connection,
): Promise<RuleMigrationReport> {
  const initial = await inspectRuleVersionMigration(connection);
  if (!options.apply) return initial;
  if (!options.expectedDatabase || options.expectedDatabase !== initial.database) {
    throw new Error(`refusing migration: --database must exactly match connected database "${initial.database}"`);
  }
  assertReady(initial);
  const collection = connection.db!.collection(COLLECTION);

  if (initial.backfill.operations.length) {
    await connection.transaction(async (session) => {
      const result = await collection.bulkWrite(
        initial.backfill.operations.map((op) => ({
          updateOne: {
            filter: {
              _id: new Types.ObjectId(op.id),
              tenantId: new Types.ObjectId(op.tenantId),
              key: op.key,
              status: op.status,
              versionGroupId: { $exists: false },
              version: { $exists: false },
              isCurrent: { $exists: false },
            },
            update: { $set: { versionGroupId: new Types.ObjectId(op.versionGroupId), version: op.version, isCurrent: op.isCurrent } },
          },
        })),
        { ordered: true, session },
      );
      if (result.matchedCount !== initial.backfill.operations.length) {
        throw new Error(`rule data changed after preflight: expected ${initial.backfill.operations.length} legacy rows, matched ${result.matchedCount}`);
      }
    });
  }

  const afterBackfill = await inspectRuleVersionMigration(connection);
  assertReady(afterBackfill);
  assertNoLegacyRows(afterBackfill);

  const createdIndexes: string[] = [];
  const droppedIndexes: string[] = [];
  // Every replacement constraint gets installed before the broader legacy index is removed.
  for (const target of RULE_VERSION_INDEXES) {
    if (!afterBackfill.indexes.satisfied.includes(target.name)) {
      await collection.createIndex(target.key, { name: target.name, ...target.options });
      createdIndexes.push(target.name);
    }
  }

  const beforeDrop = await inspectRuleVersionMigration(connection);
  assertReady(beforeDrop);
  assertNoLegacyRows(beforeDrop);
  if (beforeDrop.indexes.create.length) throw new Error('rule index verification failed before legacy index removal');
  for (const name of beforeDrop.indexes.legacyIndexNames) {
    await collection.dropIndex(name);
    droppedIndexes.push(name);
  }

  const verified = await inspectRuleVersionMigration(connection);
  assertReady(verified);
  if (verified.backfill.operations.length || verified.indexes.create.length || verified.indexes.legacyIndexNames.length) {
    throw new Error('rule migration postcondition failed');
  }
  return {
    ...verified,
    apply: true,
    changed: { backfilled: initial.backfill.operations.length, droppedIndexes, createdIndexes },
  };
}

function assertReady(report: RuleMigrationReport) {
  const issues = [...report.backfill.issues, ...report.indexes.issues];
  if (issues.length) throw new Error(`rule migration preflight failed:\n- ${issues.join('\n- ')}`);
}

function assertNoLegacyRows(report: RuleMigrationReport) {
  if (report.backfill.operations.length) throw new Error('rule backfill verification failed: legacy rows remain');
}

function recordUnique(map: Map<string, string>, key: string, id: string, label: string, issues: string[]) {
  const prior = map.get(key);
  if (prior && prior !== id) issues.push(`${label} "${key}" (${prior}, ${id})`);
  else map.set(key, id);
}

function sameKey(actual: Record<string, unknown>, expected: Record<string, unknown>) {
  return JSON.stringify(Object.entries(actual)) === JSON.stringify(Object.entries(expected));
}

function matchesIndex(index: ObservedIndex, target: (typeof RULE_VERSION_INDEXES)[number]) {
  return (
    sameKey(index.key, target.key) &&
    index.unique === target.options.unique &&
    index.sparse !== true &&
    !index.collation &&
    JSON.stringify(index.partialFilterExpression ?? null) === JSON.stringify('partialFilterExpression' in target.options ? target.options.partialFilterExpression : null)
  );
}
