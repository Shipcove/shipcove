import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { UpsertServiceCatalogSchema, toRepositoryDto, type RepositoryDto, type ServiceCatalogDto, type UpsertServiceCatalog } from '@cap/contracts';
import { repositories, serviceCatalog, type Database } from '@cap/database';
import { AppError, AuditService, DB, isUniqueViolation } from '@cap/server-core';
import { CurrentUser, PlatformAdmin } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';

const uuid = { schema: z.uuid() };

export const toRepoDto = (r: typeof repositories.$inferSelect): RepositoryDto => toRepositoryDto(r);

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

