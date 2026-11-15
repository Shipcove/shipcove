import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RegistryMirrorConfigSchema, type RegistryMirrorConfigDto, type RegistryMirrorConfigInput } from '@cap/contracts';
import { AuditService, RegistryMirrorService, planImagePull, type RegistryMirrorConfig } from '@cap/server-core';
import { CurrentUser, PlatformAdmin, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';

/**
 * Miroir de registre pour les images des services d'appui lancés dans les sandboxes
 * (déploiement sans accès direct aux registres publics). Identifiants dans Vault, jamais renvoyés.
 */
@ApiTags('admin')
@PlatformAdmin()
@Controller('admin/registry-mirrors')
export class AdminRegistryController {
  constructor(
    private readonly mirrors: RegistryMirrorService,
    private readonly audit: AuditService,
  ) {}

  private dto(c: RegistryMirrorConfig): RegistryMirrorConfigDto {
    return {
      mirrors: c.mirrors.map((m) => ({ registry: m.registry, prefix: m.prefix, username: m.username ?? null, passwordSet: !!m.password })),
      fallbackToUpstream: c.fallbackToUpstream,
    };
  }

  @Get()
  async get(): Promise<RegistryMirrorConfigDto> {
    return this.dto(await this.mirrors.get());
  }

  @Put()
  async put(@Body({ schema: RegistryMirrorConfigSchema }) body: RegistryMirrorConfigInput, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<RegistryMirrorConfigDto> {
    const prev = await this.mirrors.get();
    const norm = (r: string) => r.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const config: RegistryMirrorConfig = {
      fallbackToUpstream: body.fallbackToUpstream,
      mirrors: body.mirrors.map((m) => {
        const old = prev.mirrors.find((p) => norm(p.registry) === norm(m.registry));
        const username = m.username?.trim() || undefined;
        // Mot de passe absent : celui déjà enregistré (même registre, même utilisateur).
        const password = m.password || (username && old?.username === username ? old.password : undefined);
        return { registry: norm(m.registry), prefix: m.prefix.trim().replace(/\/+$/, ''), ...(username ? { username } : {}), ...(username && password ? { password } : {}) };
      }),
    };
    await this.mirrors.save(config);
    await this.audit.record({
      actorId: user.id,
      action: 'admin.registry_mirrors',
      ip: ctx.ip,
      metadata: { mirrors: config.mirrors.map((m) => ({ registry: m.registry, prefix: m.prefix, authenticated: !!m.password })), fallbackToUpstream: config.fallbackToUpstream },
    });
    return this.dto(config);
  }

  /** Aperçu de la réécriture d'une référence (sans identifiants). */
  @Post('preview')
  @HttpCode(200)
  async preview(@Body({ schema: z.object({ images: z.array(z.string().min(1).max(300)).max(50) }) }) body: { images: string[] }) {
    const c = await this.mirrors.get();
    return body.images.map((image) => {
      const p = planImagePull(image, c);
      return { image, pulled: p.image, authenticated: !!p.auth, fallback: p.fallback ?? null };
    });
  }
}
