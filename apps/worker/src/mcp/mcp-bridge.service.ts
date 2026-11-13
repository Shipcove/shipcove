import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { SecretProvider } from '@cap/secrets';
import { mcpServers, workspaces, type Database } from '@cap/database';
import { AppError, DB, McpHttpClient, McpStdioClient, SECRETS, SettingsService } from '@cap/server-core';
import { SandboxManager } from '../sandbox/sandbox-manager.service.js';
import { SkillsMaterializer } from './skills-materializer.service.js';
import type { RunContext } from '../runs/run-orchestrator.service.js';

/**
 * Appels d'outils MCP demandés par Pi (pont de l'extension plateforme).
 * - Permission par outil vérifiée côté serveur (pas seulement à la génération de la liste).
 * - Serveurs distants (Streamable HTTP) : appelés par le worker avec les secrets lus dans Vault ;
 *   hôtes non globaux restreints à la liste autorisée par l'administration.
 * - Serveurs locaux (stdio) : exécutés **dans la sandbox de l'utilisateur** (isolation).
 */
@Injectable()
export class McpBridgeService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly materializer: SkillsMaterializer,
    private readonly sandboxes: SandboxManager,
    private readonly settings: SettingsService,
  ) {}

  async call(ctx: RunContext, serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId));
    const allowed = await this.materializer.allowedMcpTools(ws);
    const entry = allowed.find((t) => t.server === serverName && t.name === toolName);
    if (!entry) throw new AppError('forbidden', `Outil MCP non autorisé : ${serverName}/${toolName}`);
    const [srv] = await this.db.select().from(mcpServers).where(eq(mcpServers.id, entry.serverId));
    const secretValues = srv.secretRef ? await this.secrets.read(srv.secretRef) : {};
    if (srv.transport === 'streamable_http') {
      const url = new URL(srv.url!);
      if (srv.scope !== 'global') {
        const { allowedRemoteHosts } = await this.settings.section('mcp');
        if (!allowedRemoteHosts.includes(url.hostname)) throw new AppError('forbidden', `Hôte MCP non autorisé par l’administration : ${url.hostname}`);
      }
      const headers: Record<string, string> = { ...srv.headers };
      for (const [k, v] of Object.entries(secretValues)) if (k.startsWith('header:')) headers[k.slice(7)] = v;
      const client = new McpHttpClient(srv.url!, headers);
      await client.initialize();
      const r = await client.callTool(toolName, args);
      return r.isError ? `Erreur de l’outil : ${r.text}` : r.text;
    }
    // stdio : processus éphémère dans la sandbox.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(secretValues)) if (!k.startsWith('header:')) env[k] = v;
    const proc = await this.sandboxes.provider.exec(ctx.sandbox.handle, [srv.command!, ...srv.args], { interactive: true, env, timeoutMs: 120_000 });
    try {
      const client = new McpStdioClient(proc.stdin!, proc.stdout);
      await client.initialize();
      const r = await client.callTool(toolName, args);
      return r.isError ? `Erreur de l’outil : ${r.text}` : r.text;
    } finally {
      proc.stdin?.end();
      await proc.kill().catch(() => undefined);
    }
  }
}
