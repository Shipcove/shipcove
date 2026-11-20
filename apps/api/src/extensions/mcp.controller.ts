import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  CreateMcpServerSchema,
  McpPermissionSchema,
  McpSelectionSchema,
  TestMcpServerSchema,
  UpdateMcpServerSchema,
  type CreateMcpServer,
  type McpDiscoveryResult,
  type McpServerDto,
  type TestMcpServer,
  type UpdateMcpServer,
} from '@cap/contracts';
import type { SecretProvider } from '@cap/secrets';
import { mcpPermissions, mcpServers, mcpTools, type Database } from '@cap/database';
import { AppError, AuditService, DB, McpHttpClient, SECRETS, SettingsService, effectiveToolPermission, scopeVisible, type PermissionRule } from '@cap/server-core';
import { isUniqueViolation } from '@cap/server-core';
import { CurrentUser, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';
import { mergeSecrets, selectionRules, splitHeaders } from './mcp-config.js';

const uuid = { schema: z.uuid() };

/**
 * Serveurs MCP à deux portées (globale, personnelle), permissions par outil avec héritage :
 * une politique globale ne peut pas être contournée par une portée inférieure.
 */

/** Message des anciens serveurs stdio (transport retiré). */
const STDIO_REMOVED = 'Transport stdio retiré (secrets exposés dans la sandbox) : supprimez ce serveur et recréez-le en Streamable HTTP';

const hideConfig = (s: { scope: string }, user: AuthUser) => s.scope === 'global' && user.platformRole !== 'platform_admin';

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

  private async assertManage(user: AuthUser, s: { scope: string; ownerId: string | null }) {
    if (s.scope === 'global' && user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs plateforme');
    if (s.scope === 'personal' && s.ownerId !== user.id) throw new AppError('forbidden', 'Serveur personnel d’un autre utilisateur');
  }

  /** Serveur visible par l'utilisateur (global ou personnel), sinon introuvable. */
  private async visibleServer(user: AuthUser, id: string) {
    const [s] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    const visible = s && (user.platformRole === 'platform_admin' || s.scope === 'global' || (s.scope === 'personal' && s.ownerId === user.id));
    if (!visible) throw new AppError('not_found', 'Serveur introuvable');
    return { server: s };
  }

  /** Serveurs visibles avec la permission effective de chaque outil pour l'utilisateur. */
  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<McpServerDto[]> {
    const servers = (await this.db.select().from(mcpServers)).filter((s) => s.scope === 'global' || (s.scope === 'personal' && s.ownerId === user.id));
    const rules: PermissionRule[] = (await this.db.select().from(mcpPermissions)).map((r) => ({ serverId: r.serverId, toolName: r.toolName, scope: r.scope, subjectId: r.subjectId, effect: r.effect }));
    const out: McpServerDto[] = [];
    for (const s of servers) {
      const tools = await this.db.select().from(mcpTools).where(eq(mcpTools.serverId, s.id));
      out.push({
        id: s.id,
        name: s.name,
        description: s.description,
        scope: s.scope,
        ownerId: s.ownerId,
        transport: s.transport,
        // Configuration d'un serveur global (adresse interne, commande, noms des secrets) : réservée
        // aux administrateurs ; les autres voient le serveur et ses outils.
        url: hideConfig(s, user) ? null : s.url,
        command: hideConfig(s, user) ? null : s.command,
        args: hideConfig(s, user) ? [] : s.args,
        headers: hideConfig(s, user) ? {} : s.headers,
        secretKeys: hideConfig(s, user) ? [] : s.secretKeys,
        version: s.version,
        enabled: s.enabled,
        health: s.health,
        healthDetail: hideConfig(s, user) && s.health !== 'healthy' ? null : s.healthDetail,
        lastHealthAt: s.lastHealthAt?.toISOString() ?? null,
        tools: tools.map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          effective: scopeVisible(s.scope, s.ownerId, { userId: user.id }) ? effectiveToolPermission(s.id, t.name, rules, { userId: user.id }) : 'denied',
          // Refus global : le choix personnel ne peut pas le lever (un administrateur règle la portée globale).
          lockedByAdmin: effectiveToolPermission(s.id, t.name, rules.filter((r) => r.scope === 'global'), { userId: user.id }) === 'denied',
        })),
      });
    }
    return out;
  }

  @Post()
  async create(@Body({ schema: CreateMcpServerSchema }) body: CreateMcpServer, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const cfg = await this.settings.section('mcp');
    if (body.scope === 'personal' && !cfg.personalServersAllowed) throw new AppError('forbidden', 'Les serveurs MCP personnels sont désactivés');
    this.assertHostAllowed(body.scope, body.url, cfg.allowedRemoteHosts);
    const meta = { scope: body.scope, ownerId: body.scope === 'personal' ? user.id : null };
    await this.assertManage(user, meta);
    const { pub: publicHeaders, secret } = splitHeaders(body.headers, body.secretHeaders);
    const secretData: Record<string, string> = {};
    for (const [k, v] of Object.entries(secret)) secretData[`header:${k}`] = v;
    const [s] = await this.db
      .insert(mcpServers)
      .values({
        name: body.name,
        description: body.description,
        ...meta,
        transport: body.transport,
        url: body.url,
        command: null,
        args: [],
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
    // Découverte immédiate : outils et état de santé visibles dès l'ajout.
    const discovery = await this.runDiscovery(s.id);
    return { id: s.id, discovery };
  }

  /** Hôte d'un serveur non global : liste blanche de l'administrateur (Administration → MCP). */
  private assertHostAllowed(scope: string, url: string, allowed: string[]) {
    if (scope === 'global') return;
    const host = new URL(url).hostname;
    if (!allowed.includes(host)) throw new AppError('forbidden', `Hôte ${host} non autorisé pour les serveurs personnels : un administrateur doit l’ajouter (Administration → MCP)`);
  }

  /** Teste une configuration sans l'enregistrer : connexion, version annoncée, outils. */
  @Post('test')
  @HttpCode(200)
  async test(@Body({ schema: TestMcpServerSchema }) body: TestMcpServer, @CurrentUser() user: AuthUser): Promise<McpDiscoveryResult> {
    const cfg = await this.settings.section('mcp');
    if (body.scope === 'personal' && !cfg.personalServersAllowed) throw new AppError('forbidden', 'Les serveurs MCP personnels sont désactivés');
    if (body.scope === 'global' && user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs plateforme');
    this.assertHostAllowed(body.scope, body.url, cfg.allowedRemoteHosts);
    const { pub, secret } = splitHeaders(body.headers, body.secretHeaders);
    const headers: Record<string, string> = { ...pub };
    // Modification en cours : les secrets enregistrés complètent ceux qui n'ont pas été remplacés.
    if (body.serverId) {
      const [s] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, body.serverId));
      if (!s) throw new AppError('not_found', 'Serveur introuvable');
      await this.assertManage(user, s);
      const stored = s.secretRef ? await this.secrets.read(s.secretRef) : {};
      for (const [k, v] of Object.entries(stored)) if (k.startsWith('header:')) headers[k.slice(7)] = v;
    }
    Object.assign(headers, secret);
    return probe(body.url, headers);
  }

  /** Découverte des outils (Streamable HTTP) et contrôle de santé. */
  @Post(':serverId/discover')
  @HttpCode(200)
  async discover(@Param('serverId', uuid) id: string, @CurrentUser() user: AuthUser): Promise<McpDiscoveryResult> {
    const [s] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    if (!s) throw new AppError('not_found', 'Serveur introuvable');
    await this.assertManage(user, s);
    if (s.transport !== 'streamable_http') throw new AppError('conflict', STDIO_REMOVED);
    return this.runDiscovery(id);
  }

  /** Interroge le serveur enregistré, met à jour ses outils et son état de santé. */
  private async runDiscovery(id: string): Promise<McpDiscoveryResult> {
    const [s] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    const secrets = s.secretRef ? await this.secrets.read(s.secretRef) : {};
    const headers: Record<string, string> = { ...s.headers };
    for (const [k, v] of Object.entries(secrets)) if (k.startsWith('header:')) headers[k.slice(7)] = v;
    const r = await probe(s.url!, headers);
    if (r.ok) {
      await this.upsertTools(id, r.tools ?? []);
      await this.db.update(mcpServers).set({ health: 'healthy', healthDetail: r.server ?? null, lastHealthAt: new Date(), version: r.server?.split(' ').at(-1) ?? s.version }).where(eq(mcpServers.id, id));
    } else {
      await this.db.update(mcpServers).set({ health: 'unhealthy', healthDetail: (r.detail ?? '').slice(0, 300), lastHealthAt: new Date() }).where(eq(mcpServers.id, id));
    }
    return r;
  }

  private async upsertTools(serverId: string, tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>) {
    await this.db.transaction(async (tx) => {
      await tx.delete(mcpTools).where(eq(mcpTools.serverId, serverId));
      if (tools.length) await tx.insert(mcpTools).values(tools.map((t) => ({ serverId, name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object' } })));
    });
  }

  /**
   * Règle de permission par outil. Autorité : portée globale (admin plateforme), personnelle
   * (soi-même). La portée personnelle ne peut que restreindre.
   */
  @Put(':serverId/permissions')
  async setPermission(@Param('serverId', uuid) id: string, @Body({ schema: McpPermissionSchema }) body: z.infer<typeof McpPermissionSchema>, @CurrentUser() user: AuthUser) {
    await this.visibleServer(user, id);
    if (body.scope === 'global' && user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs');
    const subjectId = body.scope === 'global' ? null : user.id;
    await this.db.delete(mcpPermissions).where(and(eq(mcpPermissions.serverId, id), eq(mcpPermissions.toolName, body.toolName), eq(mcpPermissions.scope, body.scope), ...(subjectId ? [eq(mcpPermissions.subjectId, subjectId)] : [])));
    await this.db.insert(mcpPermissions).values({ serverId: id, toolName: body.toolName, scope: body.scope, subjectId, effect: body.effect, createdBy: user.id });
    await this.audit.record({ actorId: user.id, action: 'mcp.permission', targetType: 'mcp_server', targetId: id, metadata: body });
    return { ok: true };
  }

  /**
   * Sélection des outils en une fois : les outils décochés deviennent des refus de la portée, qui
   * remplacent toutes ses règles pour ce serveur. Jamais de liste blanche : un outil ajouté plus tard
   * au serveur est proposé par défaut, et un refus global reste prioritaire sur le choix personnel.
   */
  @Put(':serverId/selection')
  async setSelection(@Param('serverId', uuid) id: string, @Body({ schema: McpSelectionSchema }) body: z.infer<typeof McpSelectionSchema>, @CurrentUser() user: AuthUser) {
    await this.visibleServer(user, id);
    if (body.scope === 'global' && user.platformRole !== 'platform_admin') throw new AppError('forbidden', 'Réservé aux administrateurs');
    const subjectId = body.scope === 'global' ? null : user.id;
    const rules = selectionRules(id, body.scope, subjectId, body.denied);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(mcpPermissions)
        .where(and(eq(mcpPermissions.serverId, id), eq(mcpPermissions.scope, body.scope), subjectId ? eq(mcpPermissions.subjectId, subjectId) : isNull(mcpPermissions.subjectId)));
      if (rules.length) await tx.insert(mcpPermissions).values(rules.map((r) => ({ ...r, createdBy: user.id })));
    });
    await this.audit.record({ actorId: user.id, action: 'mcp.selection', targetType: 'mcp_server', targetId: id, metadata: { scope: body.scope, denied: rules.length } });
    return { ok: true };
  }

  /** Règles du serveur : globales et les siennes (tout pour un admin plateforme). */
  @Get(':serverId/permissions')
  async permissions(@Param('serverId', uuid) id: string, @CurrentUser() user: AuthUser) {
    await this.visibleServer(user, id);
    const rows = await this.db.select().from(mcpPermissions).where(eq(mcpPermissions.serverId, id));
    if (user.platformRole === 'platform_admin') return rows;
    return rows.filter((r) => r.scope === 'global' || (r.scope === 'personal' && r.subjectId === user.id));
  }

  /** Modification : activation, adresse, en-têtes, secrets (posés, remplacés ou retirés). */
  @Patch(':serverId')
  async update(@Param('serverId', uuid) id: string, @Body({ schema: UpdateMcpServerSchema }) body: UpdateMcpServer, @CurrentUser() user: AuthUser) {
    const [s] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, id));
    if (!s) throw new AppError('not_found', 'Serveur introuvable');
    await this.assertManage(user, s);
    if (body.url !== undefined) {
      if (s.transport !== 'streamable_http') throw new AppError('validation_failed', STDIO_REMOVED);
      this.assertHostAllowed(s.scope, body.url, (await this.settings.section('mcp')).allowedRemoteHosts);
    }
    // Ancien serveur stdio : il ne peut plus être réactivé ni modifié, seulement supprimé.
    if (s.transport !== 'streamable_http' && (body.enabled === true || Object.keys(body).some((k) => k !== 'enabled'))) throw new AppError('validation_failed', STDIO_REMOVED);
    const { pub, secret } = splitHeaders(body.headers ?? s.headers, body.secretHeaders ?? {});
    const stored = s.secretRef ? await this.secrets.read(s.secretRef) : {};
    const next = mergeSecrets(stored, { publicHeaders: pub, secretHeaders: secret, remove: body.removeSecrets ?? [] });
    const secretsChanged = JSON.stringify(Object.entries(next).sort()) !== JSON.stringify(Object.entries(stored).sort());
    let secretRef = s.secretRef;
    if (secretsChanged) {
      if (Object.keys(next).length) secretRef = await this.secrets.write(`mcp/${s.id}`, next);
      else {
        if (s.secretRef) await this.secrets.revoke(s.secretRef).catch(() => undefined);
        secretRef = null;
      }
    }
    await this.db
      .update(mcpServers)
      .set({
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
        headers: pub,
        secretKeys: Object.keys(next),
        secretRef,
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, id));
    const configChanged = body.url !== undefined || body.headers !== undefined || secretsChanged;
    const action = body.enabled === undefined || configChanged ? 'mcp.update' : body.enabled ? 'mcp.enable' : 'mcp.disable';
    await this.audit.record({ actorId: user.id, action, targetType: 'mcp_server', targetId: id, metadata: { fields: Object.keys(body) } });
    // Configuration modifiée : nouvelle découverte (outils, santé).
    const discovery = configChanged && s.transport === 'streamable_http' ? await this.runDiscovery(id) : null;
    return { ok: true, discovery };
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

/** Connexion à un serveur Streamable HTTP : version annoncée et outils, ou l'erreur telle quelle. */
async function probe(url: string, headers: Record<string, string>): Promise<McpDiscoveryResult> {
  try {
    const client = new McpHttpClient(url, headers, 20_000);
    const info = await client.initialize();
    const tools = await client.listTools();
    return {
      ok: true,
      server: info.serverInfo ? `${info.serverInfo.name} ${info.serverInfo.version}` : null,
      tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema })),
    };
  } catch (err) {
    return { ok: false, detail: (err as Error).message.slice(0, 500) };
  }
}
