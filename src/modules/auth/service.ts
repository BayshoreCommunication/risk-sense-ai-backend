import { nanoid } from 'nanoid';
import { AppError } from '../../lib/errors';
import type { AuthTenant, AuthUser } from '../../middleware/auth';
import { audit } from '../audit/service';
import { UserModel } from '../users/model';
import { SessionModel } from './model';

interface Meta {
  userAgent?: string;
  ip?: string;
}

const minutes = (n: number) => n * 60 * 1000;

export const sessionService = {
  /**
   * Creates an app session. Enforces `maxConcurrentSessions` (SEC-02):
   * - default: supersede the oldest active session(s) so the newest login wins;
   * - tenant.features.blockConcurrentLogin (FR-04): reject the new login instead.
   */
  async create(user: AuthUser, tenant: AuthTenant, meta: Meta = {}) {
    const active = await SessionModel.find({ userId: user.id, terminatedAt: null }).sort({ lastSeenAt: 1 });
    const now = new Date();
    const live = active.filter((s) => s.expiresAt > now);
    const stale = active.filter((s) => s.expiresAt <= now);

    for (const s of stale) await this.terminate(s.sessionId, 'timeout', user);

    if (live.length >= tenant.sessionPolicy.maxConcurrentSessions) {
      if (tenant.features.blockConcurrentLogin) {
        await audit.write({
          tenantId: tenant.id,
          category: 'session',
          action: 'session.rejected_concurrent',
          actor: user,
          entity: { type: 'user', id: user.id },
          payload: { activeSessions: live.length },
        });
        throw new AppError('CONCURRENT_LOGIN_BLOCKED', 'Another session is already active for this account');
      }
      const excess = live.length - tenant.sessionPolicy.maxConcurrentSessions + 1;
      for (const s of live.slice(0, excess)) await this.terminate(s.sessionId, 'superseded', user);
    }

    const sessionId = nanoid(32);
    const session = await SessionModel.create({
      sessionId,
      userId: user.id,
      tenantId: tenant.id,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + minutes(tenant.sessionPolicy.idleTimeoutMin)),
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    await UserModel.updateOne({ _id: user.id }, { $set: { lastLoginAt: now } });
    await audit.write({
      tenantId: tenant.id,
      category: 'session',
      action: 'session.created',
      actor: user,
      entity: { type: 'session', id: sessionId },
      payload: { userAgent: meta.userAgent },
    });
    return session;
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
  },

  /** Used when a role changes: existing sessions end so the new role applies at next login (FR-02). */
  async terminateAllForUser(userId: string, reason: 'role_changed' | 'admin', actor?: AuthUser) {
    const sessions = await SessionModel.find({ userId, terminatedAt: null });
    for (const s of sessions) await this.terminate(s.sessionId, reason, actor);
    return sessions.length;
  },
};
