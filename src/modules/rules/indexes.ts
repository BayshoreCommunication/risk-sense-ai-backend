/** Index contracts shared by the rule model and its one-time legacy migration. */
export const LEGACY_RULE_KEY_INDEX = {
  key: { tenantId: 1, key: 1 } as const,
  options: { unique: true } as const,
};

export const RULE_VERSION_INDEXES = [
  {
    // A distinct name lets the migration install this narrower constraint before removing
    // the legacy full-key unique index, so there is never an unprotected write window.
    name: 'tenantId_1_key_1_version_1_unique',
    key: { tenantId: 1, key: 1 } as const,
    options: { unique: true, partialFilterExpression: { version: 1 } } as const,
  },
  {
    name: 'tenantId_1_key_1_isCurrent_1',
    key: { tenantId: 1, key: 1, isCurrent: 1 } as const,
    options: { unique: true, partialFilterExpression: { isCurrent: true } } as const,
  },
  {
    name: 'tenantId_1_versionGroupId_1_version_1',
    key: { tenantId: 1, versionGroupId: 1, version: 1 } as const,
    options: { unique: true } as const,
  },
] as const;
