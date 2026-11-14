import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AttachRepositorySchema,
  CreateProjectSchema,
  UpdateProjectSchema,
  type CreateProject,
  type ProjectDto,
  type RepositoryDto,
  type RepositoryRef,
} from '@cap/contracts';
import { projects, repositories, teamMembers, teams, workspaces, type Database, type DbOrTx } from '@cap/database';
import { AppError, AuditService, DB, GitProviderClient, GitProviderError } from '@cap/server-core';
import { isUniqueViolation } from '@cap/server-core';
import { CurrentUser, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';

const uuid = { schema: z.uuid() };

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly git: GitProviderClient,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('teamId', { schema: z.uuid().optional() }) teamId?: string): Promise<ProjectDto[]> {
    const myTeams = await this.db.select({ teamId: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, user.id));
    const ids = myTeams.map((t) => t.teamId).filter((id) => !teamId || id === teamId);
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({ p: projects, teamName: teams.name, repo: repositories })
      .from(projects)
      .innerJoin(teams, eq(teams.id, projects.teamId))
      .leftJoin(repositories, eq(repositories.id, projects.repositoryId))
      .where(and(inArray(projects.teamId, ids), isNull(projects.deletedAt), isNull(teams.deletedAt)))
      .orderBy(projects.name);
    const counts = await this.workspaceCounts(user.id, rows.map((r) => r.p.id));
    return rows.map((r) => this.toDto(r.p, r.teamName, r.repo, counts.get(r.p.id) ?? 0));
  }

  @Post()
  async create(@Body({ schema: CreateProjectSchema }) body: CreateProject, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<ProjectDto> {
    await this.access.requireTeamMember(user, body.teamId);
    const p = await this.db.transaction(async (tx) => {
      const repositoryId = body.repository ? await this.upsertRepository(tx, user, body.repository) : null;
      const [p] = await tx
        .insert(projects)
        .values({
          teamId: body.teamId,
          name: body.name,
          description: body.description ?? null,
          repositoryId,
          defaultGitConnectionId: body.repository?.gitConnectionId ?? null,
          createdBy: user.id,
        })
        .returning()
        .catch((err: unknown) => {
          if (isUniqueViolation(err)) throw new AppError('conflict', 'Un projet porte déjà ce nom dans l’équipe');
          throw err;
        });
      await this.audit.record({ actorId: user.id, action: 'project.create', targetType: 'project', targetId: p.id, ip: ctx.ip, metadata: { teamId: body.teamId, repository: body.repository?.fullName ?? null } }, tx);
      return p;
    });
    return this.get(p.id, user);
  }

  @Get(':projectId')
  async get(@Param('projectId', uuid) projectId: string, @CurrentUser() user: AuthUser): Promise<ProjectDto> {
    const p = await this.access.requireProject(user, projectId, 'read');
    const [team] = await this.db.select({ name: teams.name }).from(teams).where(eq(teams.id, p.teamId));
    const [repo] = p.repositoryId ? await this.db.select().from(repositories).where(eq(repositories.id, p.repositoryId)) : [];
    const counts = await this.workspaceCounts(user.id, [p.id]);
    return this.toDto(p, team.name, repo ?? null, counts.get(p.id) ?? 0);
  }

  @Patch(':projectId')
  async update(
    @Param('projectId', uuid) projectId: string,
    @Body({ schema: UpdateProjectSchema }) body: z.infer<typeof UpdateProjectSchema>,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ProjectDto> {
    await this.access.requireProject(user, projectId, 'admin');
    await this.db.update(projects).set({ ...body, updatedAt: new Date() }).where(eq(projects.id, projectId));
    await this.audit.record({ actorId: user.id, action: 'project.update', targetType: 'project', targetId: projectId, ip: ctx.ip, metadata: body });
    return this.get(projectId, user);
  }

  /** Ajout ultérieur d'un dépôt à un projet vierge. */
  @Put(':projectId/repository')
  async attachRepository(
    @Param('projectId', uuid) projectId: string,
    @Body({ schema: AttachRepositorySchema }) body: RepositoryRef,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ProjectDto> {
    const p = await this.access.requireProject(user, projectId, 'admin');
    if (p.repositoryId) throw new AppError('conflict', 'Ce projet possède déjà un dépôt');
    await this.db.transaction(async (tx) => {
      const repositoryId = await this.upsertRepository(tx, user, body);
      await tx.update(projects).set({ repositoryId, defaultGitConnectionId: body.gitConnectionId, updatedAt: new Date() }).where(eq(projects.id, projectId));
      await this.audit.record({ actorId: user.id, action: 'project.repository_attach', targetType: 'project', targetId: projectId, ip: ctx.ip, metadata: { repository: body.fullName } }, tx);
    });
    return this.get(projectId, user);
  }

  @Post(':projectId/archive')
  @HttpCode(204)
  async archive(@Param('projectId', uuid) projectId: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.access.requireProject(user, projectId, 'admin');
    await this.db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, projectId));
    await this.audit.record({ actorId: user.id, action: 'project.archive', targetType: 'project', targetId: projectId, ip: ctx.ip });
  }

  @Delete(':projectId')
  @HttpCode(204)
  async remove(@Param('projectId', uuid) projectId: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.access.requireProject(user, projectId, 'admin');
    const [{ n }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaces)
      .where(and(eq(workspaces.projectId, projectId), isNull(workspaces.deletedAt)));
    if (n > 0) throw new AppError('conflict', 'Supprimez d’abord les workspaces du projet');
    await this.db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, projectId));
    await this.audit.record({ actorId: user.id, action: 'project.delete', targetType: 'project', targetId: projectId, ip: ctx.ip });
  }

  private async upsertRepository(tx: DbOrTx, user: AuthUser, ref: RepositoryRef): Promise<string> {
    const conn = await this.git.connection(ref.gitConnectionId, user.id);
    let meta;
    try {
      meta = await this.git.getRepository(conn, ref.fullName);
    } catch (err) {
      if (err instanceof GitProviderError) throw new AppError('not_found', `Dépôt inaccessible avec cette connexion (${err.message})`);
      throw err;
    }
    // Le jeton de la connexion sera présenté à cette URL : même hôte que la connexion, transport autorisé.
    const clone = await this.git.assertTransport(meta.cloneUrl);
    if (clone.host.toLowerCase() !== conn.host.toLowerCase()) {
      throw new AppError('validation_failed', `URL de clonage sur un hôte inattendu (${clone.host}, connexion ${conn.host})`);
    }
    const [row] = await tx
      .insert(repositories)
      .values({
        provider: meta.provider,
        host: meta.host,
        fullName: meta.fullName,
        externalId: meta.externalId,
        cloneUrl: meta.cloneUrl,
        webUrl: meta.webUrl,
        defaultBranch: ref.defaultBranch ?? meta.defaultBranch,
      })
      .onConflictDoUpdate({
        target: [repositories.host, repositories.fullName],
        set: { cloneUrl: meta.cloneUrl, webUrl: meta.webUrl, externalId: meta.externalId },
      })
      .returning({ id: repositories.id });
    return row.id;
  }

  private async workspaceCounts(userId: string, projectIds: string[]): Promise<Map<string, number>> {
    if (projectIds.length === 0) return new Map();
    const rows = await this.db
      .select({ projectId: workspaces.projectId, n: sql<number>`count(*)::int` })
      .from(workspaces)
      .where(and(eq(workspaces.ownerId, userId), inArray(workspaces.projectId, projectIds), isNull(workspaces.deletedAt)))
      .groupBy(workspaces.projectId);
    return new Map(rows.map((r) => [r.projectId, r.n]));
  }

  private toDto(p: typeof projects.$inferSelect, teamName: string, repo: typeof repositories.$inferSelect | null, myWorkspaceCount: number): ProjectDto {
    return {
      id: p.id,
      teamId: p.teamId,
      teamName,
      name: p.name,
      description: p.description,
      repository: repo ? toRepoDto(repo) : null,
      createdBy: p.createdBy ?? '',
      createdAt: p.createdAt.toISOString(),
      archivedAt: p.archivedAt?.toISOString() ?? null,
      myWorkspaceCount,
    };
  }
}

export function toRepoDto(r: typeof repositories.$inferSelect): RepositoryDto {
  return { id: r.id, provider: r.provider, host: r.host, fullName: r.fullName, cloneUrl: r.cloneUrl, defaultBranch: r.defaultBranch, webUrl: r.webUrl };
}
