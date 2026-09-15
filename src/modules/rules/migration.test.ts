import mongoose, { Types, type Connection } from 'mongoose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RULE_VERSION_INDEXES } from './indexes';
import { migrateRuleVersions, planRuleBackfill, planRuleIndexes, type RuleMigrationRow } from './migration';

describe('rule version migration [AI-05, FR-16]', () => {
  const tenantId = new Types.ObjectId();
  const activeId = new Types.ObjectId();
  const draftId = new Types.ObjectId();
  let connection: Connection;

  beforeEach(async () => {
    connection = mongoose.connection.useDb('rule_migration_tooling_test', { useCache: true });
    await connection.dropDatabase();
  });

  afterAll(async () => {
    if (connection?.readyState === 1) await connection.dropDatabase();
    await mongoose.connection.removeDb('rule_migration_tooling_test');
  });

  it('plans a deterministic legacy backfill and is idempotent after projection [AI-05]', () => {
    const legacy: RuleMigrationRow[] = [
      { _id: activeId, tenantId, key: 'active-rule', status: 'active' },
      { _id: draftId, tenantId, key: 'draft-rule', status: 'draft' },
    ];

    const plan = planRuleBackfill(legacy);
    expect(plan.issues).toEqual([]);
    expect(plan.operations).toEqual([
      {
        id: String(activeId),
        tenantId: String(tenantId),
        key: 'active-rule',
        status: 'active',
        versionGroupId: String(activeId),
        version: 1,
        isCurrent: true,
      },
      {
        id: String(draftId),
        tenantId: String(tenantId),
        key: 'draft-rule',
        status: 'draft',
        versionGroupId: String(draftId),
        version: 1,
        isCurrent: false,
      },
    ]);

    const projected = plan.operations.map((operation) => ({
      _id: operation.id,
      tenantId: operation.tenantId,
      key: operation.key,
      status: operation.status,
      versionGroupId: operation.versionGroupId,
      version: operation.version,
      isCurrent: operation.isCurrent,
    }));
    expect(planRuleBackfill(projected)).toMatchObject({ alreadyVersioned: 2, operations: [], issues: [] });
  });

  it('refuses partial metadata and ambiguous logical version-one groups [AI-05]', () => {
    const partial = planRuleBackfill([
      { _id: activeId, tenantId, key: 'rule', status: 'active', version: 1 },
    ]);
    expect(partial.issues).toContain(`rule ${String(activeId)} is partially versioned; refusing to infer missing fields`);

    const duplicateV1 = planRuleBackfill([
      {
        _id: activeId,
        tenantId,
        key: 'rule',
        status: 'active',
        versionGroupId: activeId,
        version: 1,
        isCurrent: true,
      },
      {
        _id: draftId,
        tenantId,
        key: 'rule',
        status: 'approved',
        versionGroupId: draftId,
        version: 1,
        isCurrent: false,
      },
    ]);
    expect(duplicateV1.issues.some((issue) => issue.includes('multiple version-1 rule groups share'))).toBe(true);

    const missingV1 = planRuleBackfill([
      {
        _id: activeId,
        tenantId,
        key: 'rule',
        status: 'active',
        versionGroupId: draftId,
        version: 2,
        isCurrent: true,
      },
    ]);
    expect(missingV1.issues).toContain(`version group ${String(draftId)} has no version 1`);
  });

  it('only marks the exact legacy unique index as replaceable [AI-05]', () => {
    const legacy = planRuleIndexes([
      { name: '_id_', key: { _id: 1 }, unique: true },
      { name: 'tenantId_1_key_1', key: { tenantId: 1, key: 1 }, unique: true },
    ]);
    expect(legacy).toMatchObject({
      legacyIndexNames: ['tenantId_1_key_1'],
      satisfied: [],
      create: RULE_VERSION_INDEXES.map((index) => index.name).sort(),
      issues: [],
    });

    const migrated = planRuleIndexes(
      RULE_VERSION_INDEXES.map((index) => ({ name: index.name, key: index.key, ...index.options })),
    );
    expect(migrated).toMatchObject({ legacyIndexNames: [], create: [], issues: [] });
    expect(migrated.satisfied).toEqual(RULE_VERSION_INDEXES.map((index) => index.name).sort());

    const nonExactLegacy = planRuleIndexes([
      { name: 'tenantId_1_key_1', key: { tenantId: 1, key: 1 }, unique: true, sparse: true },
    ]);
    expect(nonExactLegacy.legacyIndexNames).toEqual([]);
    expect(nonExactLegacy.issues).toContain('index tenantId_1_key_1 conflicts with target tenantId_1_key_1_version_1_unique');
  });

  it('applies against an explicitly named database, verifies indexes, and reruns as a no-op [AI-05]', async () => {
    const collection = connection.db!.collection('rules');
    await collection.createIndex({ tenantId: 1, key: 1 }, { name: 'tenantId_1_key_1', unique: true });
    await collection.insertMany([
      { _id: activeId, tenantId, key: 'active-rule', status: 'active' },
      { _id: draftId, tenantId, key: 'draft-rule', status: 'draft' },
    ]);

    await expect(migrateRuleVersions({ apply: true, expectedDatabase: 'not-the-connected-db' }, connection)).rejects.toThrow(
      '--database must exactly match',
    );
    expect(await collection.countDocuments({ version: { $exists: true } })).toBe(0);

    const applied = await migrateRuleVersions({ apply: true, expectedDatabase: connection.name }, connection);
    expect(applied.ready).toBe(true);
    expect(applied.changed.backfilled).toBe(2);
    expect(applied.changed.droppedIndexes).toEqual(['tenantId_1_key_1']);
    expect(applied.changed.createdIndexes.sort()).toEqual(RULE_VERSION_INDEXES.map((index) => index.name).sort());

    const rows = await collection.find().sort({ key: 1 }).toArray();
    expect(rows).toEqual([
      expect.objectContaining({
        _id: activeId,
        key: 'active-rule',
        versionGroupId: activeId,
        version: 1,
        isCurrent: true,
      }),
      expect.objectContaining({
        _id: draftId,
        key: 'draft-rule',
        versionGroupId: draftId,
        version: 1,
        isCurrent: false,
      }),
    ]);
    const observedIndexes = await collection.indexes();
    expect(planRuleIndexes(observedIndexes)).toMatchObject({
      legacyIndexNames: [],
      create: [],
      issues: [],
      satisfied: RULE_VERSION_INDEXES.map((index) => index.name).sort(),
    });

    const rerun = await migrateRuleVersions({ apply: true, expectedDatabase: connection.name }, connection);
    expect(rerun.changed).toEqual({ backfilled: 0, droppedIndexes: [], createdIndexes: [] });
  });
});
