import { Body, Controller, Get, HttpCode, Inject, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  NotificationPreferenceSchema,
  NotificationTypes,
  toQuotaWindow,
  type UsageBreakdownDto,
  type UsageRequestDto,
  type ModelDto,
  type NotificationDto,
  type NotificationPreferenceDto,
  type UsageSummaryDto,
} from '@cap/contracts';
import { llmModels, llmRequests, modelCoefficients, notificationPreferences, notifications, type Database } from '@cap/database';
import { DB, NotificationService, QuotaService, SettingsService, modelAllowedFor } from '@cap/server-core';
import { CurrentUser } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';

export async function modelDtos(db: Database, rows: Array<typeof llmModels.$inferSelect>): Promise<ModelDto[]> {
  const out: ModelDto[] = [];
  for (const m of rows) {
    const [c] = await db
      .select()
      .from(modelCoefficients)
      .where(and(eq(modelCoefficients.modelId, m.id), sql`${modelCoefficients.effectiveFrom} <= now()`))
      .orderBy(desc(modelCoefficients.version))
      .limit(1);
    out.push({
      id: m.id,
      litellmModel: m.litellmModel,
      displayName: m.displayName,
      provider: m.provider,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxOutputTokens,
      supportsImages: m.supportsImages,
      supportsReasoning: m.supportsReasoning,
      enabled: m.enabled,
      isDefault: m.isDefault,
      available: m.available,
      coefficients: c ? { version: c.version, input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite: c.cacheWrite, effectiveFrom: c.effectiveFrom.toISOString() } : null,
    });
  }
  return out;
}

@ApiTags('models')
@Controller('models')
export class ModelsController {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Modèles activés accessibles à l'utilisateur (liste blanche vide = tous). */
  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<ModelDto[]> {
    const rows = (await this.db.select().from(llmModels).where(and(eq(llmModels.enabled, true), isNull(llmModels.deletedAt)))).filter((m) => modelAllowedFor(m, user.id));
    // Les coefficients (crédits par 1 000 tokens) sont réservés à l'administration.
    return (await modelDtos(this.db, rows)).map((m) => ({ ...m, coefficients: null }));
  }
}

@ApiTags('usage')
@Controller('usage')
export class UsageController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly quotas: QuotaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Quotas personnels de l'utilisateur, en pourcentage uniquement : les crédits (unité interne de
   * pondération) ne sont visibles que de l'administration.
   */
  @Get()
  async summary(@CurrentUser() user: AuthUser): Promise<UsageSummaryDto> {
    return {
      user: { windows: (await this.quotas.userWindows(user.id)).map(toQuotaWindow) },
      quotasEnabled: (await this.settings.section('quotas')).enabled,
    };
  }

  /** Dernières requêtes LLM de l'utilisateur : ni tokens, ni crédits, ni coût. */
  @Get('requests')
  async requests(
    @CurrentUser() user: AuthUser,
    @Query('workspaceId', { schema: z.uuid().optional() }) workspaceId?: string,
    @Query('limit', { schema: z.coerce.number().int().min(1).max(500).default(100) }) limit = 100,
  ): Promise<UsageRequestDto[]> {
    const rows = await this.db
      .select({ id: llmRequests.id, workspaceId: llmRequests.workspaceId, runId: llmRequests.runId, model: llmRequests.litellmModel, status: llmRequests.status, latencyMs: llmRequests.latencyMs, createdAt: llmRequests.createdAt })
      .from(llmRequests)
      .where(and(eq(llmRequests.userId, user.id), ...(workspaceId ? [eq(llmRequests.workspaceId, workspaceId)] : [])))
      .orderBy(desc(llmRequests.createdAt))
      .limit(limit);
    const status = (s: string): UsageRequestDto['status'] =>
      s === 'settled' || s === 'pending_reconciliation' ? 'completed' : s === 'rejected' ? 'rejected' : s === 'failed' ? 'failed' : 'in_progress';
    return rows.map((r) => ({ ...r, status: status(r.status), createdAt: r.createdAt.toISOString() }));
  }

  /** Répartition relative par modèle et par workspace (parts en %, aucune valeur absolue). */
  @Get('breakdown')
  async breakdown(@CurrentUser() user: AuthUser, @Query('days', { schema: z.coerce.number().int().min(1).max(90).default(7) }) days = 7): Promise<UsageBreakdownDto> {
    const byModel = await this.db.execute<{ model: string; requests: number; percent: number }>(sql`
      select model, requests, round(100 * share)::int as percent from (
        select litellm_model as model, count(*)::int as requests,
          coalesce(sum(credits),0) / nullif(sum(sum(credits)) over (), 0) as share
        from llm_requests where user_id = ${user.id} and created_at > now() - (${days} * interval '1 day') and status = 'settled'
        group by litellm_model) t
      order by share desc nulls last`);
    const byWorkspace = await this.db.execute<{ workspaceId: string | null; name: string | null; requests: number; percent: number }>(sql`
      select workspace_id as "workspaceId", name, requests, round(100 * share)::int as percent from (
        select r.workspace_id, w.name, count(*)::int as requests,
          coalesce(sum(r.credits),0) / nullif(sum(sum(r.credits)) over (), 0) as share
        from llm_requests r left join workspaces w on w.id = r.workspace_id
        where r.user_id = ${user.id} and r.created_at > now() - (${days} * interval '1 day') and r.status = 'settled'
        group by r.workspace_id, w.name) t
      order by share desc nulls last limit 50`);
    const pct = <T extends { percent: number | null }>(rows: T[]) => rows.map((r) => ({ ...r, percent: r.percent ?? 0 }));
    return { days, byModel: pct(byModel.rows), byWorkspace: pct(byWorkspace.rows) };
  }
}

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly service: NotificationService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('unread', { schema: z.enum(['true', 'false']).optional() }) unread?: string): Promise<{ items: NotificationDto[]; unreadCount: number }> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, user.id), ...(unread === 'true' ? [isNull(notifications.readAt)] : [])))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    const [{ n }] = await this.db.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)));
    return {
      items: rows.map((r) => ({ id: r.id, type: r.type as NotificationDto['type'], title: r.title, body: r.body, link: r.link, readAt: r.readAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() })),
      unreadCount: n,
    };
  }

  @Post('read')
  @HttpCode(204)
  async markRead(@CurrentUser() user: AuthUser, @Body({ schema: z.object({ ids: z.array(z.uuid()).max(500).optional() }) }) body: { ids?: string[] }) {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt), ...(body.ids?.length ? [inArray(notifications.id, body.ids)] : [])));
  }

  @Get('preferences')
  async preferences(@CurrentUser() user: AuthUser): Promise<NotificationPreferenceDto[]> {
    return Promise.all(NotificationTypes.map(async (type) => ({ type, ...(await this.service.preferencesFor(user.id, type)) })));
  }

  @Put('preferences')
  @HttpCode(204)
  async setPreference(@CurrentUser() user: AuthUser, @Body({ schema: NotificationPreferenceSchema }) body: z.infer<typeof NotificationPreferenceSchema>) {
    await this.db
      .insert(notificationPreferences)
      .values({ userId: user.id, type: body.type, inApp: body.inApp, email: body.email })
      .onConflictDoUpdate({ target: [notificationPreferences.userId, notificationPreferences.type], set: { inApp: body.inApp, email: body.email, updatedAt: new Date() } });
  }
}

