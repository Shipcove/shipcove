import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { CreateWorkspaceSchema, UpdateWorkspaceSchema, type CreateWorkspace, type WorkspaceDto } from '@cap/contracts';
import { agentRuns, conversationShares, conversations, workspaces, type Database } from '@cap/database';
import { AppError, AuditService, DB, EventsService } from '@cap/server-core';
import { CurrentUser, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';
import { SandboxRpcClient } from './sandbox-rpc.client.js';
import { DEFAULT_TITLE, WorkspacesService } from './workspaces.service.js';

const uuid = { schema: z.uuid() };

@ApiTags('workspaces')
@Controller('workspaces')
export class WorkspacesController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly rpc: SandboxRpcClient,
    private readonly service: WorkspacesService,
    private readonly events: EventsService,
  ) {}

  /** Mes conversations, puis celles qui me sont partagées en lecture ; les plus récentes d'abord. */
  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<WorkspaceDto[]> {
    const own = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.ownerId, user.id), isNull(workspaces.deletedAt)))
      .orderBy(desc(sql`coalesce(${workspaces.lastActivityAt}, ${workspaces.createdAt})`));
    const out: WorkspaceDto[] = [];
    for (const w of own) out.push(await this.service.toDto(w, 'owner'));
    const shared = await this.db
      .select({ w: workspaces })
      .from(conversationShares)
      .innerJoin(conversations, eq(conversations.id, conversationShares.conversationId))
      .innerJoin(workspaces, eq(workspaces.id, conversations.workspaceId))
      .where(and(eq(conversationShares.userId, user.id), isNull(conversationShares.revokedAt), isNull(workspaces.deletedAt)));
    for (const { w } of shared) out.push(await this.service.toDto(w, 'shared_read'));
    return out;
  }

  /** Nouvelle conversation, éventuellement sur un dépôt Git (lu avec la connexion de l'utilisateur). */
  @Post()
  async create(@Body({ schema: CreateWorkspaceSchema }) body: CreateWorkspace, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<WorkspaceDto> {
    if (body.modelId) await this.service.assertModelAllowed(body.modelId, user.id);
    const w = await this.db.transaction(async (tx) => {
      const repo = body.repository ? await this.service.resolveRepository(tx, user, body.repository) : null;
      const [w] = await tx
        .insert(workspaces)
        .values({
          ownerId: user.id,
          name: body.name ?? DEFAULT_TITLE,
          titleSource: body.name ? 'user' : 'auto',
          repositoryId: repo?.repositoryId ?? null,
          gitConnectionId: repo?.gitConnectionId ?? null,
          branch: repo?.branch ?? null,
          modelId: body.modelId ?? null,
          ...(body.agentMode ? { agentMode: body.agentMode } : {}),
          ...(body.thinkingLevel ? { thinkingLevel: body.thinkingLevel } : {}),
        })
        .returning();
      // Une seule conversation fonctionnelle par workspace (contrainte d'unicité en base).
      await tx.insert(conversations).values({ workspaceId: w.id, ownerId: user.id });
      await this.audit.record({ actorId: user.id, action: 'workspace.create', targetType: 'workspace', targetId: w.id, ip: ctx.ip, metadata: { repository: body.repository?.fullName ?? null } }, tx);
      return w;
    });
    return this.service.toDto(w, 'owner');
  }

  @Get(':id')
  async get(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser): Promise<WorkspaceDto> {
    const { workspace, access } = await this.access.requireWorkspaceRead(user, id);
    return this.service.toDto(workspace, access);
  }

  @Patch(':id')
  async update(@Param('id', uuid) id: string, @Body({ schema: UpdateWorkspaceSchema }) body: z.infer<typeof UpdateWorkspaceSchema>, @CurrentUser() user: AuthUser): Promise<WorkspaceDto> {
    await this.access.requireWorkspaceOwner(user, id);
    if (body.modelId) {
      const m = await this.service.assertModelAllowed(body.modelId, user.id);
      await this.events.emit(id, 'model.changed', { modelId: m.id, modelName: m.displayName });
    }
    // Un titre choisi par l'utilisateur n'est plus jamais remplacé automatiquement.
    const [u] = await this.db
      .update(workspaces)
      .set({ ...body, ...(body.name ? { titleSource: 'user' as const } : {}), updatedAt: new Date() })
      .where(eq(workspaces.id, id))
      .returning();
    if (body.name) await this.events.emit(id, 'workspace.renamed', { name: u.name, titleSource: 'user' });
    return this.service.toDto(u, 'owner');
  }

  /** Démarrage (restauration du dernier checkpoint) : suivi via SSE `workspace.status`. */
  @Post(':id/start')
  @HttpCode(202)
  async start(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser) {
    const w = await this.access.requireWorkspaceOwner(user, id);
    if (w.status === 'archived') throw new AppError('conflict', 'Workspace archivé');
    await this.rpc.fire({ op: 'workspace.start', workspaceId: id }, `start:${id}`);
    return { status: 'starting' };
  }

  /** Mise en veille logique : checkpoint final puis destruction de la sandbox. */
  @Post(':id/stop')
  @HttpCode(202)
  async stop(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser) {
    await this.access.requireWorkspaceOwner(user, id);
    await this.assertNoActiveRun(id);
    await this.rpc.fire({ op: 'workspace.stop', workspaceId: id, reason: 'utilisateur' }, `stop:${id}`);
    return { status: 'stopping' };
  }

  @Post(':id/archive')
  @HttpCode(204)
  async archive(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.access.requireWorkspaceOwner(user, id);
    await this.assertNoActiveRun(id);
    const r = await this.rpc.call<{ stopped: boolean; detail: string }>({ op: 'workspace.stop', workspaceId: id, reason: 'archivage' }, 300_000);
    if (!r.stopped) throw new AppError('conflict', `Archivage impossible : ${r.detail}`);
    await this.db.update(workspaces).set({ status: 'archived', archivedAt: new Date() }).where(eq(workspaces.id, id));
    await this.audit.record({ actorId: user.id, action: 'workspace.archive', targetType: 'workspace', targetId: id, ip: ctx.ip });
  }

  @Post(':id/unarchive')
  @HttpCode(204)
  async unarchive(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser) {
    await this.access.requireWorkspaceOwner(user, id);
    await this.db.update(workspaces).set({ status: 'ready', archivedAt: null }).where(eq(workspaces.id, id));
  }

  /** Suppression : logique immédiate puis définitive (fichiers, checkpoints, conversation) par le worker. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.access.requireWorkspaceOwner(user, id);
    await this.assertNoActiveRun(id);
    await this.db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, id));
    await this.rpc.fire({ op: 'workspace.delete', workspaceId: id });
    await this.audit.record({ actorId: user.id, action: 'workspace.delete', targetType: 'workspace', targetId: id, ip: ctx.ip });
  }

  private async assertNoActiveRun(id: string) {
    const [r] = await this.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspaceId, id), inArray(agentRuns.status, ['queued', 'running', 'interrupting'])));
    if (r) throw new AppError('run_already_active', 'Un run est en cours : interrompez-le d’abord');
  }
}
