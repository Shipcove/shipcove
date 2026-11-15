import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import {
  mcpPermissions,
  mcpServers,
  mcpTools,
  skillInstallations,
  skillVersions,
  skills,
  workspaces,
  type Database,
} from '@cap/database';
import { isMarkdownPath, isSafeSkillPath } from '@cap/contracts';
import { DB, effectiveToolPermission, scopeVisible, skillEnabledFor, type PermissionRule } from '@cap/server-core';
import type { ActiveSandbox, SandboxManager } from '../sandbox/sandbox-manager.service.js';

type Ws = typeof workspaces.$inferSelect;

/**
 * Matérialise dans la sandbox les skills autorisés et la liste des outils MCP permis,
 * selon les portées et politiques. L'installation d'un skill ne confère aucun privilège :
 * c'est un simple fichier d'instructions lu par Pi.
 */
@Injectable()
export class SkillsMaterializer {
  constructor(@Inject(DB) private readonly db: Database) {}

  async activeSkills(ws: Pick<Ws, 'ownerId'>) {
    const subject = { userId: ws.ownerId };
    const all = await this.db.select().from(skills).where(eq(skills.status, 'published'));
    const visible = all.filter((s) => scopeVisible(s.scope, s.ownerId, subject));
    if (visible.length === 0) return [];
    const installs = await this.db
      .select()
      .from(skillInstallations)
      .where(inArray(skillInstallations.skillId, visible.map((s) => s.id)));
    const out: Array<{ skill: typeof skills.$inferSelect; version: typeof skillVersions.$inferSelect }> = [];
    for (const s of visible) {
      // Choix de l'utilisateur, sinon réglage « activé par défaut » de l'administrateur, sinon activé.
      if (!skillEnabledFor(installs, s.id, subject.userId)) continue;
      const [v] = await this.db
        .select()
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, s.id), eq(skillVersions.version, s.latestVersion)))
        .limit(1);
      if (v) out.push({ skill: s, version: v });
    }
    return out;
  }

  /** Fichiers markdown des skills actifs, arborescence comprise (jamais de script ni de binaire). */
  async files(ws: Ws): Promise<Array<{ path: string; content: string }>> {
    const active = await this.activeSkills(ws);
    return active.flatMap(({ skill, version }) =>
      version.files
        // Chemins validés à l'enregistrement ; vérifiés de nouveau (défense en profondeur), markdown uniquement.
        .filter((f) => isSafeSkillPath(f.path) && isMarkdownPath(f.path) && f.encoding !== 'base64')
        .map((f) => ({ path: `home/agent/.pi/agent/skills/${skill.name}/${f.path}`, content: f.content })),
    );
  }

  async allowedMcpTools(ws: Pick<Ws, 'ownerId'>) {
    const subject = { userId: ws.ownerId };
    const servers = (await this.db.select().from(mcpServers).where(eq(mcpServers.enabled, true))).filter((s) =>
      scopeVisible(s.scope, s.ownerId, subject),
    );
    if (servers.length === 0) return [];
    const ids = servers.map((s) => s.id);
    const tools = await this.db.select().from(mcpTools).where(inArray(mcpTools.serverId, ids));
    const rules: PermissionRule[] = (await this.db.select().from(mcpPermissions).where(inArray(mcpPermissions.serverId, ids))).map((r) => ({
      serverId: r.serverId,
      toolName: r.toolName,
      scope: r.scope,
      subjectId: r.subjectId,
      effect: r.effect,
    }));
    return tools
      .filter((t) => effectiveToolPermission(t.serverId, t.name, rules, subject) === 'allowed')
      .map((t) => {
        const srv = servers.find((s) => s.id === t.serverId)!;
        return { serverId: srv.id, server: srv.name, name: t.name, description: t.description, inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' } };
      });
  }

  async writeMcpConfig(manager: SandboxManager, sb: ActiveSandbox, ws: Ws): Promise<void> {
    const tools = await this.allowedMcpTools(ws);
    await manager.writeFiles(sb.handle, [
      { path: 'run/cap/mcp-tools.json', content: JSON.stringify(tools.map(({ server, name, description, inputSchema }) => ({ server, name, description, inputSchema }))) },
    ]);
  }
}
