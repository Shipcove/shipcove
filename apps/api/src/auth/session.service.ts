import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { Response } from 'express';
import type { SessionInfo } from '@cap/contracts';
import { userSessions, users, type Database, type DbOrTx } from '@cap/database';
import { DB, ENV, SettingsService, randomToken, sha256Hex } from '@cap/server-core';
import type { ApiEnv } from '../env.js';

export const SESSION_COOKIE = 'cap_session';
export const CSRF_COOKIE = 'cap_csrf';

export type SessionState = 'active' | 'pending_mfa' | 'pending_mfa_enrollment';

export interface LoadedSession {
  id: string;
  state: SessionState;
  csrfToken: string;
  mfaVerifiedAt: Date | null;
  authMethod: string;
  user: {
    id: string;
    email: string;
    username: string;
    displayName: string;
    platformRole: 'platform_admin' | 'user';
    status: string;
  };
}

/**
 * Sessions serveur en PostgreSQL (ADR 0008) : aucune affinité requise entre instances API.
 * Le jeton brut n'existe que dans le cookie ; la base stocke son SHA-256.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: ApiEnv,
    private readonly settings: SettingsService,
  ) {}

  async create(
    userId: string,
    opts: { authMethod: string; state: SessionState; ip: string | null; userAgent: string | null; mfaVerified?: boolean },
    tx?: DbOrTx,
  ): Promise<{ token: string; csrfToken: string; sessionId: string }> {
    const exec = tx ?? this.db;
    const auth = await this.settings.section('auth');
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const [u] = await exec.select({ epoch: users.sessionEpoch }).from(users).where(eq(users.id, userId));
    const now = Date.now();
    const pending = opts.state !== 'active';
    const [row] = await exec
      .insert(userSessions)
      .values({
        userId,
        tokenHash: sha256Hex(token),
        csrfToken,
        sessionEpoch: u.epoch,
        authMethod: opts.authMethod,
        state: opts.state,
        mfaVerifiedAt: opts.mfaVerified ? new Date() : null,
        ip: opts.ip,
        userAgent: opts.userAgent?.slice(0, 500) ?? null,
        // Une session en attente de MFA expire vite.
        idleExpiresAt: new Date(now + (pending ? 10 * 60_000 : auth.sessionIdleHours * 3600_000)),
        absoluteExpiresAt: new Date(now + (pending ? 10 * 60_000 : auth.sessionAbsoluteHours * 3600_000)),
      })
      .returning({ id: userSessions.id });
    return { token, csrfToken, sessionId: row.id };
  }

  async load(token: string | undefined): Promise<LoadedSession | null> {
    if (!token || token.length < 20 || token.length > 200) return null;
    const rows = await this.db
      .select({
        id: userSessions.id,
        state: userSessions.state,
        csrfToken: userSessions.csrfToken,
        mfaVerifiedAt: userSessions.mfaVerifiedAt,
        authMethod: userSessions.authMethod,
        sessionEpoch: userSessions.sessionEpoch,
        lastSeenAt: userSessions.lastSeenAt,
        user: {
          id: users.id,
          email: users.email,
          username: users.username,
          displayName: users.displayName,
          platformRole: users.platformRole,
          status: users.status,
          epoch: users.sessionEpoch,
        },
      })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(
        and(
          eq(userSessions.tokenHash, sha256Hex(token)),
          isNull(userSessions.revokedAt),
          gt(userSessions.idleExpiresAt, sql`now()`),
          gt(userSessions.absoluteExpiresAt, sql`now()`),
        ),
      );
    const s = rows[0];
    if (!s) return null;
    if (s.sessionEpoch !== s.user.epoch) return null; // révocation globale
    if (s.user.status !== 'active') return null;
    // Expiration glissante, écrite au plus une fois par minute.
    if (s.state === 'active' && Date.now() - s.lastSeenAt.getTime() > 60_000) {
      const auth = await this.settings.section('auth');
      await this.db
        .update(userSessions)
        .set({ lastSeenAt: new Date(), idleExpiresAt: new Date(Date.now() + auth.sessionIdleHours * 3600_000) })
        .where(eq(userSessions.id, s.id));
    }
    const { epoch: _e, ...user } = s.user;
    return {
      id: s.id,
      state: s.state,
      csrfToken: s.csrfToken,
      mfaVerifiedAt: s.mfaVerifiedAt,
      authMethod: s.authMethod,
      user,
    };
  }

  /** Promotion après MFA : nouveau jeton (anti fixation de session). */
  async promote(sessionId: string, opts: { mfaVerified: boolean }): Promise<{ token: string; csrfToken: string }> {
    const auth = await this.settings.section('auth');
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    await this.db
      .update(userSessions)
      .set({
        tokenHash: sha256Hex(token),
        csrfToken,
        state: 'active',
        mfaVerifiedAt: opts.mfaVerified ? new Date() : null,
        idleExpiresAt: new Date(Date.now() + auth.sessionIdleHours * 3600_000),
        absoluteExpiresAt: new Date(Date.now() + auth.sessionAbsoluteHours * 3600_000),
      })
      .where(eq(userSessions.id, sessionId));
    return { token, csrfToken };
  }

  async setState(sessionId: string, state: SessionState): Promise<void> {
    await this.db.update(userSessions).set({ state }).where(eq(userSessions.id, sessionId));
  }

  async revoke(sessionId: string, userId?: string): Promise<boolean> {
    const res = await this.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.id, sessionId), isNull(userSessions.revokedAt), ...(userId ? [eq(userSessions.userId, userId)] : [])))
      .returning({ id: userSessions.id });
    return res.length > 0;
  }

  /** Révoque toutes les sessions (sauf éventuellement la courante). */
  async revokeAll(userId: string, exceptSessionId?: string, tx?: DbOrTx): Promise<void> {
    const exec = tx ?? this.db;
    await exec
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userSessions.userId, userId),
          isNull(userSessions.revokedAt),
          ...(exceptSessionId ? [ne(userSessions.id, exceptSessionId)] : []),
        ),
      );
    if (!exceptSessionId) {
      await exec.update(users).set({ sessionEpoch: sql`${users.sessionEpoch} + 1` }).where(eq(users.id, userId));
    }
  }

  async list(userId: string, currentId: string): Promise<SessionInfo[]> {
    const rows = await this.db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt), gt(userSessions.absoluteExpiresAt, sql`now()`)))
      .orderBy(sql`${userSessions.lastSeenAt} desc`);
    return rows.map((r) => ({
      id: r.id,
      current: r.id === currentId,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      expiresAt: (r.idleExpiresAt < r.absoluteExpiresAt ? r.idleExpiresAt : r.absoluteExpiresAt).toISOString(),
      ip: r.ip,
      userAgent: r.userAgent,
      authMethod: r.authMethod,
    }));
  }

  setCookies(res: Response, token: string, csrfToken: string): void {
    const secure = this.env.COOKIE_SECURE;
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
    // Lisible par Angular pour l'en-tête X-CSRF-Token (lié à la session côté serveur).
    res.cookie(CSRF_COOKIE, csrfToken, { httpOnly: false, secure, sameSite: 'strict', path: '/' });
  }

  clearCookies(res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }
}
