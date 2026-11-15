import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { OpenPreviewSchema, previewPortAllowed, type PreviewPortDto } from '@cap/contracts';
import type { SecretProvider } from '@cap/secrets';
import { previewPorts, serviceCatalog, type Database } from '@cap/database';
import { AppError, AuditService, DB, ENV, SECRETS, SettingsService, previewHost, signPreviewToken, type BaseEnv } from '@cap/server-core';
import { CurrentUser } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';

const uuid = { schema: z.uuid() };

/**
 * Previews (SPEC §16.4) : 3 ports simultanés par défaut (configurable), réservées au propriétaire.
 * Un partage de conversation ne donne pas accès aux previews.
 */
@ApiTags('previews')
@Controller('workspaces/:id/previews')
export class PreviewsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: BaseEnv,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  private baseUrl(workspaceId: string, port: number): string {
    const p = this.env.PREVIEW_PUBLIC_PORT ? `:${this.env.PREVIEW_PUBLIC_PORT}` : '';
    return `${this.env.PREVIEW_PUBLIC_SCHEME}://${previewHost(workspaceId, port, this.env.PREVIEW_DOMAIN)}${p}`;
  }

  @Get()
  async list(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser): Promise<PreviewPortDto[]> {
    await this.access.requireWorkspaceOwner(user, id);
    const rows = await this.db.select().from(previewPorts).where(and(eq(previewPorts.workspaceId, id), isNull(previewPorts.closedAt)));
    return rows.map((r) => ({ id: r.id, port: r.port, label: r.label, url: this.baseUrl(id, r.port), createdAt: r.createdAt.toISOString() }));
  }

  @Post()
  async open(@Param('id', uuid) id: string, @Body({ schema: OpenPreviewSchema }) body: z.infer<typeof OpenPreviewSchema>, @CurrentUser() user: AuthUser): Promise<PreviewPortDto> {
    await this.access.requireWorkspaceOwner(user, id);
    const cfg = await this.settings.section('previews');
    if (!cfg.enabled) throw new AppError('forbidden', 'Les previews sont désactivées');
    if (!previewPortAllowed(body.port, cfg.allowedPorts)) {
      throw new AppError('validation_failed', `Le port ${body.port} n’est pas autorisé pour les previews (ports autorisés : ${cfg.allowedPorts.join(', ') || 'aucun'})`);
    }
    // Les ports des services d'appui (PostgreSQL, Redis…) ne sont jamais exposés hors de la sandbox.
    const [svc] = await this.db.select({ name: serviceCatalog.name }).from(serviceCatalog).where(eq(serviceCatalog.port, body.port)).limit(1);
    if (svc) throw new AppError('validation_failed', `Le port ${body.port} est réservé au service ${svc.name} : il n’est pas exposé hors de la sandbox`);
    const row = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`preview:${id}`}))`);
      const [existing] = await tx.select().from(previewPorts).where(and(eq(previewPorts.workspaceId, id), eq(previewPorts.port, body.port), isNull(previewPorts.closedAt)));
      if (existing) return existing;
      const [{ n }] = await tx.select({ n: count() }).from(previewPorts).where(and(eq(previewPorts.workspaceId, id), isNull(previewPorts.closedAt)));
      if (n >= cfg.maxPortsPerWorkspace) throw new AppError('preview_limit_reached', `Limite de ${cfg.maxPortsPerWorkspace} preview(s) simultanée(s) atteinte`);
      const [r] = await tx.insert(previewPorts).values({ workspaceId: id, port: body.port, label: body.label ?? null, createdBy: user.id }).returning();
      return r;
    });
    await this.audit.record({ actorId: user.id, action: 'preview.open', targetType: 'workspace', targetId: id, metadata: { port: body.port } });
    return { id: row.id, port: row.port, label: row.label, url: this.baseUrl(id, row.port), createdAt: row.createdAt.toISOString() };
  }

  /** Lien d'accès à usage court (60 s) échangé par la preview gateway contre un cookie de sous-domaine. */
  @Post(':previewId/link')
  async link(@Param('id', uuid) id: string, @Param('previewId', uuid) previewId: string, @CurrentUser() user: AuthUser) {
    await this.access.requireWorkspaceOwner(user, id);
    const [p] = await this.db.select().from(previewPorts).where(and(eq(previewPorts.id, previewId), eq(previewPorts.workspaceId, id), isNull(previewPorts.closedAt)));
    if (!p) throw new AppError('not_found', 'Preview introuvable');
    const key = await this.secrets.readKey(this.env.PREVIEW_SIGNING_KEY_REF, 'key');
    if (!key) throw new AppError('secret_backend_unavailable', 'Clé de signature absente');
    const token = signPreviewToken(key, { ws: id, port: p.port, uid: user.id, exp: Math.floor(Date.now() / 1000) + 60, kind: 'exchange' });
    return { url: `${this.baseUrl(id, p.port)}/__cap_auth?token=${encodeURIComponent(token)}` };
  }

  @Delete(':previewId')
  @HttpCode(204)
  async close(@Param('id', uuid) id: string, @Param('previewId', uuid) previewId: string, @CurrentUser() user: AuthUser) {
    await this.access.requireWorkspaceOwner(user, id);
    await this.db.update(previewPorts).set({ closedAt: new Date() }).where(and(eq(previewPorts.id, previewId), eq(previewPorts.workspaceId, id)));
    await this.audit.record({ actorId: user.id, action: 'preview.close', targetType: 'workspace', targetId: id });
  }
}
