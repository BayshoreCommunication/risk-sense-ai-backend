import { nanoid } from 'nanoid';
import { RetryableTransactionCollisionError, isMongoDuplicateKeyFor, withMongoTransaction } from '../../lib/db';
import { AppError } from '../../lib/errors';
import type { AuthTenant, AuthUser } from '../../middleware/auth';
import { audit } from '../audit/service';
import { UserModel } from '../users/model';
import { SessionModel } from './model';

interface Meta {
  userAgent?: string;
  ip?: string;
  signInProvider?: string; // FR-03: which first factor produced this session
}

const minutes = (n: number) => n * 60 * 1000;

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
  async create(user: AuthUser, tenant: AuthTenant, meta: Meta = {}) {
    return serialized(user.id, () =>
      withMongoTransaction(async () => {
        const max = tenant.sessionPolicy.maxConcurrentSessions;
        for (let pass = 0; pass < max + 2; pass++) {
          const active = await SessionModel.find({ userId: user.id, terminatedAt: null }).sort({ lastSeenAt: 1 });
          const now = new Date();
          const live = active.filter((session) => session.expiresAt > now);
          const stale = active.filter((session) => session.expiresAt <= now);
          for (const session of stale) await this.terminate(session.sessionId, 'timeout', user);

          if (live.length >= max) {
            if (tenant.features.blockConcurrentLogin) throw new ConcurrentSessionBlockedError(live.length);
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
              expiresAt: new Date(now.getTime() + minutes(tenant.sessionPolicy.idleTimeoutMin)),
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
            entity: { type: 'session', id: sessionId },
            payload: { userAgent: meta.userAgent, signInProvider: meta.signInProvider ?? null },
          });
          return session;
        }
        throw new AppError('INTERNAL', 'Unable to allocate an application session');
      }),
    );
  },

  /** Validates + extends the session on every request; expired → terminate + 401 SESSION_EXPIRED. */
  async touch(sessionId: string, user: AuthUser, tenant: AuthTenant) {
    const session = await SessionModel.findOne({ sessionId, userId: user.id });
    if (!session || session.terminatedAt) throw new AppError('SESSION_INVALID', 'Session is not active');
    const now = new Date();
    if (session.expiresAt <= now) {
      await this.terminate(sessionId, 'timeout', user);
      throw new AppError('SESSION_EXPIRED', 'Session expired after inactivity');
    }
    session.lastSeenAt = now;
    session.expiresAt = new Date(now.getTime() + minutes(tenant.sessionPolicy.idleTimeoutMin));
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
        entity: { type: 'session', id: sessionId },
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
