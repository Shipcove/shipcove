import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { CreateMcpServerSchema, McpPermissionSchema, type CreateMcpServer, type McpServerDto } from '@cap/contracts';
import type { SecretProvider } from '@cap/secrets';
import { mcpPermissions, mcpServers, mcpTools, teamMembers, type Database } from '@cap/database';
import { AppError, AuditService, DB, McpHttpClient, SECRETS, SettingsService, effectiveToolPermission, scopeVisible, type PermissionRule } from '@cap/server-core';
import { isUniqueViolation } from '@cap/server-core';
import { CurrentUser, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';

const uuid = { schema: z.uuid() };

/**
 * Serveurs MCP à trois portées (globale, équipe, personnelle), permissions par outil avec héritage :
 * une politique globale ne peut pas être contournée par une portée inférieure.
 */
@ApiTags('mcp')
@Controller('mcp-servers')
export class McpController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  private async assertManage(user: AuthUser, s: { scope: string; teamId: string | null; ownerId: string | null }) {
    if (s.scope === 'global' && user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs plateforme');
    if (s.scope === 'team') await this.access.requireTeamAdmin(user, s.teamId!);
    if (s.scope === 'personal' && s.ownerId !== user.id) throw new AppError('forbidden', 'Serveur personnel d’un autre utilisateur');
  }

  /** Serveurs visibles avec la permission effective de chaque outil (pour l'équipe indiquée). */
  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('teamId', { schema: z.uuid().optional() }) teamId?: string): Promise<McpServerDto[]> {
    const teams = (await this.db.select({ t: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, user.id))).map((r) => r.t);
    const subjectTeam = teamId && teams.includes(teamId) ? teamId : (teams[0] ?? '');
    const servers = (await this.db.select().from(mcpServers)).filter((s) => s.scope === 'global' || (s.scope === 'team' && teams.includes(s.teamId!)) || (s.scope === 'personal' && s.ownerId === user.id));
    const rules: PermissionRule[] = (await this.db.select().from(mcpPermissions)).map((r) => ({ serverId: r.serverId, toolName: r.toolName, scope: r.scope, subjectId: r.subjectId, effect: r.effect }));
    const out: McpServerDto[] = [];
    for (const s of servers) {
      const tools = await this.db.select().from(mcpTools).where(eq(mcpTools.serverId, s.id));
      out.push({
        id: s.id,
        name: s.name,
        description: s.description,
        scope: s.scope,
        teamId: s.teamId,
        ownerId: s.ownerId,
        transport: s.transport,
        url: s.url,
        command: s.command,
        args: s.args,
        secretKeys: s.secretKeys,
        version: s.version,
        enabled: s.enabled,
        health: s.health,
        lastHealthAt: s.lastHealthAt?.toISOString() ?? null,
        tools: tools.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          effective: scopeVisible(s.scope, s.teamId, s.ownerId, { userId: user.id, teamId: subjectTeam }) ? effectiveToolPermission(s.id, t.name, rules, { userId: user.id, teamId: subjectTeam }) : 'denied',
        })),
      });
    }
    return out;
  }

  @Post()
  async create(@Body({ schema: CreateMcpServerSchema }) body: CreateMcpServer, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const cfg = await this.settings.section('mcp');
    if (body.scope === 'personal' && !cfg.personalServersAllowed) throw new AppError('forbidden', 'Les serveurs MCP personnels sont désactivés');
    if (body.scope === 'team' && !cfg.teamServersAllowed) throw new AppError('forbidden', 'Les serveurs MCP d’équipe sont désactivés');
    if (body.transport === 'streamable_http' && !body.url) throw new AppError('validation_failed', 'URL requise');
    if (body.transport === 'stdio' && !body.command) throw new AppError('validation_failed', 'Commande requise');
    if (body.transport === 'streamable_http' && body.scope !== 'global') {
      const host = new URL(body.url!).hostname;
      if (!cfg.allowedRemoteHosts.includes(host)) throw new AppError('forbidden', `Hôte ${host} non autorisé pour les serveurs non globaux (administration > MCP)`);
    }
    const meta = { scope: body.scope, teamId: body.scope === 'team' ? body.teamId : null, ownerId: body.scope === 'personal' ? user.id : null };
    await this.assertManage(user, meta);
    const secretData: Record<string, string> = { ...body.secretEnv };
    for (const [k, v] of Object.entries(body.headers)) if (/authorization|token|key|secret/i.test(k)) secretData[`header:${k}`] = v;
    const publicHeaders = Object.fromEntries(Object.entries(body.headers).filter(([k]) => !/authorization|token|key|secret/i.test(k)));
    const [s] = await this.db
      .insert(mcpServers)
      .values({
        name: body.name,
        description: body.description,
        ...meta,
        transport: body.transport,
        url: body.url ?? null,
        command: body.command ?? null,
        args: body.args,
        headers: publicHeaders,
        secretKeys: Object.keys(secretData),
        version: body.version ?? null,
      })
      .returning()
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError('conflict', 'Un serveur porte déjà ce nom dans cette portée');
        throw err;
      });
    if (Object.keys(secretData).length) {
      const ref = await this.secrets.write(`mcp/${s.id}`, secretData);
      await this.db.update(mcpServers).set({ secretRef: ref }).where(eq(mcpServers.id, s.id));
    }
    await this.audit.record({ actorId: user.id, action: 'mcp.create', targetType: 'mcp_server', targetId: s.id, ip: ctx.ip, metadata: { scope: body.scope, transport: body.transport } });
    return { id: s.id };
  }

  /** Découverte des outils (Streamable HTTP) et contrôle de santé. */
  @Post(':serverId/discover')
  @HttpCode(200)
  async discover(@Param('serverId', uuid) id: string, @CurrentUser() user: AuthUser) {
    const [s] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    if (!s) throw new AppError('not_found', 'Serveur introuvable');
    await this.assertManage(user, s);
    if (s.transport !== 'streamable_http') throw new AppError('conflict', 'Serveur stdio : déclarez ses outils (exécution uniquement dans les sandboxes)');
    const secrets = s.secretRef ? await this.secrets.read(s.secretRef) : {};
    const headers: Record<string, string> = { ...s.headers };
    for (const [k, v] of Object.entries(secrets)) if (k.startsWith('header:')) headers[k.slice(7)] = v;
    try {
      const client = new McpHttpClient(s.url!, headers, 20_000);
      const info = await client.initialize();
      const tools = await client.listTools();
      await this.upsertTools(id, tools);
      await this.db.update(mcpServers).set({ health: 'healthy', healthDetail: info.serverInfo ? `${info.serverInfo.name} ${info.serverInfo.version}` : null, lastHealthAt: new Date(), version: info.serverInfo?.version ?? s.version }).where(eq(mcpServers.id, id));
      return { ok: true, tools: tools.length };
    } catch (err) {
      await this.db.update(mcpServers).set({ health: 'unhealthy', healthDetail: (err as Error).message.slice(0, 300), lastHealthAt: new Date() }).where(eq(mcpServers.id, id));
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** Déclaration manuelle des outils (serveurs stdio). */
  @Put(':serverId/tools')
  async declareTools(
    @Param('serverId', uuid) id: string,
    @Body({ schema: z.object({ tools: z.array(z.object({ name: z.string().min(1).max(200), description: z.string().max(2000).default(''), inputSchema: z.record(z.string(), z.unknown()).optional() })).max(200) }) })
    body: { tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }> },
    @CurrentUser() user: AuthUser,
  ) {
    const [s] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    if (!s) throw new AppError('not_found', 'Serveur introuvable');
    await this.assertManage(user, s);
    await this.upsertTools(id, body.tools);
    return { ok: true };
  }

  private async upsertTools(serverId: string, tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>) {
    await this.db.transaction(async (tx) => {
      await tx.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
      if (tools.length) await tx.insert(mcpTools).values(tools.map((t) => ({ serverId, name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object' } })));
    });
  }

  /**
   * Règle de permission par outil. Autorité : portée globale (admin plateforme), équipe (admin
   * d'équipe), personnelle (soi-même). Une portée inférieure ne peut que restreindre.
   */
  @Put(':serverId/permissions')
  async setPermission(@Param('serverId', uuid) id: string, @Body({ schema: McpPermissionSchema }) body: z.infer<typeof McpPermissionSchema>, @CurrentUser() user: AuthUser) {
    if (body.scope === 'global' && user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs');
    if (body.scope === 'team') await this.access.requireTeamAdmin(user, body.teamId!);
    const subjectId = body.scope === 'global' ? null : body.scope === 'team' ? body.teamId : user.id;
    await this.db.delete(mcpPermissions).where(and(eq(mcpPermissions.serverId, id), eq(mcpPermissions.toolName, body.toolName), eq(mcpPermissions.scope, body.scope), ...(subjectId ? [eq(mcpPermissions.subjectId, subjectId)] : [])));
    await this.db.insert(mcpPermissions).values({ serverId: id, toolName: body.toolName, scope: body.scope, subjectId, effect: body.effect, createdBy: user.id });
    await this.audit.record({ actorId: user.id, action: 'mcp.permission', targetType: 'mcp_server', targetId: id, metadata: body });
    return { ok: true };
  }

  @Get(':serverId/permissions')
  permissions(@Param('serverId', uuid) id: string) {
    return this.db.select().from(mcpPermissions).where(eq(mcpPermissions.serverId, id));
  }

  @Patch(':serverId')
  async toggle(@Param('serverId', uuid) id: string, @Body({ schema: z.object({ enabled: z.boolean() }) }) body: { enabled: boolean }, @CurrentUser() user: AuthUser) {
    const [s] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    if (!s) throw new AppError('not_found', 'Serveur introuvable');
    await this.assertManage(user, s);
    await this.db.update(mcpServers).set({ enabled: body.enabled, updatedAt: new Date() }).where(eq(mcpServers.id, id));
    await this.audit.record({ actorId: user.id, action: body.enabled ? 'mcp.enable' : 'mcp.disable', targetType: 'mcp_server', targetId: id });
    return { ok: true };
  }

  @Delete(':serverId')
  @HttpCode(204)
  async remove(@Param('serverId', uuid) id: string, @CurrentUser() user: AuthUser) {
    const [s] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    if (!s) throw new AppError('not_found', 'Serveur introuvable');
    await this.assertManage(user, s);
    if (s.secretRef) await this.secrets.revoke(s.secretRef).catch(() => undefined);
    await this.db.delete(mcpServers).where(eq(mcpServers.id, id));
    await this.audit.record({ actorId: user.id, action: 'mcp.delete', targetType: 'mcp_server', targetId: id });
  }
}
