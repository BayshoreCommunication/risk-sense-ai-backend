import { inMongoTransaction } from '../../lib/db';
import { AppError } from '../../lib/errors';
import { TenantModel } from './model';

const requestedSectors = (sectors: readonly (string | undefined)[]) =>
  [...new Set(sectors.filter((sector): sector is string => Boolean(sector)))];

function assertMembership(configuredSectors: readonly string[], requested: readonly string[]): void {
  const configured = new Set(configuredSectors);
  const unknown = requested.filter((sector) => !configured.has(sector));
  if (unknown.length) {
    throw new AppError('VALIDATION_ERROR', `sector${unknown.length === 1 ? '' : 's'} not configured for this tenant: ${unknown.join(', ')}`);
  }
}

/** Acquire the tenant-row write used to serialize vocabulary membership and removal. */
export async function guardTenantSectorVocabulary(tenantId: string): Promise<readonly string[]> {
  if (!inMongoTransaction()) {
    throw new Error('guardTenantSectorVocabulary must run inside a Mongo transaction');
  }
  const tenant = await TenantModel.findByIdAndUpdate(
    tenantId,
    { $inc: { sectorGuardRevision: 1 } },
    { new: true, timestamps: false },
  )
    .select('sectors')
    .lean();
  if (!tenant) throw new AppError('NOT_FOUND', 'tenant');
  return tenant.sectors;
}

/**
 * Enforces the tenant-owned content vocabulary at the service boundary. Zod validates the key
 * shape; this check validates business membership so API, dataset, and future callers agree.
 */
export async function assertConfiguredSectors(tenantId: string, sectors: readonly (string | undefined)[]): Promise<void> {
  const requested = requestedSectors(sectors);
  if (requested.length === 0) return;
  const tenant = await TenantModel.findById(tenantId).select('sectors').lean();
  if (!tenant) throw new AppError('NOT_FOUND', 'tenant');
  assertMembership(tenant.sectors, requested);
}

/**
 * Serializes a sector-referencing content mutation against sector removal on the same tenant row.
 * The caller must own a transaction that also commits the content write. Mongo document write
 * conflicts then replay one complete transaction: after replay, either the new reference is visible
 * to removal or the removed key fails this membership check.
 */
export async function guardConfiguredSectorReferences(
  tenantId: string,
  sectors: readonly (string | undefined)[],
): Promise<void> {
  const requested = requestedSectors(sectors);
  if (requested.length === 0) return;
  if (!inMongoTransaction()) {
    throw new Error('guardConfiguredSectorReferences must run inside a Mongo transaction');
  }
  assertMembership(await guardTenantSectorVocabulary(tenantId), requested);
}
