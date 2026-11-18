import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApprovalDecisionSchema,
  CreatePatConnectionSchema,
  GitCheckoutSchema,
  GitOperationRequestSchema,
  type ApprovalDto,
  type GitBranchesDto,
  type GitConnectionDto,
  type GitOperationRequest,
  type GitStatusDto,
  type RemoteRepositoryDto,
} from '@cap/contracts';
import type { SecretProvider } from '@cap/secrets';
import { gitApprovalRequests, gitConnections, gitOperations, repositories, type Database } from '@cap/database';
import { AppError, AuditService, DB, EventsService, GitProviderClient, GitProviderError, JobFailedError, JobsService, SECRETS, SettingsService } from '@cap/server-core';
import { isUniqueViolation } from '@cap/server-core';
import { CurrentUser, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { SandboxRpcClient } from '../workspaces/sandbox-rpc.client.js';

const uuid = { schema: z.uuid() };

@ApiTags('git')
@Controller('workspaces/:id/git')
export class WorkspaceGitController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly rpc: SandboxRpcClient,
    private readonly jobs: JobsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('status')
  async status(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser): Promise<GitStatusDto> {
    await this.access.requireWorkspaceOwner(user, id);
    const r = await this.rpc.call<Partial<GitStatusDto> & { available: boolean }>({ op: 'git.status', workspaceId: id }, 30_000);
    return {
      available: r.available,
      branch: r.branch ?? null,
      head: r.head ?? null,
      upstream: r.upstream ?? null,
      ahead: r.ahead ?? 0,
      behind: r.behind ?? 0,
      staged: r.staged ?? [],
      unstaged: r.unstaged ?? [],
      untracked: r.untracked ?? [],
      conflicted: r.conflicted ?? [],
      source: r.available ? 'sandbox' : 'unavailable',
    };
  }

  @Get('branches')
  async branches(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser): Promise<GitBranchesDto> {
    await this.access.requireWorkspaceOwner(user, id);
    return this.rpc.call<GitBranchesDto>({ op: 'git.branches', workspaceId: id }, 30_000);
  }

  /** Changement de branche de travail (refusé pendant un run de Pi). */
  @Post('checkout')
  @HttpCode(200)
  async checkout(@Param('id', uuid) id: string, @Body({ schema: GitCheckoutSchema }) body: z.infer<typeof GitCheckoutSchema>, @CurrentUser() user: AuthUser) {
    await this.access.requireWorkspaceOwner(user, id);
    const r = await this.rpc.call<{ ok: boolean; busy?: boolean; branch?: string; output: string }>({ op: 'git.checkout', workspaceId: id, branch: body.branch, userId: user.id }, 180_000);
    if (r.busy) throw new AppError('conflict', r.output);
    if (!r.ok) throw new AppError('validation_failed', r.output.trim() || 'Changement de branche impossible');
    return { branch: r.branch };
  }

  /**
   * Opérations Git initiées par l'utilisateur. Lectures (fetch/pull) exécutées directement ;
   * push, PR/MR, fusion et suppression de branche créent une demande d'approbation.
   */
  @Post('operations')
  async operation(
    @Param('id', uuid) id: string,
    @Body({ schema: GitOperationRequestSchema }) body: GitOperationRequest,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    await this.access.requireWorkspaceOwner(user, id);
    return this.idempotency.run(user.id, idemKey, `POST /workspaces/${id}/git/operations`, body, async () => {
      if (body.action === 'fetch' || body.action === 'pull') {
        return this.rpc.call({ op: body.action === 'fetch' ? 'git.fetch' : 'git.pull', workspaceId: id, ...(body.action === 'pull' && body.branch ? { branch: body.branch } : {}) }, 300_000);
      }
      const jobId = await this.jobs.enqueue('git.prepare', { workspaceId: id, userId: user.id, params: body }, { maxAttempts: 1, priority: 10 });
      try {
        return await this.jobs.waitForResult<{ approvalId: string; summary: string }>(jobId!, 180_000);
      } catch (err) {
        if (err instanceof JobFailedError) throw new AppError('conflict', err.message);
        throw err;
      }
    });
  }

  @Get('approvals')
  async approvals(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser, @Query('status', { schema: z.enum(['pending', 'all']).default('all') }) status: string): Promise<ApprovalDto[]> {
    await this.access.requireWorkspaceOwner(user, id);
    const rows = await this.db
      .select({ a: gitApprovalRequests, repo: repositories.fullName, op: gitOperations })
      .from(gitApprovalRequests)
      .leftJoin(repositories, eq(repositories.id, gitApprovalRequests.repositoryId))
      .leftJoin(gitOperations, eq(gitOperations.approvalId, gitApprovalRequests.id))
      .where(and(eq(gitApprovalRequests.workspaceId, id), ...(status === 'pending' ? [eq(gitApprovalRequests.status, 'pending')] : [])))
      .orderBy(desc(gitApprovalRequests.createdAt))
      .limit(100);
    return rows.map(({ a, repo, op }) => toApprovalDto(a, repo ?? '', op));
  }
}

export function toApprovalDto(a: typeof gitApprovalRequests.$inferSelect, repo: string, op: typeof gitOperations.$inferSelect | null): ApprovalDto {
  const p = a.params as Record<string, unknown>;
  return {
    id: a.id,
    workspaceId: a.workspaceId,
    action: a.action,
    status: a.status,
    requestedBy: a.requestedBy,
    toolCallId: a.toolCallExternalId || null,
    repository: repo,
    target: a.target,
    commitSha: a.commitSha,
    commits: a.commits,
    diffStat: a.diffStat,
    patchPreview: a.patchPreview,
    title: (p.title as string) ?? null,
    body: (p.body as string) ?? null,
    expiresAt: a.expiresAt.toISOString(),
    decidedAt: a.decidedAt?.toISOString() ?? null,
    decidedBy: a.decidedBy,
    createdAt: a.createdAt.toISOString(),
    operation: op ? { id: op.id, status: op.status, result: op.result ? JSON.stringify(op.result) : op.error } : null,
  };
}

/** Décision d'approbation : uniquement le propriétaire du workspace ; usage unique ; auditée. */
@ApiTags('git')
@Controller('approvals')
export class ApprovalsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly jobs: JobsService,
    private readonly events: EventsService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get(':approvalId')
  async get(@Param('approvalId', uuid) approvalId: string, @CurrentUser() user: AuthUser): Promise<ApprovalDto> {
    const [a] = await this.db.select().from(gitApprovalRequests).where(eq(gitApprovalRequests.id, approvalId));
    if (!a) throw new AppError('not_found', 'Approbation introuvable');
    await this.access.requireWorkspaceOwner(user, a.workspaceId);
    const [repo] = a.repositoryId ? await this.db.select({ n: repositories.fullName }).from(repositories).where(eq(repositories.id, a.repositoryId)) : [];
    const [op] = await this.db.select().from(gitOperations).where(eq(gitOperations.approvalId, a.id));
    return toApprovalDto(a, repo?.n ?? '', op ?? null);
  }

  @Post(':approvalId/decision')
  @HttpCode(200)
  async decide(
    @Param('approvalId', uuid) approvalId: string,
    @Body({ schema: ApprovalDecisionSchema }) body: z.infer<typeof ApprovalDecisionSchema>,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const [a] = await this.db.select().from(gitApprovalRequests).where(eq(gitApprovalRequests.id, approvalId));
    if (!a) throw new AppError('not_found', 'Approbation introuvable');
    await this.access.requireWorkspaceOwner(user, a.workspaceId);
    if (a.requesterId !== user.id) throw new AppError('forbidden', 'Seul le propriétaire du workspace peut décider');
    return this.idempotency.run(user.id, idemKey, `POST /approvals/${approvalId}/decision`, body, async () => {
      const status = body.decision === 'approve' ? 'approved' : 'rejected';
      // Transition atomique : une décision unique, avant expiration.
      const res = await this.db
        .update(gitApprovalRequests)
        .set({ status, decidedAt: new Date(), decidedBy: user.id, decisionComment: body.comment ?? null })
        .where(and(eq(gitApprovalRequests.id, approvalId), eq(gitApprovalRequests.status, 'pending'), sql`${gitApprovalRequests.expiresAt} > now()`))
        .returning();
      if (res.length === 0) {
        const [cur] = await this.db.select({ s: gitApprovalRequests.status, e: gitApprovalRequests.expiresAt }).from(gitApprovalRequests).where(eq(gitApprovalRequests.id, approvalId));
        if (cur.s === 'pending' && cur.e <= new Date()) throw new AppError('approval_expired', 'Demande expirée');
        throw new AppError('approval_already_decided', 'Demande déjà traitée');
      }
      await this.audit.record({ actorId: user.id, action: `git.approval_${status}`, targetType: 'git_approval', targetId: approvalId, ip: ctx.ip, metadata: { action: a.action, target: a.target, commitSha: a.commitSha } });
      await this.events.emit(a.workspaceId, 'approval.resolved', { approvalId, decision: status === 'approved' ? 'approved' : 'rejected' });
      if (status === 'approved') {
        await this.jobs.enqueue('git.execute', { approvalId }, { dedupeKey: `git-exec:${approvalId}`, maxAttempts: 1 });
      } else {
        await this.db.update(gitOperations).set({ status: 'rejected', finishedAt: new Date() }).where(eq(gitOperations.approvalId, approvalId));
      }
      return { status };
    });
  }
}

/** Connexions Git de l'utilisateur, indépendantes de sa méthode de login (SPEC §4.1). */
@ApiTags('git')
@Controller('me/git-connections')
export class GitConnectionsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly git: GitProviderClient,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<GitConnectionDto[]> {
    const rows = await this.db
      .select()
      .from(gitConnections)
      .where(and(eq(gitConnections.userId, user.id), isNull(gitConnections.revokedAt)))
      .orderBy(desc(gitConnections.createdAt));
    return rows.map((c) => ({
      id: c.id,
      provider: c.provider,
      host: c.host,
      accountLogin: c.accountLogin,
      accountName: c.accountName,
      scopes: c.scopes,
      status: c.status,
      createdAt: c.createdAt.toISOString(),
      lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
    }));
  }

  /** Rattachement par jeton d'accès personnel (validé auprès de la forge, stocké dans Vault). */
  @Post('token')
  async addToken(@Body({ schema: CreatePatConnectionSchema }) body: z.infer<typeof CreatePatConnectionSchema>, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    // Par défaut, les comptes Git se rattachent par OAuth via les forges configurées par l'administrateur.
    if (!(await this.settings.section('git')).allowPersonalTokens) {
      throw new AppError('forbidden', 'Les jetons d’accès personnels sont désactivés : connectez votre compte via OAuth');
    }
    const host = body.provider === 'github' ? 'github.com' : body.provider === 'gitlab' ? 'gitlab.com' : body.host.toLowerCase();
    let who;
    try {
      who = await this.git.whoAmI(body.provider, host, body.token);
    } catch (err) {
      throw new AppError('validation_failed', err instanceof GitProviderError ? err.message : 'Jeton invalide');
    }
    const [row] = await this.db
      .insert(gitConnections)
      .values({
        userId: user.id,
        provider: body.provider,
        host,
        accountId: who.id,
        accountLogin: who.login,
        accountName: who.name,
        scopes: who.scopes,
        secretRef: 'pending',
        authType: 'pat',
      })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError('conflict', 'Ce compte est déjà rattaché');
        throw err;
      });
    const ref = await this.secrets.write(`git-connections/${row.id}`, { accessToken: body.token });
    await this.db.update(gitConnections).set({ secretRef: ref }).where(eq(gitConnections.id, row.id));
    await this.audit.record({ actorId: user.id, action: 'git.connection_add', targetType: 'git_connection', targetId: row.id, ip: ctx.ip, metadata: { host, login: who.login } });
    return { id: row.id, accountLogin: who.login };
  }

  @Delete(':connectionId')
  @HttpCode(204)
  async remove(@Param('connectionId', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const [c] = await this.db.select().from(gitConnections).where(and(eq(gitConnections.id, id), eq(gitConnections.userId, user.id), isNull(gitConnections.revokedAt)));
    if (!c) throw new AppError('not_found', 'Connexion introuvable');
    await this.db.update(gitConnections).set({ revokedAt: new Date(), status: 'revoked' }).where(eq(gitConnections.id, id));
    await this.secrets.revoke(c.secretRef).catch(() => undefined);
    await this.audit.record({ actorId: user.id, action: 'git.connection_remove', targetType: 'git_connection', targetId: id, ip: ctx.ip });
  }

  @Get(':connectionId/repositories')
  async repositories(@Param('connectionId', uuid) id: string, @CurrentUser() user: AuthUser, @Query('q', { schema: z.string().max(100).optional() }) q?: string): Promise<RemoteRepositoryDto[]> {
    const conn = await this.git.connection(id, user.id);
    try {
      return await this.git.listRepositories(conn, q);
    } catch (err) {
      throw new AppError('conflict', `Forge : ${(err as Error).message}`);
    }
  }

  @Get(':connectionId/branches')
  async branches(@Param('connectionId', uuid) id: string, @CurrentUser() user: AuthUser, @Query('repo', { schema: z.string().min(1).max(400) }) repo: string): Promise<string[]> {
    const conn = await this.git.connection(id, user.id);
    return this.git.listBranches(conn, repo);
  }
}
