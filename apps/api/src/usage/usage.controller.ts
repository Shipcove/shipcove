import { Body, Controller, Get, HttpCode, Inject, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  NotificationPreferenceSchema,
  NotificationTypes,
  type LlmRequestDto,
  type ModelDto,
  type NotificationDto,
  type NotificationPreferenceDto,
  type UsageSummaryDto,
} from '@cap/contracts';
import { llmModels, llmRequests, modelCoefficients, notificationPreferences, notifications, teamMembers, teams, type Database } from '@cap/database';
import { DB, NotificationService, QuotaService, SettingsService } from '@cap/server-core';
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

  /** Modèles autorisés pour au moins une équipe de l'utilisateur (ou une équipe donnée). */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('teamId', { schema: z.uuid().optional() }) teamId?: string): Promise<ModelDto[]> {
    const mine = (await this.db.select({ t: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, user.id))).map((r) => r.t);
    const teamsToCheck = teamId ? mine.filter((t) => t === teamId) : mine;
    const rows = await this.db.select().from(llmModels).where(and(eq(llmModels.enabled, true), isNull(llmModels.deletedAt)));
    const allowed = rows.filter((m) => m.allowedTeamIds.length === 0 || m.allowedTeamIds.some((t) => teamsToCheck.includes(t)));
    return modelDtos(this.db, allowed);
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

  /** Crédits consommés / disponibles sur 5 h et 7 jours (utilisateur et équipes). */
  @Get()
  async summary(@CurrentUser() user: AuthUser): Promise<UsageSummaryDto> {
    const myTeams = await this.db
      .select({ id: teams.id, name: teams.name })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.userId, user.id), isNull(teams.deletedAt)));
    return {
      user: { windows: await this.quotas.userWindows(user.id) },
      teams: await Promise.all(myTeams.map(async (t) => ({ teamId: t.id, teamName: t.name, windows: await this.quotas.teamWindows(t.id) }))),
      quotasEnabled: (await this.settings.section('quotas')).enabled,
    };
  }

  /** Consommation par requête (tokens entrée/sortie/cache, crédits, coût provider). */
  @Get('requests')
  async requests(
    @CurrentUser() user: AuthUser,
    @Query('workspaceId', { schema: z.uuid().optional() }) workspaceId?: string,
    @Query('limit', { schema: z.coerce.number().int().min(1).max(500).default(100) }) limit = 100,
  ): Promise<LlmRequestDto[]> {
    const rows = await this.db
      .select()
      .from(llmRequests)
      .where(and(eq(llmRequests.userId, user.id), ...(workspaceId ? [eq(llmRequests.workspaceId, workspaceId)] : [])))
      .orderBy(desc(llmRequests.createdAt))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      runId: r.runId,
      model: r.litellmModel,
      status: r.status === 'rejected' ? 'failed' : r.status,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      credits: r.credits,
      providerCostUsd: r.providerCostUsd,
      latencyMs: r.latencyMs,
      estimated: r.estimated,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Agrégats par modèle et par workspace (conversation). */
  @Get('breakdown')
  async breakdown(@CurrentUser() user: AuthUser, @Query('days', { schema: z.coerce.number().int().min(1).max(90).default(7) }) days = 7) {
    const byModel = await this.db.execute<{ model: string; requests: number; input: number; output: number; cache_read: number; cache_write: number; credits: string; cost: string | null }>(sql`
      select litellm_model as model, count(*)::int as requests,
        coalesce(sum(input_tokens),0)::int as input, coalesce(sum(output_tokens),0)::int as output,
        coalesce(sum(cache_read_tokens),0)::int as cache_read, coalesce(sum(cache_write_tokens),0)::int as cache_write,
        coalesce(sum(credits),0)::text as credits, sum(provider_cost_usd)::text as cost
      from llm_requests where user_id = ${user.id} and created_at > now() - (${days} * interval '1 day') and status = 'settled'
      group by litellm_model order by 7 desc`);
    const byWorkspace = await this.db.execute<{ workspace_id: string; name: string | null; credits: string; requests: number }>(sql`
      select r.workspace_id, w.name, coalesce(sum(r.credits),0)::text as credits, count(*)::int as requests
      from llm_requests r left join workspaces w on w.id = r.workspace_id
      where r.user_id = ${user.id} and r.created_at > now() - (${days} * interval '1 day') and r.status = 'settled'
      group by r.workspace_id, w.name order by 3 desc limit 50`);
    return { days, byModel: byModel.rows, byWorkspace: byWorkspace.rows };
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

