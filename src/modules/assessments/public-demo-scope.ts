import { createHash } from 'node:crypto';
import { AppError } from '../../lib/errors';
import type { AuthUser } from '../../middleware/auth';
import type { AccessMode } from '../auth/model';

export interface AssessmentRequestScope {
  publicDemoSandbox: boolean;
  publicDemoSessionTag?: string;
}

export const STANDARD_ASSESSMENT_REQUEST_SCOPE: AssessmentRequestScope = Object.freeze({ publicDemoSandbox: false });

/**
 * Derive a non-reversible visitor tag from the already validated application session. The raw
 * session credential is never stored on an assessment or returned to clients.
 */
export function assessmentRequestScope(
  accessMode: AccessMode | undefined,
  sessionId: string | undefined,
): AssessmentRequestScope {
  if (accessMode !== 'public_demo_sandbox') return STANDARD_ASSESSMENT_REQUEST_SCOPE;
  return {
    publicDemoSandbox: true,
    ...(sessionId
      ? { publicDemoSessionTag: createHash('sha256').update(sessionId).digest('hex') }
      : {}),
  };
}

/**
 * Mongo predicate shared by every assessment-backed sandbox view. A Requestor's fixed demo user is
 * shared by all visitors, so ordinary owner scoping is insufficient; operator roles see only
 * untagged seeded synthetic history.
 */
export function publicDemoAssessmentFilter(
  user: Pick<AuthUser, 'role'>,
  scope: AssessmentRequestScope,
): Record<string, unknown> {
  if (!scope.publicDemoSandbox) return {};
  if (user.role === 'requestor') {
    if (!scope.publicDemoSessionTag) throw new AppError('SESSION_INVALID', 'Public demo session scope is missing');
    return { publicDemoSessionTag: scope.publicDemoSessionTag };
  }
  return { publicDemoSessionTag: { $exists: false } };
}
