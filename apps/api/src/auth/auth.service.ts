import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { and, count, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { LoginResult, MeResponse, RegisterRequest } from '@cap/contracts';
import {
  authAttempts,
  invitations,
  localCredentials,
  mfaFactors,
  oneTimeTokens,
  users,
  type Database,
} from '@cap/database';
import {
  AppError,
  AuditService,
  DB,
  ENV,
  NotificationService,
  SettingsService,
  randomToken,
  sha256Hex,
} from '@cap/server-core';
import type { RequestContext } from '../common/decorators.js';
import type { ApiEnv } from '../env.js';
import { MfaService } from './mfa.service.js';
import { PasswordService } from './password.service.js';
import { SessionService, type SessionState } from './session.service.js';

const IP_WINDOW_MIN = 15;
const IP_MAX_FAILURES = 50;
const MFA_MAX_FAILURES = 5;

export interface SessionTokens {
  token: string;
  csrfToken: string;
}

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  private readonly logger = new Logger('Auth');

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: ApiEnv,
    private readonly settings: SettingsService,
    private readonly passwords: PasswordService,
    private readonly mfa: MfaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /** Crée le premier administrateur plateforme si aucun n'existe (idempotent, multi-instance sûr). */
  async onApplicationBootstrap(): Promise<void> {
    const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: password } = this.env;
    if (!email || !password) return;
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(7212024002)`);
      const [{ n }] = await tx.select({ n: count() }).from(users).where(eq(users.platformRole, 'platform_admin'));
      if (n > 0) return;
      const [u] = await tx
        .insert(users)
        .values({
          email: email.toLowerCase(),
          username: 'admin',
          displayName: 'Administrateur',
          platformRole: 'platform_admin',
          status: 'active',
          emailVerifiedAt: new Date(),
        })
        .returning({ id: users.id });
      await tx.insert(localCredentials).values({ userId: u.id, passwordHash: await this.passwords.hash(password) });
      await this.audit.record({ action: 'user.bootstrap_admin', targetType: 'user', targetId: u.id }, tx);
      this.logger.log(`Administrateur initial créé (${email})`);
    });
  }

  /* ------------------------------ Connexion ------------------------------ */

  async login(login: string, password: string, ctx: RequestContext): Promise<{ result: LoginResult; tokens: SessionTokens }> {
    const auth = await this.settings.section('auth');
    if (!auth.localLoginEnabled) throw new AppError('provider_disabled', 'Connexion locale désactivée');
    const key = `login:${login.trim().toLowerCase()}`;
    await this.checkIpRateLimit(ctx.ip);

    const [row] = await this.db
      .select({ user: users, cred: localCredentials })
      .from(users)
      .leftJoin(localCredentials, eq(localCredentials.userId, users.id))
      .where(and(or(sql`lower(${users.email}) = lower(${login})`, sql`lower(${users.username}) = lower(${login})`), isNull(users.deletedAt)));

    if (row?.cred?.lockedUntil && row.cred.lockedUntil > new Date()) {
      await this.recordAttempt(key, row.user.id, ctx, false, 'locked');
      throw new AppError('account_locked', 'Compte temporairement verrouillé', { until: row.cred.lockedUntil });
    }
    const ok = await this.passwords.verify(row?.cred?.passwordHash ?? null, password);
    if (!row || !row.cred || !ok) {
      await this.recordAttempt(key, row?.user.id ?? null, ctx, false, 'bad_password');
      if (row?.cred) {
        const failed = row.cred.failedAttempts + 1;
        const lock = failed >= auth.maxFailedLogins;
        await this.db
          .update(localCredentials)
          .set({
            failedAttempts: lock ? 0 : failed,
            lockedUntil: lock ? new Date(Date.now() + auth.lockoutMinutes * 60_000) : row.cred.lockedUntil,
          })
          .where(eq(localCredentials.userId, row.user.id));
        if (lock) {
          await this.audit.record({ actorId: row.user.id, action: 'auth.account_locked', outcome: 'failure', ip: ctx.ip });
          await this.notifications.notify({
            userId: row.user.id,
            type: 'security',
            title: 'Compte verrouillé temporairement',
            body: 'Plusieurs tentatives de connexion échouées ont verrouillé votre compte.',
            dedupeKey: `lock:${row.user.id}:${Math.floor(Date.now() / 60_000)}`,
          });
        }
      }
      await this.audit.record({ actorId: row?.user.id ?? null, actorLabel: login.slice(0, 100), action: 'auth.login', outcome: 'failure', ip: ctx.ip, userAgent: ctx.userAgent });
      throw new AppError('invalid_credentials', 'Identifiants invalides');
    }
    const user = row.user;
    if (user.status === 'suspended' || user.status === 'deleted') {
      await this.recordAttempt(key, user.id, ctx, false, 'suspended');
      throw new AppError('account_suspended', 'Compte suspendu');
    }
    if (user.status === 'pending_verification' && auth.emailVerificationRequired) {
      throw new AppError('email_not_verified', 'Adresse email non vérifiée');
    }
    await this.db.update(localCredentials).set({ failedAttempts: 0, lockedUntil: null }).where(eq(localCredentials.userId, user.id));
    await this.recordAttempt(key, user.id, ctx, true, 'password_ok');
    return this.openSession(user.id, user.platformRole, 'local', ctx);
  }

  /**
   * Ouvre une session après une authentification primaire réussie (locale ou fédérée),
   * en appliquant la politique MFA. Utilisé aussi par les fournisseurs SSO.
   */
  async openSession(
    userId: string,
    platformRole: 'platform_admin' | 'user',
    method: string,
    ctx: RequestContext,
    opts: { externalMfa?: boolean } = {},
  ): Promise<{ result: LoginResult; tokens: SessionTokens }> {
    const auth = await this.settings.section('auth');
    const hasTotp = await this.mfa.hasConfirmedTotp(userId);
    const mfaRequired =
      auth.mfaPolicy === 'required_all' || (auth.mfaPolicy === 'required_admins' && platformRole === 'platform_admin');
    let state: SessionState = 'active';
    let result: LoginResult;
    if (hasTotp && !opts.externalMfa) {
      state = 'pending_mfa';
      result = { status: 'mfa_required', methods: ['totp', 'recovery_code'] };
    } else if (mfaRequired && !hasTotp && !opts.externalMfa) {
      state = 'pending_mfa_enrollment';
      result = { status: 'mfa_enrollment_required' };
    } else {
      result = { status: 'authenticated', user: await this.me(userId) };
    }
    const s = await this.sessions.create(userId, { authMethod: method, state, ip: ctx.ip, userAgent: ctx.userAgent, mfaVerified: !!opts.externalMfa });
    if (state === 'active') {
      await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
      await this.audit.record({ actorId: userId, action: 'auth.login', ip: ctx.ip, userAgent: ctx.userAgent, metadata: { method } });
    }
    return { result, tokens: { token: s.token, csrfToken: s.csrfToken } };
  }

  async verifyMfa(sessionId: string, userId: string, code: string, ctx: RequestContext): Promise<{ result: LoginResult; tokens: SessionTokens }> {
    const key = `mfa:${sessionId}`;
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(authAttempts)
      .where(and(eq(authAttempts.key, key), eq(authAttempts.success, false)));
    if (n >= MFA_MAX_FAILURES) {
      await this.sessions.revoke(sessionId);
      throw new AppError('rate_limited', 'Trop de tentatives : reconnectez-vous');
    }
    const method = await this.mfa.verifyCode(userId, code);
    if (!method) {
      await this.recordAttempt(key, userId, ctx, false, 'mfa_invalid');
      await this.audit.record({ actorId: userId, action: 'auth.mfa', outcome: 'failure', ip: ctx.ip });
      throw new AppError('mfa_invalid', 'Code invalide');
    }
    await this.recordAttempt(key, userId, ctx, true, method);
    const tokens = await this.sessions.promote(sessionId, { mfaVerified: true });
    await this.db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
    await this.audit.record({ actorId: userId, action: 'auth.login', ip: ctx.ip, userAgent: ctx.userAgent, metadata: { method: `local+${method}` } });
    if (method === 'recovery_code') {
      await this.notifications.notify({
        userId,
        type: 'security',
        title: 'Code de récupération utilisé',
        body: 'Un code de récupération a été utilisé pour vous connecter. Régénérez vos codes si ce n’était pas vous.',
      });
    }
    return { result: { status: 'authenticated', user: await this.me(userId) }, tokens };
  }

  /** Fin d'enrôlement imposé : la session `pending_mfa_enrollment` devient active. */
  async completeEnrollment(sessionId: string, userId: string, code: string, ctx: RequestContext) {
    const codes = await this.mfa.confirmEnrollment(userId, code);
    const tokens = await this.sessions.promote(sessionId, { mfaVerified: true });
    await this.audit.record({ actorId: userId, action: 'auth.mfa_enrolled', ip: ctx.ip });
    await this.notifications.notify({ userId, type: 'security', title: 'Double authentification activée', body: 'Le TOTP a été configuré sur votre compte.' });
    return { codes, tokens };
  }

  /* ---------------------------- Inscription ----------------------------- */

  async register(input: RegisterRequest, ctx: RequestContext): Promise<{ status: 'verification_sent' | 'active' }> {
    const auth = await this.settings.section('auth');
    await this.checkIpRateLimit(ctx.ip);
    let invitation: typeof invitations.$inferSelect | undefined;
    if (input.invitationToken) {
      [invitation] = await this.db
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.tokenHash, sha256Hex(input.invitationToken)),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, sql`now()`),
          ),
        );
      if (!invitation) throw new AppError('not_found', 'Invitation invalide ou expirée');
      if (invitation.email.toLowerCase() !== input.email.toLowerCase()) throw new AppError('forbidden', 'Invitation destinée à une autre adresse');
    } else if (!auth.registrationEnabled) {
      throw new AppError('registration_disabled', 'Les inscriptions sont fermées');
    }
    const policyError = this.passwords.validate(input.password, input);
    if (policyError) throw new AppError('validation_failed', policyError);
    const hash = await this.passwords.hash(input.password);
    const verified = !!invitation || !auth.emailVerificationRequired;
    const userId = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(or(sql`lower(${users.email}) = ${input.email}`, sql`lower(${users.username}) = lower(${input.username})`));
      if (existing.length > 0) throw new AppError('conflict', 'Email ou identifiant déjà utilisé');
      const [u] = await tx
        .insert(users)
        .values({
          email: input.email,
          username: input.username,
          displayName: input.displayName,
          status: verified ? 'active' : 'pending_verification',
          emailVerifiedAt: invitation ? new Date() : null,
        })
        .returning({ id: users.id });
      await tx.insert(localCredentials).values({ userId: u.id, passwordHash: hash });
      if (invitation) {
        await tx.update(invitations).set({ acceptedAt: new Date(), acceptedBy: u.id }).where(eq(invitations.id, invitation.id));
      }
      await this.audit.record({ actorId: u.id, action: 'user.register', targetType: 'user', targetId: u.id, ip: ctx.ip, metadata: { invited: !!invitation } }, tx);
      return u.id;
    });
    if (!invitation && auth.emailVerificationRequired) {
      await this.sendVerification(userId, input.email, input.displayName);
      return { status: 'verification_sent' };
    }
    return { status: 'active' };
  }

  async sendVerification(userId: string, email: string, name: string): Promise<void> {
    const token = randomToken(32);
    await this.db.insert(oneTimeTokens).values({
      userId,
      purpose: 'email_verification',
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + 48 * 3600_000),
    });
    await this.notifications.sendEmail({
      to: email,
      userId,
      template: 'auth.verify_email',
      vars: { name, link: `${this.env.PUBLIC_URL}/auth/verify-email?token=${token}` },
      idempotencyKey: `verify:${sha256Hex(token)}`,
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.consumeToken(token, 'email_verification');
    await this.db
      .update(users)
      .set({ emailVerifiedAt: new Date(), status: sql`case when ${users.status} = 'pending_verification' then 'active' else ${users.status} end` })
      .where(eq(users.id, userId));
    await this.audit.record({ actorId: userId, action: 'user.email_verified', targetType: 'user', targetId: userId });
  }

  /* -------------------------- Mot de passe ----------------------------- */

  /** Réponse identique que le compte existe ou non (pas d'énumération). */
  async forgotPassword(email: string, ctx: RequestContext): Promise<void> {
    await this.checkIpRateLimit(ctx.ip);
    await this.recordAttempt(`forgot:${email}`, null, ctx, true, 'requested');
    const [row] = await this.db
      .select({ id: users.id, name: users.displayName, status: users.status, hasPwd: localCredentials.userId })
      .from(users)
      .leftJoin(localCredentials, eq(localCredentials.userId, users.id))
      .where(sql`lower(${users.email}) = ${email}`);
    if (!row || !row.hasPwd || row.status === 'deleted' || row.status === 'suspended') return;
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(oneTimeTokens)
      .where(and(eq(oneTimeTokens.userId, row.id), eq(oneTimeTokens.purpose, 'password_reset'), gt(oneTimeTokens.createdAt, sql`now() - interval '1 hour'`)));
    if (n >= 3) return;
    const token = randomToken(32);
    await this.db.insert(oneTimeTokens).values({
      userId: row.id,
      purpose: 'password_reset',
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await this.notifications.sendEmail({
      to: email,
      userId: row.id,
      template: 'auth.password_reset',
      vars: { name: row.name, link: `${this.env.PUBLIC_URL}/auth/reset-password?token=${token}` },
      idempotencyKey: `reset:${sha256Hex(token)}`,
    });
    await this.audit.record({ actorId: row.id, action: 'auth.password_reset_requested', ip: ctx.ip });
  }

  async resetPassword(token: string, password: string, ctx: RequestContext): Promise<void> {
    const userId = await this.consumeToken(token, 'password_reset');
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    const err = this.passwords.validate(password, u);
    if (err) throw new AppError('validation_failed', err);
    const hash = await this.passwords.hash(password);
    await this.db.transaction(async (tx) => {
      await tx
        .insert(localCredentials)
        .values({ userId, passwordHash: hash })
        .onConflictDoUpdate({ target: localCredentials.userId, set: { passwordHash: hash, passwordChangedAt: new Date(), failedAttempts: 0, lockedUntil: null } });
      await this.sessions.revokeAll(userId, undefined, tx);
      await this.audit.record({ actorId: userId, action: 'auth.password_reset', ip: ctx.ip }, tx);
    });
    await this.notifications.notify({ userId, type: 'security', title: 'Mot de passe réinitialisé', body: 'Votre mot de passe a été réinitialisé et toutes vos sessions fermées.' });
  }

  async changePassword(userId: string, sessionId: string, current: string, next: string, ctx: RequestContext): Promise<void> {
    const [row] = await this.db
      .select({ user: users, cred: localCredentials })
      .from(users)
      .innerJoin(localCredentials, eq(localCredentials.userId, users.id))
      .where(eq(users.id, userId));
    if (!row || !(await this.passwords.verify(row.cred.passwordHash, current))) {
      await this.audit.record({ actorId: userId, action: 'auth.password_change', outcome: 'failure', ip: ctx.ip });
      throw new AppError('invalid_credentials', 'Mot de passe actuel incorrect');
    }
    const err = this.passwords.validate(next, row.user);
    if (err) throw new AppError('validation_failed', err);
    const hash = await this.passwords.hash(next);
    await this.db.update(localCredentials).set({ passwordHash: hash, passwordChangedAt: new Date() }).where(eq(localCredentials.userId, userId));
    await this.sessions.revokeAll(userId, sessionId);
    await this.audit.record({ actorId: userId, action: 'auth.password_change', ip: ctx.ip });
    await this.notifications.notify({ userId, type: 'security', title: 'Mot de passe modifié', body: 'Votre mot de passe a été modifié. Les autres sessions ont été fermées.' });
  }

  async disableMfa(userId: string, password: string, ctx: RequestContext): Promise<void> {
    const auth = await this.settings.section('auth');
    const [row] = await this.db
      .select({ role: users.platformRole, hash: localCredentials.passwordHash })
      .from(users)
      .leftJoin(localCredentials, eq(localCredentials.userId, users.id))
      .where(eq(users.id, userId));
    if (!(await this.passwords.verify(row?.hash ?? null, password))) throw new AppError('invalid_credentials', 'Mot de passe incorrect');
    if (auth.mfaPolicy === 'required_all' || (auth.mfaPolicy === 'required_admins' && row.role === 'platform_admin')) {
      throw new AppError('forbidden', 'La politique impose la double authentification');
    }
    await this.mfa.disable(userId);
    await this.audit.record({ actorId: userId, action: 'auth.mfa_disabled', ip: ctx.ip });
    await this.notifications.notify({ userId, type: 'security', title: 'Double authentification désactivée', body: 'Le TOTP a été retiré de votre compte.' });
  }

  /* ------------------------------ Profil ------------------------------- */

  async me(userId: string): Promise<MeResponse> {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    const [mfa] = await this.db
      .select({ id: mfaFactors.id })
      .from(mfaFactors)
      .where(and(eq(mfaFactors.userId, userId), eq(mfaFactors.type, 'totp'), sql`${mfaFactors.confirmedAt} is not null`));
    return {
      id: u.id,
      email: u.email,
      username: u.username,
      displayName: u.displayName,
      platformRole: u.platformRole,
      emailVerified: !!u.emailVerifiedAt,
      mfaEnabled: !!mfa,
      createdAt: u.createdAt.toISOString(),
    };
  }

  /* ----------------------------- Interne ------------------------------- */

  private async consumeToken(token: string, purpose: 'email_verification' | 'password_reset'): Promise<string> {
    const rows = await this.db
      .update(oneTimeTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(oneTimeTokens.tokenHash, sha256Hex(token)),
          eq(oneTimeTokens.purpose, purpose),
          isNull(oneTimeTokens.usedAt),
          gt(oneTimeTokens.expiresAt, sql`now()`),
        ),
      )
      .returning({ userId: oneTimeTokens.userId });
    if (rows.length === 0) throw new AppError('not_found', 'Lien invalide ou expiré');
    return rows[0].userId;
  }

  async recordAttempt(key: string, userId: string | null, ctx: RequestContext, success: boolean, reason: string) {
    await this.db.insert(authAttempts).values({ key, userId, ip: ctx.ip, kind: key.split(':')[0], success, reason });
  }

  async checkIpRateLimit(ip: string | null): Promise<void> {
    if (!ip) return;
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(authAttempts)
      .where(and(eq(authAttempts.ip, ip), eq(authAttempts.success, false), gt(authAttempts.createdAt, sql`now() - (${IP_WINDOW_MIN} * interval '1 minute')`)));
    if (n >= IP_MAX_FAILURES) throw new AppError('rate_limited', 'Trop de tentatives depuis cette adresse');
  }
}
