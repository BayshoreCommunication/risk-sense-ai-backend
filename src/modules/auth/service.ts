import { nanoid } from 'nanoid';
import { env, isProd } from '../../config/env';
import { RetryableTransactionCollisionError, isMongoDuplicateKeyFor, withMongoTransaction } from '../../lib/db';
import { AppError } from '../../lib/errors';
import type { AuthTenant, AuthUser } from '../../middleware/auth';
import { audit, sessionAuditReference } from '../audit/service';
import { UserModel } from '../users/model';
import {
  SESSION_AUTHENTICATION_METHODS,
  SessionModel,
  type SessionAuthenticationMethod,
} from './model';
import { allowedSessionAuthenticationMethods } from './policy';
import { PUBLIC_DEMO_SESSION_ABSOLUTE_MINUTES, PUBLIC_DEMO_SESSION_IDLE_MINUTES } from './public-demo';

interface Meta {
  authenticationMethod: SessionAuthenticationMethod;
  publicDemoEligible?: boolean;
  userAgent?: string;
  ip?: string;
  signInProvider?: string; // FR-03: which first factor produced this session
}

interface TouchPolicy {
  allowDevelopmentBypass: boolean;
  allowPublicDemo: boolean;
  requirePublicDemo: boolean;
}

const minutes = (n: number) => n * 60 * 1000;

function assuranceSatisfiesPolicy(
  assurance: { method?: string; mfaVerifiedAt?: Date | null } | null | undefined,
  user: AuthUser,
  tenant: AuthTenant,
  policy: TouchPolicy,
): boolean {
  if (
    !assurance?.method ||
    !SESSION_AUTHENTICATION_METHODS.includes(assurance.method as SessionAuthenticationMethod)
  ) {
    return false;
  }
  // Once the current verified identity resolves to the exact enabled public-demo allowlist,
  // no previously issued standard session may retain write access. Requiring the distinct
  // assurance here protects both touch() and active-session accounting during re-login.
  if (policy.requirePublicDemo) return policy.allowPublicDemo && assurance.method === 'public_demo';
  if (assurance.method === 'development_bypass') return policy.allowDevelopmentBypass;
  if (assurance.method === 'public_demo') return false;
  const method = assurance.method as SessionAuthenticationMethod;
  if (!allowedSessionAuthenticationMethods(user, tenant).includes(method)) return false;
  return method === 'single_factor' || Boolean(assurance.mfaVerifiedAt);
}

/** Expected policy rejection; the route records its audit only after the auth transaction rolls back. */
export class ConcurrentSessionBlockedError extends Error {
  constructor(readonly activeSessions: number) {
    super('Another session is already active for this account');
    this.name = 'ConcurrentSessionBlockedError';
  }
}

// Avoid duplicate local work; the unique active-slot index below is the cross-instance authority.
const creationTails = new Map<string, Promise<unknown>>();

async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = creationTails.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  creationTails.set(key, next);
  try {
    return await next;
  } finally {
    if (creationTails.get(key) === next) creationTails.delete(key);
  }
}

export const sessionService = {
  /**
   * Creates an app session. Enforces `maxConcurrentSessions` (SEC-02):
   * - default: supersede the oldest active session(s) so the newest login wins;
   * - tenant.features.blockConcurrentLogin (FR-04): reject the new login instead.
   */
  async create(user: AuthUser, tenant: AuthTenant, meta: Meta) {
    const assurancePolicy: TouchPolicy = {
      // The only caller that selects this discriminator is the explicit, non-production dev path.
      allowDevelopmentBypass: env.AUTH_DEV_BYPASS && !isProd,
      // This is derived from a verified bearer plus exact persisted user/tenant flags by auth middleware.
      allowPublicDemo: meta.authenticationMethod === 'public_demo' && meta.publicDemoEligible === true,
      requirePublicDemo: meta.authenticationMethod === 'public_demo',
    };
    const proposedAssurance = {
      method: meta.authenticationMethod,
      ...(['firebase_mfa', 'risk_sense_otp'].includes(meta.authenticationMethod) ? { mfaVerifiedAt: new Date() } : {}),
    };
    if (!assuranceSatisfiesPolicy(proposedAssurance, user, tenant, assurancePolicy)) {
      throw new AppError('MFA_REQUIRED', 'Authentication method does not satisfy the current-login policy');
    }
    return serialized(user.id, () =>
      withMongoTransaction(async () => {
        const publicDemoSession = meta.authenticationMethod === 'public_demo';
        const max = publicDemoSession ? 10 : tenant.sessionPolicy.maxConcurrentSessions;
        const blockConcurrentLogin = publicDemoSession ? true : tenant.features.blockConcurrentLogin;
        const idleTimeoutMin = publicDemoSession
          ? Math.min(PUBLIC_DEMO_SESSION_IDLE_MINUTES, tenant.sessionPolicy.idleTimeoutMin)
          : tenant.sessionPolicy.idleTimeoutMin;
        for (let pass = 0; pass < max + 2; pass++) {
          const active = await SessionModel.find({ userId: user.id, terminatedAt: null }).sort({ lastSeenAt: 1 });
          const now = new Date();
          const stale = active.filter((session) => session.expiresAt <= now);
          const assuranceInvalid = active.filter(
            (session) =>
              session.expiresAt > now &&
              !assuranceSatisfiesPolicy(session.loginAssurance, user, tenant, assurancePolicy),
          );
          for (const session of stale) await this.terminate(session.sessionId, 'timeout', user);
          // A legacy or now-under-assured session must not permanently block a compliant re-login
          // when the tenant uses blockConcurrentLogin. The successful new exchange supersedes it.
          for (const session of assuranceInvalid) await this.terminate(session.sessionId, 'superseded', user);
          const live = active.filter(
            (session) =>
              session.expiresAt > now &&
              assuranceSatisfiesPolicy(session.loginAssurance, user, tenant, assurancePolicy),
          );

          if (live.length >= max) {
            if (blockConcurrentLogin) throw new ConcurrentSessionBlockedError(live.length);
            const excess = live.length - max + 1;
            for (const session of live.slice(0, excess)) await this.terminate(session.sessionId, 'superseded', user);
            continue;
          }

          const occupied = new Set(live.map((session) => session.slot).filter((slot): slot is number => typeof slot === 'number'));
          const slot = Array.from({ length: max }, (_, index) => index).find((candidate) => !occupied.has(candidate));
          if (slot === undefined) continue;
          const sessionId = nanoid(32);
          let session;
          try {
            session = await SessionModel.create({
              sessionId,
              userId: user.id,
              tenantId: tenant.id,
              slot,
              lastSeenAt: now,
              expiresAt: new Date(now.getTime() + minutes(idleTimeoutMin)),
              ...(publicDemoSession
                ? { absoluteExpiresAt: new Date(now.getTime() + minutes(PUBLIC_DEMO_SESSION_ABSOLUTE_MINUTES)) }
                : {}),
              loginAssurance: {
                method: meta.authenticationMethod,
                ...(['firebase_mfa', 'risk_sense_otp'].includes(meta.authenticationMethod) ? { mfaVerifiedAt: now } : {}),
              },
              userAgent: meta.userAgent,
              ip: meta.ip,
            });
          } catch (error) {
            // Only the active-slot index on this exact create is a retryable allocation race.
            if (isMongoDuplicateKeyFor(error, ['userId', 'slot'])) throw new RetryableTransactionCollisionError('session-slot', error);
            throw error;
          }
          await UserModel.updateOne({ _id: user.id }, { $set: { lastLoginAt: now } });
          await audit.write({
            tenantId: tenant.id,
            category: 'session',
            action: 'session.created',
            actor: user,
            entity: { type: 'session', id: sessionAuditReference(String(session._id)) },
            payload: {
              userAgent: meta.userAgent,
              signInProvider: meta.signInProvider ?? null,
              authenticationMethod: meta.authenticationMethod,
            },
          });
          return session;
        }
        throw new AppError('INTERNAL', 'Unable to allocate an application session');
      }),
    );
  },

  /** Validates + extends the session on every request; expired → terminate + 401 SESSION_EXPIRED. */
  async touch(sessionId: string, user: AuthUser, tenant: AuthTenant, policy: TouchPolicy) {
    const session = await SessionModel.findOne({ sessionId, userId: user.id, tenantId: tenant.id });
    if (!session || session.terminatedAt) throw new AppError('SESSION_INVALID', 'Session is not active');
    const now = new Date();
    if (session.expiresAt <= now || (session.absoluteExpiresAt && session.absoluteExpiresAt <= now)) {
      await this.terminate(sessionId, 'timeout', user);
      throw new AppError('SESSION_EXPIRED', 'Session expired after inactivity');
    }
    const assurance = session.loginAssurance;
    // There is no trustworthy way to infer how a legacy session was authenticated. Re-login is
    // safer than upgrading it from historical enrollment or a claim on a later request.
    if (!assurance?.method) {
      throw new AppError('SESSION_INVALID', 'Session predates current-login assurance; sign in again');
    }
    if (assurance.method === 'public_demo' && !session.absoluteExpiresAt) {
      throw new AppError('SESSION_INVALID', 'Public demo session predates the absolute lifetime policy; sign in again');
    }
    if (assurance.method === 'development_bypass' && !policy.allowDevelopmentBypass) {
      throw new AppError('SESSION_INVALID', 'Development authentication is not valid for this request');
    }
    if (!assuranceSatisfiesPolicy(assurance, user, tenant, policy)) {
      throw new AppError('SESSION_INVALID', 'Session lacks current-login MFA assurance; sign in again');
    }
    session.lastSeenAt = now;
    const idleTimeoutMin = assurance.method === 'public_demo'
      ? Math.min(PUBLIC_DEMO_SESSION_IDLE_MINUTES, tenant.sessionPolicy.idleTimeoutMin)
      : tenant.sessionPolicy.idleTimeoutMin;
    const slidingExpiry = new Date(now.getTime() + minutes(idleTimeoutMin));
    session.expiresAt = session.absoluteExpiresAt && session.absoluteExpiresAt < slidingExpiry
      ? session.absoluteExpiresAt
      : slidingExpiry;
    await session.save();
    return session;
  },

  async terminate(sessionId: string, reason: (typeof import('./model').TERMINATION_REASONS)[number], actor?: AuthUser) {
    return withMongoTransaction(async () => {
      const session = await SessionModel.findOneAndUpdate(
        { sessionId, terminatedAt: null },
        { $set: { terminatedAt: new Date(), terminationReason: reason } },
        { new: true },
      );
      if (!session) return null;
      await audit.write({
        tenantId: String(session.tenantId),
        category: 'session',
        action: `session.${reason}`,
        actor: actor ?? null,
        entity: { type: 'session', id: sessionAuditReference(String(session._id)) },
        payload: { userId: String(session.userId) },
      });
      return session;
    });
  },

  /** Used when a role changes: existing sessions end so the new role applies at next login (FR-02). */
  async terminateAllForUser(userId: string, reason: 'role_changed' | 'admin', actor?: AuthUser) {
    return withMongoTransaction(async () => {
      const sessions = await SessionModel.find({ userId, terminatedAt: null });
      for (const s of sessions) await this.terminate(s.sessionId, reason, actor);
      return sessions.length;
    });
  },
};
