import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  UpdateRepositoryEnvironmentSchema,
  UpsertEnvVarSchema,
  UpsertServiceCatalogSchema,
  type AdminRepositoryDto,
  type EnvVarDto,
  type RepositoryDto,
  type RepositoryEnvironmentDto,
  type ServiceCatalogDto,
  type UpdateRepositoryEnvironment,
  type UpsertEnvVar,
  type UpsertServiceCatalog,
} from '@cap/contracts';
import { environmentVariables, repositories, sandboxImages, serviceCatalog, workspaces, type Database } from '@cap/database';
import type { SecretProvider } from '@cap/secrets';
import { AppError, AuditService, DB, MIN_SECRET_LENGTH, SECRETS, isUniqueViolation } from '@cap/server-core';
import { CurrentUser, PlatformAdmin, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';

const uuid = { schema: z.uuid() };
type Row = typeof environmentVariables.$inferSelect;

const toDto = (r: Row): EnvVarDto => ({ id: r.id, name: r.name, secret: r.secret, value: r.secret ? null : r.value, updatedAt: r.updatedAt.toISOString() });

export function toRepoDto(r: typeof repositories.$inferSelect): RepositoryDto {
  return { id: r.id, provider: r.provider, host: r.host, fullName: r.fullName, cloneUrl: r.cloneUrl, defaultBranch: r.defaultBranch, webUrl: r.webUrl };
}

/**
 * Environnement des dépôts (variables, secrets, image, script de préparation), partagé par toutes
 * les conversations sur un dépôt et géré par l'administrateur. Les secrets sont écrits dans Vault et
 * ne sont jamais renvoyés ; ils sont injectés à chaque run dans le processus de Pi et masqués dans
 * les sorties et dans les requêtes envoyées au modèle.
 */
@ApiTags('admin')
@Controller('admin/repositories')
@PlatformAdmin()
export class AdminRepositoriesController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly audit: AuditService,
  ) {}

  /** Dépôts connus de la plateforme (utilisés par au moins une conversation, ou déjà configurés). */
  @Get()
  async list(): Promise<AdminRepositoryDto[]> {
    const rows = await this.db
      .select({
        r: repositories,
        n: sql<number>`count(${workspaces.id})::int`,
        last: sql<Date | null>`max(${workspaces.lastActivityAt})`,
        vars: sql<number>`(select count(*)::int from ${environmentVariables} where ${environmentVariables.scope} = 'repository' and ${environmentVariables.subjectId} = ${repositories.id})`,
      })
      .from(repositories)
      .leftJoin(workspaces, and(eq(workspaces.repositoryId, repositories.id), isNull(workspaces.deletedAt)))
      .groupBy(repositories.id)
      .orderBy(desc(sql`max(${workspaces.lastActivityAt})`));
    return rows.map(({ r, n, last, vars }) => ({
      ...toRepoDto(r),
      conversationCount: n,
      lastUsedAt: last ? new Date(last).toISOString() : null,
      setupConfigured: !!(r.setupScript || r.sandboxImageId),
      variableCount: vars,
    }));
  }

  private async repo(id: string) {
    const [r] = await this.db.select().from(repositories).where(eq(repositories.id, id));
    if (!r) throw new AppError('not_found', 'Dépôt introuvable');
    return r;
  }

  private list_(repositoryId: string) {
    return this.db
      .select()
      .from(environmentVariables)
      .where(and(eq(environmentVariables.scope, 'repository'), eq(environmentVariables.subjectId, repositoryId)))
      .orderBy(environmentVariables.name);
  }

  @Get(':id/environment')
  async get(@Param('id', uuid) id: string): Promise<RepositoryEnvironmentDto> {
    const r = await this.repo(id);
    const images = await this.db.select().from(sandboxImages).where(inArray(sandboxImages.status, ['active'])).orderBy(sandboxImages.name, sandboxImages.version);
    return {
      repository: toRepoDto(r),
      sandboxImageId: r.sandboxImageId,
      setupScript: r.setupScript,
      images: images.map((i) => ({ id: i.id, name: i.name, version: i.version, isDefault: i.isDefault })),
      variables: (await this.list_(id)).map(toDto),
    };
  }

  @Put(':id/environment')
  async update(@Param('id', uuid) id: string, @Body({ schema: UpdateRepositoryEnvironmentSchema }) body: UpdateRepositoryEnvironment, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.repo(id);
    if (body.sandboxImageId) {
      const [img] = await this.db.select().from(sandboxImages).where(and(eq(sandboxImages.id, body.sandboxImageId), eq(sandboxImages.status, 'active')));
      if (!img) throw new AppError('validation_failed', 'Image de sandbox inconnue ou non autorisée');
    }
    const script = body.setupScript?.trim() ? body.setupScript.replace(/\r\n/g, '\n') : null;
    await this.db.update(repositories).set({ sandboxImageId: body.sandboxImageId, setupScript: script }).where(eq(repositories.id, id));
    await this.audit.record({ actorId: user.id, action: 'repository.environment', targetType: 'repository', targetId: id, ip: ctx.ip, metadata: { sandboxImageId: body.sandboxImageId, setupScriptBytes: script?.length ?? 0 } });
    return this.get(id);
  }

  @Put(':id/environment/variables')
  async upsertVar(@Param('id', uuid) id: string, @Body({ schema: UpsertEnvVarSchema }) body: UpsertEnvVar, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<EnvVarDto> {
    await this.repo(id);
    const [prev] = await this.db
      .select()
      .from(environmentVariables)
      .where(and(eq(environmentVariables.scope, 'repository'), eq(environmentVariables.subjectId, id), eq(environmentVariables.name, body.name)));
    let row: Row;
    if (body.secret) {
      if (body.value === undefined && !(prev?.secret && prev.secretRef)) throw new AppError('validation_failed', 'Valeur requise pour un nouveau secret');
      // Une valeur trop courte ne peut pas être masquée sans faux positifs dans les sorties.
      if (body.value !== undefined && body.value.length < MIN_SECRET_LENGTH) throw new AppError('validation_failed', `Un secret doit comporter au moins ${MIN_SECRET_LENGTH} caractères`);
      const ref = body.value !== undefined ? await this.secrets.write(`env/repository/${id}/${body.name}`, { value: body.value }) : prev!.secretRef!;
      [row] = prev
        ? await this.db.update(environmentVariables).set({ secret: true, value: null, secretRef: ref, updatedAt: new Date() }).where(eq(environmentVariables.id, prev.id)).returning()
        : await this.db.insert(environmentVariables).values({ scope: 'repository', subjectId: id, name: body.name, secret: true, secretRef: ref, createdBy: user.id }).returning();
    } else {
      if (body.value === undefined) throw new AppError('validation_failed', 'Valeur requise');
      // Ancien secret devenu variable simple : la valeur secrète est supprimée de Vault.
      if (prev?.secretRef) await this.secrets.revoke(prev.secretRef).catch(() => undefined);
      [row] = prev
        ? await this.db.update(environmentVariables).set({ secret: false, value: body.value, secretRef: null, updatedAt: new Date() }).where(eq(environmentVariables.id, prev.id)).returning()
        : await this.db.insert(environmentVariables).values({ scope: 'repository', subjectId: id, name: body.name, secret: false, value: body.value, createdBy: user.id }).returning();
    }
    await this.audit.record({ actorId: user.id, action: prev ? 'env.update' : 'env.create', targetType: 'repository_env', targetId: id, ip: ctx.ip, metadata: { name: body.name, secret: body.secret } });
    return toDto(row);
  }

  @Delete(':id/environment/variables/:varId')
  @HttpCode(204)
  async deleteVar(@Param('id', uuid) id: string, @Param('varId', uuid) varId: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const [row] = await this.db
      .delete(environmentVariables)
      .where(and(eq(environmentVariables.id, varId), eq(environmentVariables.scope, 'repository'), eq(environmentVariables.subjectId, id)))
      .returning();
    if (!row) throw new AppError('not_found', 'Variable introuvable');
    if (row.secretRef) await this.secrets.revoke(row.secretRef).catch(() => undefined);
    await this.audit.record({ actorId: user.id, action: 'env.delete', targetType: 'repository_env', targetId: id, ip: ctx.ip, metadata: { name: row.name } });
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

