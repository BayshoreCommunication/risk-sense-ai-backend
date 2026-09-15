import { AppError } from '../../lib/errors';
import type { TenantPlan } from '../tenants/model';
import type { Role } from './model';

/**
 * FR-02 plan boundary: FREE is self-service requestor-only. Administrator,
 * system-administrator and audit accounts are managed PAID capabilities.
 */
export function assertRoleAllowedForPlan(plan: TenantPlan, role: Role) {
  if (plan === 'free' && role !== 'requestor') {
    throw new AppError('FEATURE_DISABLED', 'Administrator, system administrator and audit roles require a PAID tenant');
  }
}
