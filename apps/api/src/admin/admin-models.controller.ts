import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  CoefficientsInputSchema,
  LiteLlmConnectionSchema,
  UpdateModelSchema,
  type AdminModelDto,
  type LiteLlmConnection,
  type LiteLlmConnectionDto,
  type LiteLlmSyncResultDto,
  type UpdateModel,
} from '@cap/contracts';
import type { SecretProvider } from '@cap/secrets';
import { llmModels, modelCoefficients, users, type Database } from '@cap/database';
import { AppError, AuditService, DB, LiteLlmClient, SECRETS } from '@cap/server-core';
import { CurrentUser, PlatformAdmin, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { modelDtos } from '../usage/usage.controller.js';
import { LiteLlmAdminService } from './litellm.service.js';

const uuid = { schema: z.uuid() };

/** Connexion à LiteLLM : un proxy existant peut être utilisé sans redéployer celui de la plateforme. */
@ApiTags('admin')
@PlatformAdmin()
@Controller('admin/litellm')
export class AdminLiteLlmController {
  constructor(
    private readonly client: LiteLlmClient,
    private readonly audit: AuditService,
  ) {}

  @Get('connection')
  async connection(): Promise<LiteLlmConnectionDto> {
    this.client.invalidate();
    const c = await this.client.connection();
    return { url: c.url, source: c.source, keyConfigured: !!c.key };
  }

  /** Vérifie la connexion proposée (sans l'enregistrer) : joignable, clé acceptée, modèles listés. */
  @Post('connection/test')
  @HttpCode(200)
  async test(@Body({ schema: LiteLlmConnectionSchema }) body: LiteLlmConnection) {
    const current = await this.client.connection();
    const conn = { url: body.url.replace(/\/+$/, ''), key: body.masterKey ?? current.key, source: 'admin' as const };
    try {
      const models = await this.client.discover(conn);
      return { ok: true, models: models.map((m) => m.name) };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** Enregistre la connexion (Vault) puis recharge les modèles. */
  @Put('connection')
  async save(@Body({ schema: LiteLlmConnectionSchema }) body: LiteLlmConnection, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<{ connection: LiteLlmConnectionDto; sync: LiteLlmSyncResultDto | null; syncError: string | null }> {
    await this.client.saveConnection(body.url, body.masterKey);
    await this.audit.record({ actorId: user.id, action: 'admin.litellm_connection', ip: ctx.ip, metadata: { url: body.url, keyChanged: !!body.masterKey } });
    const c = await this.client.connection();
    let sync: LiteLlmSyncResultDto | null = null;
    let syncError: string | null = null;
    try {
      sync = await this.client.syncModels(user.id);
    } catch (err) {
      syncError = (err as Error).message;
    }
    return { connection: { url: c.url, source: c.source, keyConfigured: !!c.key }, sync, syncError };
  }
}

/** Modèles découverts dans LiteLLM : activation, modèle par défaut, liste blanche, coefficients. */
@ApiTags('admin')
@PlatformAdmin()
@Controller('admin/models')
export class AdminModelsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly client: LiteLlmClient,
    private readonly litellm: LiteLlmAdminService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(): Promise<AdminModelDto[]> {
    const rows = await this.db.select().from(llmModels).where(isNull(llmModels.deletedAt)).orderBy(desc(llmModels.enabled), llmModels.displayName);
    const dtos = await modelDtos(this.db, rows);
    const ids = [...new Set(rows.flatMap((r) => r.allowedUserIds))];
    const people = ids.length ? await this.db.select({ id: users.id, displayName: users.displayName, username: users.username }).from(users).where(inArray(users.id, ids)) : [];
    const byId = new Map(people.map((p) => [p.id, p]));
    return dtos.map((d, i) => ({
      ...d,
      allowedUsers: rows[i].allowedUserIds.map((id) => byId.get(id)).filter((p): p is NonNullable<typeof p> => !!p),
      lastSyncAt: rows[i].lastSyncAt?.toISOString() ?? null,
      lastSyncError: rows[i].lastSyncError,
    }));
  }

  /** Recharge la liste des modèles depuis LiteLLM. */
  @Post('reload')
  @HttpCode(200)
  async reload(@CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<LiteLlmSyncResultDto> {
    const r = await this.client.syncModels(user.id);
    await this.audit.record({ actorId: user.id, action: 'admin.models_reload', ip: ctx.ip, metadata: { discovered: r.discovered, added: r.added, missing: r.missing } });
    return r;
  }

  @Patch(':modelId')
  async update(@Param('modelId', uuid) id: string, @Body({ schema: UpdateModelSchema }) body: UpdateModel, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const [m] = await this.db.select().from(llmModels).where(and(eq(llmModels.id, id), isNull(llmModels.deletedAt)));
    if (!m) throw new AppError('not_found', 'Modèle introuvable');
    const enabled = body.enabled ?? m.enabled;
    if (body.isDefault && !enabled) throw new AppError('validation_failed', 'Activez le modèle avant d’en faire le modèle par défaut');
    if (body.allowedUserIds?.length) {
      const found = await this.db.select({ id: users.id }).from(users).where(inArray(users.id, body.allowedUserIds));
      if (found.length !== new Set(body.allowedUserIds).size) throw new AppError('validation_failed', 'Utilisateur inconnu dans la liste blanche');
    }
    const { coefficients, isDefault, allowedUserIds, ...fields } = body;
    await this.db.transaction(async (tx) => {
      if (isDefault) await tx.update(llmModels).set({ isDefault: false }).where(and(ne(llmModels.id, id), eq(llmModels.isDefault, true)));
      await tx
        .update(llmModels)
        .set({
          ...fields,
          ...(allowedUserIds ? { allowedUserIds: [...new Set(allowedUserIds)] } : {}),
          // Un modèle désactivé ne peut pas rester le modèle par défaut.
          ...(isDefault !== undefined ? { isDefault: isDefault && enabled } : !enabled ? { isDefault: false } : {}),
          updatedAt: new Date(),
        })
        .where(eq(llmModels.id, id));
    });
    if (coefficients) await this.addCoefficientsIfChanged(id, coefficients, user.id);
    await this.audit.record({ actorId: user.id, action: 'admin.model_update', targetType: 'llm_model', targetId: id, ip: ctx.ip, metadata: { ...body } });
    return { id };
  }

  /** Nouvelle version des coefficients (les consommations passées ne changent pas). */
  @Post(':modelId/coefficients')
  async coefficients(@Param('modelId', uuid) id: string, @Body({ schema: CoefficientsInputSchema }) body: z.infer<typeof CoefficientsInputSchema>, @CurrentUser() user: AuthUser) {
    await this.addCoefficientsIfChanged(id, body, user.id, true);
    await this.audit.record({ actorId: user.id, action: 'admin.model_coefficients', targetType: 'llm_model', targetId: id, metadata: body });
    return { ok: true };
  }

  @Get(':modelId/coefficients')
  async coefficientHistory(@Param('modelId', uuid) id: string) {
    return this.db.select().from(modelCoefficients).where(eq(modelCoefficients.modelId, id)).orderBy(desc(modelCoefficients.version));
  }

  @Post(':modelId/test')
  @HttpCode(200)
  async test(@Param('modelId', uuid) id: string) {
    const [m] = await this.db.select().from(llmModels).where(eq(llmModels.id, id));
    if (!m) throw new AppError('not_found', 'Modèle introuvable');
    const r = await this.litellm.test(m.litellmModel);
    await this.db.update(llmModels).set({ available: r.ok, lastSyncAt: new Date(), lastSyncError: r.ok ? null : r.detail.slice(0, 500) }).where(eq(llmModels.id, id));
    return r;
  }

  /** Retrait du catalogue (ex. modèle supprimé de LiteLLM) ; l'historique de consommation est conservé. */
  @Delete(':modelId')
  @HttpCode(204)
  async remove(@Param('modelId', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const [m] = await this.db.select().from(llmModels).where(eq(llmModels.id, id));
    if (!m) throw new AppError('not_found', 'Modèle introuvable');
    await this.db.update(llmModels).set({ deletedAt: new Date(), enabled: false, isDefault: false }).where(eq(llmModels.id, id));
    if (m.secretRef) await this.secrets.revoke(m.secretRef).catch(() => undefined);
    await this.audit.record({ actorId: user.id, action: 'admin.model_delete', targetType: 'llm_model', targetId: id, ip: ctx.ip });
  }

  private async addCoefficientsIfChanged(id: string, c: z.infer<typeof CoefficientsInputSchema>, actor: string, force = false) {
    const [last] = await this.db.select().from(modelCoefficients).where(eq(modelCoefficients.modelId, id)).orderBy(desc(modelCoefficients.version)).limit(1);
    const same = last && [last.input, last.output, last.cacheRead, last.cacheWrite].map(Number).join() === [c.input, c.output, c.cacheRead, c.cacheWrite].map(Number).join();
    if (same && !force) return;
    await this.db.insert(modelCoefficients).values({ modelId: id, version: (last?.version ?? 0) + 1, ...c, createdBy: actor });
  }
}
