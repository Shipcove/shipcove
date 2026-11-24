import { createHash } from 'node:crypto';
import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, count, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { UpsertGitForgeSchema, type GitForgeAdminDto, type GitForgesPublicDto, type GitProviderKind, type UpsertGitForge } from '@cap/contracts';
import { gitConnections, gitForges, gitOauthFlows, type Database } from '@cap/database';
import type { SecretProvider } from '@cap/secrets';
import { AppError, AuditService, DB, ENV, GitProviderClient, GitProviderError, SECRETS, SettingsService, isUniqueViolation, randomToken, sha256Hex } from '@cap/server-core';
import { CurrentUser, PlatformAdmin, Public, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AppRequest, AuthUser } from '../common/request.js';
import type { ApiEnv } from '../env.js';

const uuid = { schema: z.uuid() };
const FLOW_TTL_MS = 10 * 60_000;
type Forge = typeof gitForges.$inferSelect;

/** Les offres SaaS ont un hôte fixe. */
function normalizeHost(provider: GitProviderKind, host: string): string {
  if (provider === 'github') return 'github.com';
  if (provider === 'gitlab') return 'gitlab.com';
  return host.toLowerCase();
}

function safeReturnTo(v: string | undefined): string {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || /[\r\n]/.test(v)) return '/settings/git';
  return v.slice(0, 500);
}

/**
 * Forges Git (SPEC §8) : l'administrateur déclare une application OAuth par forge ; les
 * utilisateurs rattachent leurs comptes par OAuth (PKCE + state), jetons dans Vault, renouvelés
 * automatiquement. Le jeton personnel n'est accepté que si l'administrateur l'autorise.
 */
@Injectable()
export class GitForgesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly git: GitProviderClient,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  callbackUrl(forgeId: string): string {
    return `${this.env.PUBLIC_URL.replace(/\/$/, '')}/api/v1/me/git-connections/oauth/${forgeId}/callback`;
  }

  async adminDto(f: Forge): Promise<GitForgeAdminDto> {
    const [{ n }] = await this.db.select({ n: count() }).from(gitConnections).where(and(eq(gitConnections.forgeId, f.id), isNull(gitConnections.revokedAt)));
    return {
      id: f.id,
      provider: f.provider,
      name: f.name,
      host: f.host,
      clientId: f.clientId,
      enabled: f.enabled,
      secretConfigured: !!f.secretRef,
      callbackUrl: this.callbackUrl(f.id),
      scopes: this.git.oauthScopes(f.provider),
      connections: n,
      lastTestAt: f.lastTestAt?.toISOString() ?? null,
      lastTestResult: f.lastTestResult,
    };
  }

  async upsert(id: string | null, body: UpsertGitForge, actorId: string | null, ctx: RequestContext): Promise<GitForgeAdminDto> {
    const host = normalizeHost(body.provider, body.host);
    let row: Forge;
    try {
      if (id) {
        const [prev] = await this.db.select().from(gitForges).where(eq(gitForges.id, id));
        if (!prev) throw new AppError('not_found', 'Forge introuvable');
        if (prev.provider !== body.provider || prev.host !== host) throw new AppError('validation_failed', 'Le type et l’hôte d’une forge ne peuvent pas changer (créez-en une autre)');
        [row] = await this.db.update(gitForges).set({ name: body.name, clientId: body.clientId, enabled: body.enabled, updatedAt: new Date() }).where(eq(gitForges.id, id)).returning();
      } else {
        [row] = await this.db.insert(gitForges).values({ provider: body.provider, name: body.name, host, clientId: body.clientId, enabled: body.enabled }).returning();
      }
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', `Une forge est déjà déclarée pour ${host}`);
      throw e;
    }
    if (body.clientSecret) {
      const ref = await this.secrets.write(`oauth-apps/${row.id}`, { clientSecret: body.clientSecret });
      [row] = await this.db.update(gitForges).set({ secretRef: ref }).where(eq(gitForges.id, row.id)).returning();
    }
    if (row.enabled && !row.secretRef) {
      [row] = await this.db.update(gitForges).set({ enabled: false }).where(eq(gitForges.id, row.id)).returning();
      throw new AppError('validation_failed', 'Secret client requis pour activer la forge');
    }
    await this.audit.record({ actorId, action: id ? 'admin.git_forge_update' : 'admin.git_forge_create', targetType: 'git_forge', targetId: row.id, ip: ctx.ip, metadata: { provider: row.provider, host: row.host, enabled: row.enabled, secretUpdated: !!body.clientSecret } });
    return this.adminDto(row);
  }

  /** Suppression : les connexions issues de cette forge sont révoquées (jetons supprimés de Vault). */
  async remove(id: string, actorId: string, ctx: RequestContext): Promise<void> {
    const [f] = await this.db.select().from(gitForges).where(eq(gitForges.id, id));
    if (!f) throw new AppError('not_found', 'Forge introuvable');
    const conns = await this.db.select().from(gitConnections).where(and(eq(gitConnections.forgeId, id), isNull(gitConnections.revokedAt)));
    for (const c of conns) {
      await this.db.update(gitConnections).set({ status: 'revoked', revokedAt: new Date() }).where(eq(gitConnections.id, c.id));
      await this.secrets.revoke(c.secretRef).catch(() => undefined);
    }
    if (f.secretRef) await this.secrets.revoke(f.secretRef).catch(() => undefined);
    await this.db.delete(gitForges).where(eq(gitForges.id, id));
    await this.audit.record({ actorId, action: 'admin.git_forge_delete', targetType: 'git_forge', targetId: id, ip: ctx.ip, metadata: { host: f.host, revokedConnections: conns.length } });
  }

  /**
   * Test : forge joignable et identifiants client valides. Un code d'autorisation factice est
   * présenté au point de jeton : « code invalide » prouve que le client est reconnu,
   * « client invalide » signale un identifiant ou un secret erroné.
   */
  async test(id: string, actorId: string): Promise<{ ok: boolean; detail: string }> {
    const [f] = await this.db.select().from(gitForges).where(eq(gitForges.id, id));
    if (!f) throw new AppError('not_found', 'Forge introuvable');
    let result: { ok: boolean; detail: string };
    try {
      await this.git.exchangeCode(f, `cap-test-${randomToken(8)}`, this.callbackUrl(f.id), randomToken(32));
      result = { ok: false, detail: 'Réponse inattendue de la forge (code factice accepté)' };
    } catch (e) {
      const msg = (e as Error).message;
      if (/incorrect_client_credentials|invalid_client|client authentication failed|unauthorized_client/i.test(msg)) result = { ok: false, detail: `Identifiants client refusés par la forge : ${msg}` };
      else if (/bad_verification_code|invalid_grant|redirect_uri_mismatch/i.test(msg)) {
        result = /redirect_uri_mismatch/i.test(msg)
          ? { ok: false, detail: `URL de rappel non déclarée dans l’application OAuth : ${this.callbackUrl(f.id)}` }
          : { ok: true, detail: `Forge ${f.host} joignable ; application OAuth reconnue (identifiant et secret valides)` };
      } else result = { ok: false, detail: msg };
    }
    await this.db.update(gitForges).set({ lastTestAt: new Date(), lastTestResult: `${result.ok ? 'OK' : 'Échec'} — ${result.detail}`.slice(0, 1000) }).where(eq(gitForges.id, id));
    await this.audit.record({ actorId, action: 'admin.git_forge_test', targetType: 'git_forge', targetId: id, outcome: result.ok ? 'success' : 'failure' });
    return result;
  }

  /* ----------------------------- Utilisateur ----------------------------- */

  async publicList(): Promise<GitForgesPublicDto> {
    const rows = await this.db.select().from(gitForges).where(eq(gitForges.enabled, true)).orderBy(gitForges.name);
    const { allowPersonalTokens } = await this.settings.section('git');
    return { forges: rows.map((f) => ({ id: f.id, provider: f.provider, name: f.name, host: f.host })), allowPersonalTokens };
  }

  async start(forgeId: string, userId: string, returnTo: string | undefined): Promise<string> {
    const [f] = await this.db.select().from(gitForges).where(and(eq(gitForges.id, forgeId), eq(gitForges.enabled, true)));
    if (!f) throw new AppError('not_found', 'Forge introuvable ou désactivée');
    const state = randomToken(32);
    const verifier = randomToken(48);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await this.db.delete(gitOauthFlows).where(lt(gitOauthFlows.expiresAt, sql`now() - interval '1 day'`));
    await this.db.insert(gitOauthFlows).values({ forgeId, userId, stateHash: sha256Hex(state), codeVerifier: verifier, returnTo: safeReturnTo(returnTo), expiresAt: new Date(Date.now() + FLOW_TTL_MS) });
    return this.git.authorizeUrl(f, this.callbackUrl(f.id), state, challenge);
  }

  /** Retour de la forge : flux à usage unique, lié à l'utilisateur connecté qui l'a lancé. */
  async callback(forgeId: string, userId: string, q: { state?: string; code?: string; error?: string }, ctx: RequestContext): Promise<string> {
    if (!q.state) throw new AppError('validation_failed', 'state absent');
    const [flow] = await this.db
      .update(gitOauthFlows)
      .set({ usedAt: new Date() })
      .where(and(eq(gitOauthFlows.stateHash, sha256Hex(q.state)), eq(gitOauthFlows.forgeId, forgeId), eq(gitOauthFlows.userId, userId), isNull(gitOauthFlows.usedAt), gt(gitOauthFlows.expiresAt, sql`now()`)))
      .returning();
    if (!flow) throw new AppError('validation_failed', 'Demande de connexion expirée, déjà utilisée ou lancée par un autre compte');
    if (q.error || !q.code) throw new AppError('forbidden', `Autorisation refusée par la forge (${q.error ?? 'code absent'})`);
    const [f] = await this.db.select().from(gitForges).where(and(eq(gitForges.id, forgeId), eq(gitForges.enabled, true)));
    if (!f) throw new AppError('not_found', 'Forge introuvable ou désactivée');
    const tokens = await this.git.exchangeCode(f, q.code, this.callbackUrl(f.id), flow.codeVerifier);
    const who = await this.git.whoAmI(f.provider, f.host, tokens.accessToken);
    const secret = { accessToken: tokens.accessToken, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}) };
    const [existing] = await this.db
      .select()
      .from(gitConnections)
      .where(and(eq(gitConnections.userId, userId), eq(gitConnections.host, f.host), eq(gitConnections.accountId, who.id), isNull(gitConnections.revokedAt)));
    let connectionId: string;
    if (existing) {
      // Reconnexion du même compte : nouveaux jetons, connexion réactivée.
      await this.secrets.write(`git-connections/${existing.id}`, secret);
      await this.db
        .update(gitConnections)
        .set({ authType: 'oauth', forgeId: f.id, status: 'active', tokenExpiresAt: tokens.expiresAt, scopes: tokens.scopes.length ? tokens.scopes : who.scopes, accountLogin: who.login, accountName: who.name })
        .where(eq(gitConnections.id, existing.id));
      connectionId = existing.id;
    } else {
      const [row] = await this.db
        .insert(gitConnections)
        .values({ userId, provider: f.provider, host: f.host, accountId: who.id, accountLogin: who.login, accountName: who.name, scopes: tokens.scopes.length ? tokens.scopes : who.scopes, secretRef: 'pending', authType: 'oauth', forgeId: f.id, tokenExpiresAt: tokens.expiresAt })
        .returning();
      const ref = await this.secrets.write(`git-connections/${row.id}`, secret);
      await this.db.update(gitConnections).set({ secretRef: ref }).where(eq(gitConnections.id, row.id));
      connectionId = row.id;
    }
    await this.audit.record({ actorId: userId, action: 'git.connection_oauth', targetType: 'git_connection', targetId: connectionId, ip: ctx.ip, metadata: { host: f.host, login: who.login } });
    return flow.returnTo;
  }
}

@ApiTags('git')
@Controller('admin/git-forges')
@PlatformAdmin()
export class AdminGitForgesController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly forges: GitForgesService,
  ) {}

  @Get()
  async list(): Promise<GitForgeAdminDto[]> {
    const rows = await this.db.select().from(gitForges).orderBy(gitForges.name);
    return Promise.all(rows.map((f) => this.forges.adminDto(f)));
  }

  @Post()
  create(@Body({ schema: UpsertGitForgeSchema }) body: UpsertGitForge, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.forges.upsert(null, body, user.id, ctx);
  }

  @Put(':id')
  update(@Param('id', uuid) id: string, @Body({ schema: UpsertGitForgeSchema }) body: UpsertGitForge, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    return this.forges.upsert(id, body, user.id, ctx);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser) {
    return this.forges.test(id, user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.forges.remove(id, user.id, ctx);
  }
}

/** Rattachement d'un compte Git par OAuth (navigation pleine page : redirections). */
@ApiTags('git')
@Controller('me/git-connections/oauth')
export class GitOAuthController {
  constructor(private readonly forges: GitForgesService) {}

  @Get('providers')
  providers(): Promise<GitForgesPublicDto> {
    return this.forges.publicList();
  }

  @Public()
  @Get(':forgeId/start')
  async start(@Param('forgeId', uuid) forgeId: string, @Req() req: AppRequest, @Res() res: Response, @Query('returnTo') returnTo?: string): Promise<void> {
    if (!req.user) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/settings/git')}`);
    try {
      res.redirect(302, await this.forges.start(forgeId, req.user.id, returnTo));
    } catch (e) {
      res.redirect(303, `/settings/git?git_error=${encodeURIComponent(errorCode(e))}`);
    }
  }

  @Public()
  @Get(':forgeId/callback')
  async callback(
    @Param('forgeId', uuid) forgeId: string,
    @Req() req: AppRequest,
    @Res() res: Response,
    @ReqCtx() ctx: RequestContext,
    @Query() q: { state?: string; code?: string; error?: string },
  ): Promise<void> {
    if (!req.user) return res.redirect(303, `/auth/login?next=${encodeURIComponent('/settings/git')}`);
    try {
      const returnTo = await this.forges.callback(forgeId, req.user.id, { state: q.state, code: q.code, error: q.error }, ctx);
      res.redirect(303, `${returnTo}${returnTo.includes('?') ? '&' : '?'}git_linked=1`);
    } catch (e) {
      res.redirect(303, `/settings/git?git_error=${encodeURIComponent(errorCode(e))}`);
    }
  }
}

/** Code stable transmis à l'interface (jamais de détail technique dans l'URL). */
function errorCode(e: unknown): string {
  if (e instanceof AppError) return e.code === 'conflict' ? 'account_conflict' : e.code === 'forbidden' ? 'denied' : e.code === 'not_found' ? 'forge_unavailable' : 'expired';
  if (e instanceof GitProviderError) return 'forge_error';
  return 'failed';
}
