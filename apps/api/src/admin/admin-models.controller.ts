import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { CoefficientsInputSchema, UpsertModelSchema, type ModelDto, type UpsertModel } from '@cap/contracts';
import type { SecretProvider } from '@cap/secrets';
import { llmModels, modelCoefficients, type Database } from '@cap/database';
import { AppError, AuditService, DB, SECRETS } from '@cap/server-core';
import { isUniqueViolation } from '@cap/server-core';
import { CurrentUser, PlatformAdmin, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { modelDtos } from '../usage/usage.controller.js';
import { LiteLlmAdminService } from './litellm.service.js';

const uuid = { schema: z.uuid() };

@ApiTags('admin')
@PlatformAdmin()
@Controller('admin/models')
export class AdminModelsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly litellm: LiteLlmAdminService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(): Promise<Array<ModelDto & { allowedTeamIds: string[]; litellmParams: Record<string, unknown>; lastSyncError: string | null; secretConfigured: boolean }>> {
    const rows = await this.db.select().from(llmModels).where(isNull(llmModels.deletedAt)).orderBy(llmModels.displayName);
    const dtos = await modelDtos(this.db, rows);
    return dtos.map((d, i) => ({ ...d, allowedTeamIds: rows[i].allowedTeamIds, litellmParams: rows[i].litellmParams, lastSyncError: rows[i].lastSyncError, secretConfigured: !!rows[i].secretRef }));
  }

  @Post()
  async create(@Body({ schema: UpsertModelSchema }) body: UpsertModel, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const [m] = await this.db
      .insert(llmModels)
      .values({
        litellmModel: body.litellmModel,
        displayName: body.displayName,
        provider: String(body.litellmParams.model ?? '').split('/')[0] || 'custom',
        litellmParams: sanitizeParams(body.litellmParams),
        contextWindow: body.contextWindow,
        maxOutputTokens: body.maxOutputTokens,
        supportsImages: body.supportsImages,
        supportsReasoning: body.supportsReasoning,
        enabled: body.enabled,
        isDefault: false,
        allowedTeamIds: body.allowedTeamIds,
      })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError('conflict', 'Un modèle porte déjà ce nom LiteLLM');
        throw err;
      });
    await this.db.insert(modelCoefficients).values({ modelId: m.id, version: 1, ...body.coefficients, createdBy: user.id });
    await this.applySecretAndSync(m.id, body);
    if (body.isDefault) await this.setDefault(m.id);
    await this.audit.record({ actorId: user.id, action: 'admin.model_create', targetType: 'llm_model', targetId: m.id, ip: ctx.ip, metadata: { litellmModel: body.litellmModel } });
    return { id: m.id };
  }

  @Put(':modelId')
  async update(@Param('modelId', uuid) id: string, @Body({ schema: UpsertModelSchema }) body: UpsertModel, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const [m] = await this.db.select().from(llmModels).where(and(eq(llmModels.id, id), isNull(llmModels.deletedAt)));
    if (!m) throw new AppError('not_found', 'Modèle introuvable');
    if (m.litellmModel !== body.litellmModel) await this.litellm.remove(m.litellmModel).catch(() => undefined);
    await this.db
      .update(llmModels)
      .set({
        litellmModel: body.litellmModel,
        displayName: body.displayName,
        litellmParams: sanitizeParams(body.litellmParams),
        contextWindow: body.contextWindow,
        maxOutputTokens: body.maxOutputTokens,
        supportsImages: body.supportsImages,
        supportsReasoning: body.supportsReasoning,
        enabled: body.enabled,
        allowedTeamIds: body.allowedTeamIds,
        updatedAt: new Date(),
      })
      .where(eq(llmModels.id, id));
    await this.addCoefficientsIfChanged(id, body.coefficients, user.id);
    await this.applySecretAndSync(id, body);
    if (body.isDefault) await this.setDefault(id);
    await this.audit.record({ actorId: user.id, action: 'admin.model_update', targetType: 'llm_model', targetId: id, ip: ctx.ip });
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
    await this.db.update(llmModels).set({ available: r.ok, lastSyncAt: new Date(), lastSyncError: r.ok ? null : r.detail }).where(eq(llmModels.id, id));
    return r;
  }

  @Delete(':modelId')
  @HttpCode(204)
  async remove(@Param('modelId', uuid) id: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const [m] = await this.db.select().from(llmModels).where(eq(llmModels.id, id));
    if (!m) throw new AppError('not_found', 'Modèle introuvable');
    await this.litellm.remove(m.litellmModel).catch(() => undefined);
    await this.db.update(llmModels).set({ deletedAt: new Date(), enabled: false, isDefault: false }).where(eq(llmModels.id, id));
    if (m.secretRef) await this.secrets.revoke(m.secretRef).catch(() => undefined);
    await this.audit.record({ actorId: user.id, action: 'admin.model_delete', targetType: 'llm_model', targetId: id, ip: ctx.ip });
  }

  private async setDefault(id: string) {
    await this.db.transaction(async (tx) => {
      await tx.update(llmModels).set({ isDefault: false }).where(and(ne(llmModels.id, id), eq(llmModels.isDefault, true)));
      await tx.update(llmModels).set({ isDefault: true }).where(eq(llmModels.id, id));
    });
  }

  private async addCoefficientsIfChanged(id: string, c: z.infer<typeof CoefficientsInputSchema>, actor: string, force = false) {
    const [last] = await this.db.select().from(modelCoefficients).where(eq(modelCoefficients.modelId, id)).orderBy(desc(modelCoefficients.version)).limit(1);
    const same = last && [last.input, last.output, last.cacheRead, last.cacheWrite].map(Number).join() === [c.input, c.output, c.cacheRead, c.cacheWrite].map(Number).join();
    if (same && !force) return;
    await this.db.insert(modelCoefficients).values({ modelId: id, version: (last?.version ?? 0) + 1, ...c, createdBy: actor });
  }

  private async applySecretAndSync(id: string, body: UpsertModel) {
    let apiKey = body.apiKey;
    const [m] = await this.db.select().from(llmModels).where(eq(llmModels.id, id));
    if (apiKey) {
      const ref = await this.secrets.write(`models/${id}`, { apiKey });
      await this.db.update(llmModels).set({ secretRef: ref }).where(eq(llmModels.id, id));
    } else if (m.secretRef) {
      apiKey = await this.secrets.readKey(m.secretRef, 'apiKey');
    }
    try {
      await this.litellm.upsert(body.litellmModel, sanitizeParams(body.litellmParams), apiKey);
      await this.db.update(llmModels).set({ lastSyncAt: new Date(), lastSyncError: null, available: true }).where(eq(llmModels.id, id));
    } catch (err) {
      await this.db.update(llmModels).set({ lastSyncError: (err as Error).message.slice(0, 500), available: false }).where(eq(llmModels.id, id));
    }
  }
}

/** Les secrets ne transitent jamais par `litellmParams` (stockés en clair en base sinon). */
function sanitizeParams(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (/key|secret|token|password/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}
