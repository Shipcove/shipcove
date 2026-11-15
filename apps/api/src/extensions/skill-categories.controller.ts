import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { asc, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ReorderSkillCategoriesSchema, UpsertSkillCategorySchema, type SkillCategoryDto, type UpsertSkillCategory } from '@cap/contracts';
import { skillCategories, skills, type Database } from '@cap/database';
import { AppError, AuditService, DB, isUniqueViolation } from '@cap/server-core';
import { CurrentUser, PlatformAdmin, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';

const uuid = { schema: z.uuid() };

async function listCategories(db: Database): Promise<SkillCategoryDto[]> {
  const rows = await db.select().from(skillCategories).orderBy(asc(skillCategories.position), asc(skillCategories.name));
  const counts = await db.select({ id: skills.categoryId, n: count() }).from(skills).where(sql`${skills.status} <> 'revoked'`).groupBy(skills.categoryId);
  return rows.map((c) => ({ id: c.id, name: c.name, description: c.description, position: c.position, skillCount: counts.find((x) => x.id === c.id)?.n ?? 0 }));
}

/** Catégories de skills : lues par tous (classement), gérées par les administrateurs. */
@ApiTags('skills')
@Controller('skill-categories')
export class SkillCategoriesController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  list(): Promise<SkillCategoryDto[]> {
    return listCategories(this.db);
  }
}

@ApiTags('admin')
@PlatformAdmin()
@Controller('admin/skill-categories')
export class AdminSkillCategoriesController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(): Promise<SkillCategoryDto[]> {
    return listCategories(this.db);
  }

  @Post()
  async create(@Body({ schema: UpsertSkillCategorySchema }) body: UpsertSkillCategory, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<SkillCategoryDto> {
    const [{ max }] = await this.db.select({ max: sql<number>`coalesce(max(${skillCategories.position}), -1)` }).from(skillCategories);
    const [c] = await this.db
      .insert(skillCategories)
      .values({ name: body.name, description: body.description, position: Number(max) + 1 })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError('conflict', 'Une catégorie porte déjà ce nom');
        throw err;
      });
    await this.audit.record({ actorId: user.id, action: 'admin.skill_category_create', targetType: 'skill_category', targetId: c.id, ip: ctx.ip, metadata: { name: c.name } });
    return { id: c.id, name: c.name, description: c.description, position: c.position, skillCount: 0 };
  }

  @Put(':id')
  async update(@Param('id', uuid) id: string, @Body({ schema: UpsertSkillCategorySchema }) body: UpsertSkillCategory, @CurrentUser() user: AuthUser) {
    const [c] = await this.db
      .update(skillCategories)
      .set({ name: body.name, description: body.description, updatedAt: new Date() })
      .where(eq(skillCategories.id, id))
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError('conflict', 'Une catégorie porte déjà ce nom');
        throw err;
      });
    if (!c) throw new AppError('not_found', 'Catégorie introuvable');
    await this.audit.record({ actorId: user.id, action: 'admin.skill_category_update', targetType: 'skill_category', targetId: id, metadata: { name: c.name } });
    return { ok: true };
  }

  /** Ordre d'affichage : identifiants dans l'ordre voulu. */
  @Put()
  async reorder(@Body({ schema: ReorderSkillCategoriesSchema }) body: { ids: string[] }, @CurrentUser() user: AuthUser) {
    await this.db.transaction(async (tx) => {
      for (const [i, id] of body.ids.entries()) await tx.update(skillCategories).set({ position: i }).where(eq(skillCategories.id, id));
    });
    await this.audit.record({ actorId: user.id, action: 'admin.skill_category_reorder', metadata: { ids: body.ids } });
    return { ok: true };
  }

  /** Suppression : les skills de la catégorie passent « sans catégorie ». */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser) {
    await this.db.delete(skillCategories).where(eq(skillCategories.id, id));
    await this.audit.record({ actorId: user.id, action: 'admin.skill_category_delete', targetType: 'skill_category', targetId: id });
  }
}
