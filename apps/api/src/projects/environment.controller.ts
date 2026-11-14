import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  UpdateProjectEnvironmentSchema,
  UpsertEnvVarSchema,
  UpsertServiceCatalogSchema,
  type ServiceCatalogDto,
  type UpsertServiceCatalog,
  type EnvVarDto,
  type ProjectEnvironmentDto,
  type UpdateProjectEnvironment,
  type UpsertEnvVar,
} from '@cap/contracts';
import { environmentVariables, projects, sandboxImages, serviceCatalog, type Database } from '@cap/database';
import type { SecretProvider } from '@cap/secrets';
import { AppError, AuditService, DB, MIN_SECRET_LENGTH, SECRETS, isUniqueViolation } from '@cap/server-core';
import { CurrentUser, PlatformAdmin, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';

const uuid = { schema: z.uuid() };
type Row = typeof environmentVariables.$inferSelect;

const toDto = (r: Row): EnvVarDto => ({ id: r.id, scope: r.scope, name: r.name, secret: r.secret, value: r.secret ? null : r.value, updatedAt: r.updatedAt.toISOString() });

/**
 * Environnement des sandboxes (variables, secrets, image, script de préparation).
 * Les secrets sont écrits dans Vault et ne sont jamais renvoyés ; ils sont injectés à chaque run
 * dans le processus de Pi et masqués dans les sorties et dans les requêtes envoyées au modèle.
 */
@ApiTags('projects')
@Controller()
export class EnvironmentController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private list(scope: 'team' | 'project', subjectId: string) {
    return this.db.select().from(environmentVariables).where(and(eq(environmentVariables.scope, scope), eq(environmentVariables.subjectId, subjectId))).orderBy(environmentVariables.name);
  }

  private async canManageProject(user: AuthUser, projectId: string): Promise<boolean> {
    try {
      await this.access.requireProject(user, projectId, 'admin');
      return true;
    } catch {
      return false;
    }
  }

  @Get('projects/:projectId/environment')
  async get(@Param('projectId', uuid) projectId: string, @CurrentUser() user: AuthUser): Promise<ProjectEnvironmentDto> {
    await this.access.requireProject(user, projectId, 'read');
    const [p] = await this.db.select().from(projects).where(eq(projects.id, projectId));
    const images = await this.db.select().from(sandboxImages).where(inArray(sandboxImages.status, ['active'])).orderBy(sandboxImages.name, sandboxImages.version);
    return {
      sandboxImageId: p.sandboxImageId,
      setupScript: p.setupScript,
      images: images.map((i) => ({ id: i.id, name: i.name, version: i.version, isDefault: i.isDefault })),
      variables: (await this.list('project', projectId)).map(toDto),
      teamVariables: (await this.list('team', p.teamId)).map(toDto),
      canManage: await this.canManageProject(user, projectId),
    };
  }

  @Put('projects/:projectId/environment')
  async update(@Param('projectId', uuid) projectId: string, @Body({ schema: UpdateProjectEnvironmentSchema }) body: UpdateProjectEnvironment, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.access.requireProject(user, projectId, 'admin');
    if (body.sandboxImageId) {
      const [img] = await this.db.select().from(sandboxImages).where(and(eq(sandboxImages.id, body.sandboxImageId), eq(sandboxImages.status, 'active')));
      if (!img) throw new AppError('validation_failed', 'Image de sandbox inconnue ou non autorisée');
    }
    const script = body.setupScript?.trim() ? body.setupScript.replace(/\r\n/g, '\n') : null;
    await this.db.update(projects).set({ sandboxImageId: body.sandboxImageId, setupScript: script, updatedAt: new Date() }).where(eq(projects.id, projectId));
    await this.audit.record({ actorId: user.id, action: 'project.environment', targetType: 'project', targetId: projectId, ip: ctx.ip, metadata: { sandboxImageId: body.sandboxImageId, setupScriptBytes: script?.length ?? 0 } });
    return this.get(projectId, user);
  }

  @Put('projects/:projectId/environment/variables')
  async upsertProjectVar(@Param('projectId', uuid) projectId: string, @Body({ schema: UpsertEnvVarSchema }) body: UpsertEnvVar, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<EnvVarDto> {
    await this.access.requireProject(user, projectId, 'admin');
    return this.upsert('project', projectId, body, user, ctx);
  }

  @Delete('projects/:projectId/environment/variables/:varId')
  @HttpCode(204)
  async deleteProjectVar(@Param('projectId', uuid) projectId: string, @Param('varId', uuid) varId: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.access.requireProject(user, projectId, 'admin');
    await this.remove('project', projectId, varId, user, ctx);
  }

  @Get('teams/:teamId/environment/variables')
  async teamVars(@Param('teamId', uuid) teamId: string, @CurrentUser() user: AuthUser): Promise<EnvVarDto[]> {
    await this.access.requireTeamMember(user, teamId);
    return (await this.list('team', teamId)).map(toDto);
  }

  @Put('teams/:teamId/environment/variables')
  async upsertTeamVar(@Param('teamId', uuid) teamId: string, @Body({ schema: UpsertEnvVarSchema }) body: UpsertEnvVar, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<EnvVarDto> {
    await this.access.requireTeamAdmin(user, teamId);
    return this.upsert('team', teamId, body, user, ctx);
  }

  @Delete('teams/:teamId/environment/variables/:varId')
  @HttpCode(204)
  async deleteTeamVar(@Param('teamId', uuid) teamId: string, @Param('varId', uuid) varId: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.access.requireTeamAdmin(user, teamId);
    await this.remove('team', teamId, varId, user, ctx);
  }

  private async upsert(scope: 'team' | 'project', subjectId: string, body: UpsertEnvVar, user: AuthUser, ctx: RequestContext): Promise<EnvVarDto> {
    const [prev] = await this.db
      .select()
      .from(environmentVariables)
      .where(and(eq(environmentVariables.scope, scope), eq(environmentVariables.subjectId, subjectId), eq(environmentVariables.name, body.name)));
    let row: Row;
    if (body.secret) {
      if (body.value === undefined && !(prev?.secret && prev.secretRef)) throw new AppError('validation_failed', 'Valeur requise pour un nouveau secret');
      // Une valeur trop courte ne peut pas être masquée sans faux positifs dans les sorties.
      if (body.value !== undefined && body.value.length < MIN_SECRET_LENGTH) throw new AppError('validation_failed', `Un secret doit comporter au moins ${MIN_SECRET_LENGTH} caractères`);
      const ref = body.value !== undefined ? await this.secrets.write(`env/${scope}/${subjectId}/${body.name}`, { value: body.value }) : prev!.secretRef!;
      [row] = prev
        ? await this.db.update(environmentVariables).set({ secret: true, value: null, secretRef: ref, updatedAt: new Date() }).where(eq(environmentVariables.id, prev.id)).returning()
        : await this.db.insert(environmentVariables).values({ scope, subjectId, name: body.name, secret: true, secretRef: ref, createdBy: user.id }).returning();
    } else {
      if (body.value === undefined) throw new AppError('validation_failed', 'Valeur requise');
      // Ancien secret devenu variable simple : la valeur secrète est supprimée de Vault.
      if (prev?.secretRef) await this.secrets.revoke(prev.secretRef).catch(() => undefined);
      [row] = prev
        ? await this.db.update(environmentVariables).set({ secret: false, value: body.value, secretRef: null, updatedAt: new Date() }).where(eq(environmentVariables.id, prev.id)).returning()
        : await this.db.insert(environmentVariables).values({ scope, subjectId, name: body.name, secret: false, value: body.value, createdBy: user.id }).returning();
    }
    await this.audit.record({ actorId: user.id, action: prev ? 'env.update' : 'env.create', targetType: `${scope}_env`, targetId: subjectId, ip: ctx.ip, metadata: { name: body.name, secret: body.secret } });
    return toDto(row);
  }

  private async remove(scope: 'team' | 'project', subjectId: string, varId: string, user: AuthUser, ctx: RequestContext) {
    const [row] = await this.db
      .delete(environmentVariables)
      .where(and(eq(environmentVariables.id, varId), eq(environmentVariables.scope, scope), eq(environmentVariables.subjectId, subjectId)))
      .returning();
    if (!row) throw new AppError('not_found', 'Variable introuvable');
    if (row.secretRef) await this.secrets.revoke(row.secretRef).catch(() => undefined);
    await this.audit.record({ actorId: user.id, action: 'env.delete', targetType: `${scope}_env`, targetId: subjectId, ip: ctx.ip, metadata: { name: row.name } });
  }
}

const catalogDto = (c: typeof serviceCatalog.$inferSelect): ServiceCatalogDto => ({
  id: c.id,
  key: c.key,
  name: c.name,
  image: c.image,
  port: c.port,
  healthCommand: c.healthCommand,
  defaultEnv: c.defaultEnv,
  defaultMemoryMb: c.defaultMemoryMb,
  maxMemoryMb: c.maxMemoryMb,
  enabled: c.enabled,
});

/** Catalogue des services d'appui que Pi peut lancer à la demande (administrateur plateforme). */
@ApiTags('admin')
@Controller('admin/service-catalog')
@PlatformAdmin()
export class AdminServiceCatalogController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(): Promise<ServiceCatalogDto[]> {
    return (await this.db.select().from(serviceCatalog).orderBy(serviceCatalog.name)).map(catalogDto);
  }

  @Post()
  async create(@Body({ schema: UpsertServiceCatalogSchema }) body: UpsertServiceCatalog, @CurrentUser() user: AuthUser): Promise<ServiceCatalogDto> {
    const [row] = await this.db
      .insert(serviceCatalog)
      .values(body)
      .returning()
      .catch((e: unknown) => {
        if (isUniqueViolation(e)) throw new AppError('conflict', `Le service « ${body.key} » existe déjà`);
        throw e;
      });
    await this.audit.record({ actorId: user.id, action: 'admin.service_catalog_create', targetId: row.id, metadata: { key: body.key, image: body.image } });
    return catalogDto(row);
  }

  @Put(':id')
  async update(@Param('id', uuid) id: string, @Body({ schema: UpsertServiceCatalogSchema }) body: UpsertServiceCatalog, @CurrentUser() user: AuthUser): Promise<ServiceCatalogDto> {
    const [row] = await this.db.update(serviceCatalog).set({ ...body, updatedAt: new Date() }).where(eq(serviceCatalog.id, id)).returning();
    if (!row) throw new AppError('not_found', 'Service introuvable');
    await this.audit.record({ actorId: user.id, action: 'admin.service_catalog_update', targetId: id, metadata: { key: body.key, image: body.image, enabled: body.enabled } });
    return catalogDto(row);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser) {
    // Un service déjà lancé par Pi continue jusqu'à l'arrêt de sa sandbox ; il n'est plus proposé.
    const [row] = await this.db.delete(serviceCatalog).where(eq(serviceCatalog.id, id)).returning();
    if (!row) throw new AppError('not_found', 'Service introuvable');
    await this.audit.record({ actorId: user.id, action: 'admin.service_catalog_delete', targetId: id, metadata: { key: row.key } });
  }
}

