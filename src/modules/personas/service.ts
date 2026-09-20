import { versioned } from '../../lib/versioned';
import { withMongoTransaction } from '../../lib/db';
import type { AuthUser } from '../../middleware/auth';
import { PersonaModel } from './model';
import type { PersonaBody, PersonaListQuery } from './schema';
import type { z } from 'zod';
import { guardConfiguredSectorReferences } from '../tenants/sectors';

const v = versioned(PersonaModel, { entityType: 'persona', immutable: ['key'] });

export const personasService = {
  list(tenantId: string, q: z.infer<typeof PersonaListQuery>, isAdmin: boolean) {
    const filter: Record<string, unknown> = { tenantId };
    if (q.sector) filter.sector = q.sector;
    if (q.key) filter.key = q.key;
    const view = q.view ?? (isAdmin ? 'all' : 'current');
    if (view === 'current') {
      filter.isCurrent = true;
      filter.status = 'active';
    } else if (q.status) {
      filter.status = q.status;
    }
    return PersonaModel.find(filter).sort({ key: 1, version: -1 }).lean();
  },
  get: (tenantId: string, id: string) => v.load(tenantId, id),
  async create(tenantId: string, body: PersonaBody, actor: AuthUser) {
    return withMongoTransaction(async () => {
      await guardConfiguredSectorReferences(tenantId, [body.sector]);
      return v.createDraft(tenantId, body, actor);
    });
  },
  async update(tenantId: string, id: string, patch: Partial<PersonaBody>, actor: AuthUser) {
    return withMongoTransaction(async () => {
      const current = await v.load(tenantId, id);
      await guardConfiguredSectorReferences(tenantId, [patch.sector ?? current.sector]);
      return v.updateAsNewVersion(tenantId, id, patch, actor);
    });
  },
  activate: (tenantId: string, id: string, actor: AuthUser) => v.activate(tenantId, id, actor),
  deactivate: (tenantId: string, id: string, actor: AuthUser) => v.deactivate(tenantId, id, actor),
  history: (tenantId: string, groupId: string) => v.history(tenantId, groupId).lean(),
  /** Active persona by key (used by scenarios validation and, later, the chatbot). */
  currentByKey: (tenantId: string, key: string) => PersonaModel.findOne({ tenantId, key, isCurrent: true, status: 'active' }).lean(),
};
