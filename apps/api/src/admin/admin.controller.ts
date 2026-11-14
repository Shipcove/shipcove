import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AdminCreateUserSchema,
  AdminUpdateUserSchema,
  AuditQuerySchema,
  CreditAdjustmentSchema,
  PlatformSettingsPatchSchema,
  QuotaPolicyInputSchema,
  RetentionDataTypes,
  RetentionPolicySchema,
  SmtpConfigSchema,
  type AdminOverviewDto,
  type AdminUserDto,
  type AuditEventDto,
  type PlatformSettings,
} from '@cap/contracts';
import type { SecretProvider } from '@cap/secrets';
import {
  auditEvents,
  authIdentities,
  authProviders,
  creditLedger,
  emailTemplates,
  localCredentials,
  mfaFactors,
  quotaPolicies,
  retentionPolicies,
  sandboxImages,
  sandboxInstances,
  secretRefs,
  serviceInstances,
  teamMembers,
  teams,
  users,
  workspaces,
  type Database,
} from '@cap/database';
import { AppError, AuditService, DB, JobsService, NotificationService, ObjectStorage, QuotaService, SECRETS, SettingsService, randomToken, sha256Hex } from '@cap/server-core';
import { isUniqueViolation } from '@cap/server-core';
import { CurrentUser, PlatformAdmin, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { MfaService } from '../auth/mfa.service.js';
import { SandboxRpcClient } from '../workspaces/sandbox-rpc.client.js';
import { LiteLlmAdminService } from './litellm.service.js';

const uuid = { schema: z.uuid() };

/**
 * Console d'administration (SPEC §19). Toutes les routes exigent le rôle administrateur
 * plateforme et sont auditées. Aucune route ne donne accès au contenu des conversations.
 */
@ApiTags('admin')
@PlatformAdmin()
@Controller('admin')
export class AdminController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly quotas: QuotaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly notifications: NotificationService,
    private readonly jobs: JobsService,
    private readonly storage: ObjectStorage,
    private readonly rpc: SandboxRpcClient,
    private readonly litellm: LiteLlmAdminService,
  ) {}

  /* ------------------------------ Vue d'ensemble ------------------------------ */

  @Get('overview')
  async overview(): Promise<AdminOverviewDto> {
    const q = async <T>(s: ReturnType<typeof sql>) => (await this.db.execute<T & Record<string, unknown>>(s)).rows[0];
    const u = await q<{ total: number; active: number; suspended: number }>(
      sql`select count(*)::int total, count(*) filter (where status='active')::int active, count(*) filter (where status='suspended')::int suspended from users where deleted_at is null`,
    );
    const t = await q<{ n: number }>(sql`select count(*)::int n from teams where deleted_at is null`);
    const w = await q<{ total: number; running: number }>(sql`select count(*)::int total, count(*) filter (where status='running')::int running from workspaces where deleted_at is null`);
    const sb = await q<{ n: number }>(sql`select count(*)::int n from sandbox_instances where status in ('creating','restoring','running')`);
    const llm = await q<{ requests: number; errors: number; credits: string; cost: string; p95: number | null }>(sql`
      select count(*)::int requests, count(*) filter (where status in ('failed','rejected'))::int errors,
        coalesce(sum(credits),0)::text credits, coalesce(sum(provider_cost_usd),0)::text cost,
        percentile_cont(0.95) within group (order by latency_ms)::int p95
      from llm_requests where created_at > now() - interval '24 hours'`);
    const ck = await q<{ failed: number; unsynced: number }>(sql`
      select (select count(*)::int from checkpoint_jobs where status='failed' and created_at > now() - interval '24 hours') failed,
             (select count(*)::int from workspaces where sync_state='unsynced') unsynced`);
    const jobs = await this.jobs.stats();
    const vault = await this.secrets.health();
    const s3 = await this.storage.health();
    const workers = await q<{ n: number }>(sql`select count(*)::int n from service_instances where kind='worker' and heartbeat_at > now() - interval '1 minute'`);
    return {
      users: u,
      teams: t.n,
      workspaces: w,
      sandboxes: { active: sb.n },
      llm: { requests24h: llm.requests, errors24h: llm.errors, credits24h: llm.credits, costUsd24h: llm.cost, p95LatencyMs: llm.p95 },
      checkpoints: { failed24h: ck.failed, unsyncedWorkspaces: ck.unsynced },
      jobs: { pending: jobs.pending, failed: jobs.dead },
      health: {
        database: { status: 'up' },
        vault: { status: vault.ok ? 'up' : 'down', detail: vault.detail },
        storage: { status: s3.ok ? 'up' : 'down' },
        litellm: { status: (await this.litellm.health()) ? 'up' : 'down' },
        workers: { status: workers.n > 0 ? 'up' : 'down', detail: `${workers.n} instance(s)` },
      },
    };
  }

  /* -------------------------------- Paramètres -------------------------------- */

  @Get('settings')
  getSettings(): Promise<PlatformSettings> {
    return this.settings.get();
  }

  @Patch('settings')
  async patchSettings(@Body({ schema: PlatformSettingsPatchSchema }) body: z.infer<typeof PlatformSettingsPatchSchema>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const res = await this.settings.update(body.section, body.values, user.id);
    await this.audit.record({ actorId: user.id, action: `admin.settings.${body.section}`, ip: ctx.ip, metadata: body.values });
    return res;
  }

  /* ---------------------------------- Quotas ---------------------------------- */

  @Get('quotas/policies')
  policies() {
    return this.db.select().from(quotaPolicies).where(eq(quotaPolicies.active, true)).orderBy(quotaPolicies.scope);
  }

  /** Nouvelle version de politique (l'ancienne est désactivée, conservée pour l'historique). */
  @Put('quotas/policies')
  async putPolicy(@Body({ schema: QuotaPolicyInputSchema }) body: z.infer<typeof QuotaPolicyInputSchema>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    if (body.scope !== 'global_user_default' && !body.subjectId) throw new AppError('validation_failed', 'subjectId requis');
    await this.db.transaction(async (tx) => {
      const cond = and(eq(quotaPolicies.scope, body.scope), body.subjectId ? eq(quotaPolicies.subjectId, body.subjectId) : isNull(quotaPolicies.subjectId), eq(quotaPolicies.active, true));
      const [prev] = await tx.select().from(quotaPolicies).where(cond);
      if (prev) await tx.update(quotaPolicies).set({ active: false }).where(eq(quotaPolicies.id, prev.id));
      await tx.insert(quotaPolicies).values({ ...body, version: (prev?.version ?? 0) + 1, createdBy: user.id });
      await this.audit.record({ actorId: user.id, action: 'admin.quota_policy', ip: ctx.ip, metadata: body }, tx);
    });
    return { ok: true };
  }

  @Delete('quotas/policies/:policyId')
  @HttpCode(204)
  async deletePolicy(@Param('policyId', uuid) id: string, @CurrentUser() user: AuthUser) {
    await this.db.update(quotaPolicies).set({ active: false }).where(eq(quotaPolicies.id, id));
    await this.audit.record({ actorId: user.id, action: 'admin.quota_policy_delete', targetId: id });
  }

  @Get('quotas/history')
  async policyHistory() {
    return this.db.select().from(quotaPolicies).orderBy(desc(quotaPolicies.createdAt)).limit(500);
  }

  @Post('quotas/adjustments')
  async adjust(@Body({ schema: CreditAdjustmentSchema }) body: z.infer<typeof CreditAdjustmentSchema>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.quotas.adjust({ ...body, actorId: user.id, idempotencyKey: randomToken(12) });
    await this.audit.record({ actorId: user.id, action: 'admin.credit_adjustment', targetType: 'user', targetId: body.userId, ip: ctx.ip, metadata: body });
    return { ok: true };
  }

  @Get('quotas/ledger')
  async ledger(@Query('userId', { schema: z.uuid().optional() }) userId?: string, @Query('teamId', { schema: z.uuid().optional() }) teamId?: string) {
    return this.db
      .select()
      .from(creditLedger)
      .where(and(...(userId ? [eq(creditLedger.userId, userId)] : []), ...(teamId ? [eq(creditLedger.teamId, teamId)] : [])))
      .orderBy(desc(creditLedger.occurredAt))
      .limit(500);
  }

  @Get('quotas/usage/:userId')
  async userUsage(@Param('userId', uuid) userId: string) {
    return { windows: await this.quotas.userWindows(userId) };
  }

  /* -------------------------------- Utilisateurs ------------------------------- */

  @Get('users')
  async users(@Query('q', { schema: z.string().max(100).optional() }) q?: string): Promise<AdminUserDto[]> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(isNull(users.deletedAt), ...(q ? [or(ilike(users.email, `%${q}%`), ilike(users.username, `%${q}%`), ilike(users.displayName, `%${q}%`))] : [])))
      .orderBy(users.displayName)
      .limit(500);
    const ids = rows.map((r) => r.id);
    const mfa = ids.length ? await this.db.select({ userId: mfaFactors.userId }).from(mfaFactors).where(and(inArray(mfaFactors.userId, ids), eq(mfaFactors.type, 'totp'), sql`${mfaFactors.confirmedAt} is not null`)) : [];
    const idents = ids.length
      ? await this.db.select({ userId: authIdentities.userId, provider: authProviders.name, subject: authIdentities.subject }).from(authIdentities).innerJoin(authProviders, eq(authProviders.id, authIdentities.providerId)).where(inArray(authIdentities.userId, ids))
      : [];
    return rows.map((u) => ({
      id: u.id,
      email: u.email,
      username: u.username,
      displayName: u.displayName,
      platformRole: u.platformRole,
      status: u.status,
      mfaEnabled: mfa.some((m) => m.userId === u.id),
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
      identities: idents.filter((i) => i.userId === u.id).map((i) => ({ provider: i.provider, subject: i.subject })),
    }));
  }

  @Post('users')
  async createUser(@Body({ schema: AdminCreateUserSchema }) body: z.infer<typeof AdminCreateUserSchema>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const [u] = await this.db
      .insert(users)
      .values({ email: body.email.toLowerCase(), username: body.username, displayName: body.displayName, platformRole: body.platformRole, status: 'active', emailVerifiedAt: new Date() })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError('conflict', 'Email ou identifiant déjà utilisé');
        throw err;
      });
    if (body.password) {
      const e = this.passwords.validate(body.password, body);
      if (e) throw new AppError('validation_failed', e);
      await this.db.insert(localCredentials).values({ userId: u.id, passwordHash: await this.passwords.hash(body.password) });
    } else {
      // Lien de définition du mot de passe (réutilise le flux de réinitialisation).
      await this.db.insert(localCredentials).values({ userId: u.id, passwordHash: await this.passwords.hash(randomToken(32)) });
      const token = randomToken(32);
      const { oneTimeTokens } = await import('@cap/database');
      await this.db.insert(oneTimeTokens).values({ userId: u.id, purpose: 'password_reset', tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 7 * 24 * 3600_000) });
      await this.notifications.sendEmail({
        to: u.email,
        userId: u.id,
        template: 'auth.password_reset',
        vars: { name: u.displayName, link: `/auth/reset-password?token=${token}` },
        idempotencyKey: `welcome:${u.id}`,
      });
    }
    await this.audit.record({ actorId: user.id, action: 'admin.user_create', targetType: 'user', targetId: u.id, ip: ctx.ip, metadata: { email: u.email, role: body.platformRole } });
    return { id: u.id };
  }

  @Patch('users/:userId')
  async updateUser(@Param('userId', uuid) id: string, @Body({ schema: AdminUpdateUserSchema }) body: z.infer<typeof AdminUpdateUserSchema>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    if (id === user.id && (body.status === 'suspended' || body.platformRole === 'user')) throw new AppError('conflict', 'Impossible de vous rétrograder ou suspendre vous-même');
    await this.db.update(users).set({ ...body, updatedAt: new Date() }).where(eq(users.id, id));
    if (body.status === 'suspended') await this.sessions.revokeAll(id);
    await this.audit.record({ actorId: user.id, action: 'admin.user_update', targetType: 'user', targetId: id, ip: ctx.ip, metadata: body });
    return { ok: true };
  }

  @Post('users/:userId/revoke-sessions')
  @HttpCode(204)
  async revokeSessions(@Param('userId', uuid) id: string, @CurrentUser() user: AuthUser) {
    await this.sessions.revokeAll(id);
    await this.audit.record({ actorId: user.id, action: 'admin.user_revoke_sessions', targetType: 'user', targetId: id });
  }

  /** Récupération de compte : réinitialisation MFA (sessions révoquées, notification de sécurité). */
  @Post('users/:userId/reset-mfa')
  @HttpCode(204)
  async resetMfa(@Param('userId', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.mfa.disable(id);
    await this.sessions.revokeAll(id);
    await this.notifications.notify({ userId: id, type: 'security', title: 'Double authentification réinitialisée', body: 'Un administrateur a réinitialisé votre second facteur. Reconfigurez-le à la prochaine connexion.' });
    await this.audit.record({ actorId: user.id, action: 'admin.user_reset_mfa', targetType: 'user', targetId: id, ip: ctx.ip });
  }

  /** Suppression : anonymisation du compte, sessions et identités supprimées (les ressources partagées restent). */
  @Delete('users/:userId')
  @HttpCode(204)
  async deleteUser(@Param('userId', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    if (id === user.id) throw new AppError('conflict', 'Impossible de supprimer votre propre compte');
    // Identifiant anonymisé dérivé de l'UUID complet : le préfixe d'un UUIDv7 (horodatage) n'est pas unique.
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ status: 'deleted', deletedAt: new Date(), email: `deleted-${id}@invalid`, username: `deleted-${id.replaceAll('-', '')}`, displayName: 'Utilisateur supprimé' })
        .where(eq(users.id, id));
      await tx.delete(authIdentities).where(eq(authIdentities.userId, id));
      await tx.delete(localCredentials).where(eq(localCredentials.userId, id));
      await tx.delete(teamMembers).where(eq(teamMembers.userId, id));
      await this.sessions.revokeAll(id, undefined, tx);
      await this.audit.record({ actorId: user.id, action: 'admin.user_delete', targetType: 'user', targetId: id, ip: ctx.ip }, tx);
    });
    await this.mfa.disable(id);
    const ws = await this.db.select({ id: workspaces.id }).from(workspaces).where(and(eq(workspaces.ownerId, id), isNull(workspaces.deletedAt)));
    for (const w of ws) {
      await this.db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, w.id));
      await this.rpc.fire({ op: 'workspace.delete', workspaceId: w.id });
    }
  }

  /* ---------------------------------- Équipes ---------------------------------- */

  @Get('teams')
  async teams() {
    const rows = await this.db.execute(sql`
      select t.id, t.name, t.slug, t.created_at,
        (select count(*)::int from team_members m where m.team_id = t.id) as members,
        (select count(*)::int from projects p where p.team_id = t.id and p.deleted_at is null) as projects
      from teams t where t.deleted_at is null order by t.name`);
    return rows.rows;
  }

  @Delete('teams/:teamId')
  @HttpCode(204)
  async deleteTeam(@Param('teamId', uuid) id: string, @CurrentUser() user: AuthUser) {
    const [{ n }] = (await this.db.execute<{ n: number }>(sql`select count(*)::int n from projects where team_id = ${id} and deleted_at is null`)).rows;
    if (n > 0) throw new AppError('conflict', 'L’équipe possède encore des projets');
    await this.db.update(teams).set({ deletedAt: new Date() }).where(eq(teams.id, id));
    await this.audit.record({ actorId: user.id, action: 'admin.team_delete', targetType: 'team', targetId: id });
  }

  /* ------------------------------- Audit & rétention ------------------------------- */

  @Get('audit')
  async auditSearch(@Query({ schema: AuditQuerySchema }) q: z.infer<typeof AuditQuerySchema>): Promise<AuditEventDto[]> {
    const rows = await this.db
      .select()
      .from(auditEvents)
      .where(
        and(
          ...(q.action ? [ilike(auditEvents.action, `${q.action}%`)] : []),
          ...(q.actorId ? [eq(auditEvents.actorId, q.actorId)] : []),
          ...(q.targetId ? [eq(auditEvents.targetId, q.targetId)] : []),
          ...(q.from ? [gte(auditEvents.occurredAt, new Date(q.from))] : []),
          ...(q.to ? [lte(auditEvents.occurredAt, new Date(q.to))] : []),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt))
      .limit(q.limit);
    return rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() }));
  }

  @Get('audit/export')
  async auditExport(@Query({ schema: AuditQuerySchema }) q: z.infer<typeof AuditQuerySchema>, @Res() res: Response, @CurrentUser() user: AuthUser) {
    const rows = await this.auditSearch({ ...q, limit: 500 });
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = ['occurred_at,actor_id,actor_label,action,target_type,target_id,outcome,ip,metadata']
      .concat(rows.map((r) => [r.occurredAt, r.actorId, r.actorLabel, r.action, r.targetType, r.targetId, r.outcome, r.ip, JSON.stringify(r.metadata)].map(esc).join(',')))
      .join('\n');
    await this.audit.record({ actorId: user.id, action: 'admin.audit_export', metadata: q });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit.csv"');
    res.send(csv);
  }

  @Get('retention')
  async retention() {
    const rows = await this.db.select().from(retentionPolicies);
    return RetentionDataTypes.map((t) => {
      const r = rows.find((x) => x.dataType === t);
      return { dataType: t, retentionDays: r?.retentionDays ?? null, legalHold: r?.legalHold ?? false, updatedAt: r?.updatedAt?.toISOString() ?? null };
    });
  }

  @Put('retention')
  async putRetention(@Body({ schema: RetentionPolicySchema }) body: z.infer<typeof RetentionPolicySchema>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.db
      .insert(retentionPolicies)
      .values({ ...body, updatedBy: user.id })
      .onConflictDoUpdate({ target: retentionPolicies.dataType, set: { retentionDays: body.retentionDays, legalHold: body.legalHold, updatedBy: user.id, updatedAt: new Date() } });
    await this.audit.record({ actorId: user.id, action: 'admin.retention', ip: ctx.ip, metadata: body });
    return { ok: true };
  }

  /** Purge de rétention immédiate (exécutée par un worker, sous le même verrou que la purge horaire). */
  @Post('retention/run')
  @HttpCode(202)
  async runRetention(@CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const id = await this.jobs.enqueue('retention.run', { requestedBy: user.id }, { dedupeKey: 'retention.run', maxAttempts: 1 });
    await this.audit.record({ actorId: user.id, action: 'admin.retention_run', ip: ctx.ip });
    return { jobId: id };
  }

  @Get('deletion-jobs')
  async deletionJobs() {
    const { deletionJobs } = await import('@cap/database');
    return this.db.select().from(deletionJobs).orderBy(desc(deletionJobs.createdAt)).limit(200);
  }

  /* --------------------------------- Sandboxes --------------------------------- */

  @Get('sandboxes')
  async sandboxes() {
    return this.db
      .select({ s: sandboxInstances, workspace: workspaces.name, owner: users.displayName })
      .from(sandboxInstances)
      .innerJoin(workspaces, eq(workspaces.id, sandboxInstances.workspaceId))
      .innerJoin(users, eq(users.id, sandboxInstances.ownerId))
      .orderBy(desc(sandboxInstances.createdAt))
      .limit(200);
  }

  /** Arrêt forcé (le checkpoint final est tenté ; `force` détruit même en cas d'échec). */
  @Post('sandboxes/:workspaceId/stop')
  async forceStop(@Param('workspaceId', uuid) id: string, @Body({ schema: z.object({ force: z.boolean().default(false) }) }) body: { force: boolean }, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const r = await this.rpc.call({ op: 'workspace.stop', workspaceId: id, reason: 'administrateur', force: body.force }, 300_000);
    await this.audit.record({ actorId: user.id, action: 'admin.sandbox_stop', targetType: 'workspace', targetId: id, ip: ctx.ip, metadata: { force: body.force } });
    return r;
  }

  @Get('sandbox-images')
  images() {
    return this.db.select().from(sandboxImages).orderBy(desc(sandboxImages.createdAt));
  }

  @Post('sandbox-images')
  async addImage(
    @Body({ schema: z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(50), reference: z.string().min(3).max(300), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), piVersion: z.string().max(30), nodeVersion: z.string().max(30).optional() }) })
    body: { name: string; version: string; reference: string; digest?: string; piVersion: string; nodeVersion?: string },
    @CurrentUser() user: AuthUser,
  ) {
    const [img] = await this.db.insert(sandboxImages).values({ ...body, status: 'candidate' }).returning();
    await this.audit.record({ actorId: user.id, action: 'admin.sandbox_image_add', targetId: img.id, metadata: body });
    return img;
  }

  /**
   * Activation contrôlée (image verrouillée par digest) : proposée aux projets, et image par
   * défaut des nouvelles sandboxes si `makeDefault` (comportement par défaut).
   */
  @Post('sandbox-images/:imageId/activate')
  async activateImage(
    @Param('imageId', uuid) id: string,
    @Body({ schema: z.object({ makeDefault: z.boolean().default(true) }).default({ makeDefault: true }) }) body: { makeDefault: boolean },
    @CurrentUser() user: AuthUser,
  ) {
    const [img] = await this.db.select().from(sandboxImages).where(eq(sandboxImages.id, id));
    if (!img) throw new AppError('not_found', 'Image introuvable');
    if (!img.digest) throw new AppError('validation_failed', 'Une image doit être verrouillée par digest avant activation');
    await this.db.transaction(async (tx) => {
      if (body.makeDefault) await tx.update(sandboxImages).set({ isDefault: false }).where(eq(sandboxImages.isDefault, true));
      await tx.update(sandboxImages).set({ isDefault: body.makeDefault || img.isDefault, status: 'active', verifiedAt: new Date() }).where(eq(sandboxImages.id, id));
    });
    await this.audit.record({ actorId: user.id, action: 'admin.sandbox_image_activate', targetId: id, metadata: { makeDefault: body.makeDefault } });
    return { ok: true };
  }

  /** Retrait : une image dépréciée ou révoquée n'est plus proposée (les projets reviennent au défaut). */
  @Post('sandbox-images/:imageId/status')
  @HttpCode(200)
  async imageStatus(@Param('imageId', uuid) id: string, @Body({ schema: z.object({ status: z.enum(['deprecated', 'revoked']) }) }) body: { status: 'deprecated' | 'revoked' }, @CurrentUser() user: AuthUser) {
    const [img] = await this.db.update(sandboxImages).set({ status: body.status, isDefault: false }).where(eq(sandboxImages.id, id)).returning();
    if (!img) throw new AppError('not_found', 'Image introuvable');
    await this.audit.record({ actorId: user.id, action: `admin.sandbox_image_${body.status}`, targetId: id });
    return { ok: true };
  }

  /* ------------------------------ Secrets & stockage ------------------------------ */

  @Get('secrets')
  async secretsStatus() {
    const health = await this.secrets.health();
    const refs = await this.db.select().from(secretRefs);
    const infra = ['vault:infra/s3', 'vault:infra/litellm', 'vault:infra/smtp', 'vault:infra/preview'];
    const metas = await Promise.all(infra.map(async (r) => ({ ref: r, metadata: await this.secrets.metadata(r).catch(() => null) })));
    return {
      health,
      infrastructure: metas.map((m) => ({ ref: m.ref, configured: !!m.metadata, version: m.metadata?.version ?? null, updatedAt: m.metadata?.updatedAt ?? null })),
      references: refs,
    };
  }

  @Get('storage')
  async storageStatus() {
    const health = await this.storage.health();
    const stats = (
      await this.db.execute(sql`
        select count(distinct workspace_id)::int workspaces, count(*)::int snapshots,
          coalesce(sum(bytes_uploaded),0)::bigint bytes_uploaded,
          (select coalesce(sum(total_bytes),0)::bigint from workspace_snapshots s2 where s2.status='validated' and s2.generation = (select current_generation from workspaces w where w.id = s2.workspace_id)) current_bytes
        from workspace_snapshots where status = 'validated'`)
    ).rows[0];
    const unsynced = await this.db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(eq(workspaces.syncState, 'unsynced'));
    return { health, stats, unsynced };
  }

  /* ------------------------------------ SMTP ------------------------------------ */

  @Get('smtp')
  async smtp() {
    const cfg = await this.secrets.read('vault:infra/smtp').catch(() => null);
    if (!cfg) return { configured: false };
    const { password: _p, ...safe } = cfg;
    return { configured: true, ...safe, passwordSet: !!_p };
  }

  @Put('smtp')
  async putSmtp(@Body({ schema: SmtpConfigSchema }) body: z.infer<typeof SmtpConfigSchema>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const prev = await this.secrets.read('vault:infra/smtp').catch(() => ({}) as Record<string, string>);
    const data: Record<string, string> = {
      host: body.host,
      port: String(body.port),
      secure: String(body.secure),
      fromAddress: body.fromAddress,
      fromName: body.fromName,
      ...(body.username ? { username: body.username } : {}),
      ...(body.password ? { password: body.password } : prev.password ? { password: prev.password } : {}),
    };
    await this.secrets.write('infra/smtp', data);
    await this.audit.record({ actorId: user.id, action: 'admin.smtp_update', ip: ctx.ip, metadata: { host: body.host, port: body.port } });
    return { ok: true };
  }

  @Post('smtp/test')
  async testSmtp(@Body({ schema: z.object({ to: z.email() }) }) body: { to: string }) {
    const id = await this.jobs.enqueue('email.send', { idempotencyKey: `smtp-test:${Date.now()}`, to: body.to, template: 'admin.smtp_test', vars: {} }, { maxAttempts: 1 });
    try {
      await this.jobs.waitForResult(id!, 30_000);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  @Get('email-templates')
  templates() {
    return this.db.select().from(emailTemplates);
  }

  @Put('email-templates/:key')
  async putTemplate(
    @Param('key', { schema: z.string().regex(/^[a-z_.]+$/) }) key: string,
    @Body({ schema: z.object({ subject: z.string().min(1).max(300), bodyText: z.string().min(1).max(20000), bodyHtml: z.string().max(50000).nullable().optional() }) }) body: { subject: string; bodyText: string; bodyHtml?: string | null },
    @CurrentUser() user: AuthUser,
  ) {
    await this.db
      .insert(emailTemplates)
      .values({ key, locale: 'fr', subject: body.subject, bodyText: body.bodyText, bodyHtml: body.bodyHtml ?? null, updatedBy: user.id })
      .onConflictDoUpdate({ target: [emailTemplates.key, emailTemplates.locale], set: { subject: body.subject, bodyText: body.bodyText, bodyHtml: body.bodyHtml ?? null, version: sql`${emailTemplates.version} + 1`, updatedBy: user.id, updatedAt: new Date() } });
    await this.audit.record({ actorId: user.id, action: 'admin.email_template', targetId: key });
    return { ok: true };
  }

  @Get('instances')
  instances() {
    return this.db.select().from(serviceInstances).orderBy(desc(serviceInstances.heartbeatAt));
  }
}
