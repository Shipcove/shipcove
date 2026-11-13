import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
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
import { DB, effectiveToolPermission, scopeVisible, type PermissionRule } from '@cap/server-core';
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

  async activeSkills(ws: Pick<Ws, 'ownerId' | 'teamId'>) {
    const subject = { userId: ws.ownerId, teamId: ws.teamId };
    const all = await this.db.select().from(skills).where(eq(skills.status, 'published'));
    const visible = all.filter((s) => scopeVisible(s.scope, s.teamId, s.ownerId, subject));
    if (visible.length === 0) return [];
    const installs = await this.db
      .select()
      .from(skillInstallations)
      .where(inArray(skillInstallations.skillId, visible.map((s) => s.id)));
    const out: Array<{ skill: typeof skills.$inferSelect; version: typeof skillVersions.$inferSelect }> = [];
    for (const s of visible) {
      const mine = installs.filter(
        (i) =>
          i.skillId === s.id &&
          (i.scope === 'global' || (i.scope === 'team' && i.subjectId === subject.teamId) || (i.scope === 'personal' && i.subjectId === subject.userId)),
      );
      // Désactivation à n'importe quelle portée applicable → inactif ; sinon actif par défaut.
      if (mine.some((i) => !i.enabled)) continue;
      const pinned = mine.find((i) => i.pinnedVersion)?.pinnedVersion;
      const [v] = await this.db
        .select()
        .from(skillVersions)
        .where(and(eq(skillVersions.skillId, s.id), pinned ? eq(skillVersions.version, pinned) : eq(skillVersions.version, s.latestVersion)))
        .orderBy(desc(skillVersions.version))
        .limit(1);
      if (v) out.push({ skill: s, version: v });
    }
    return out;
  }

  async files(ws: Ws): Promise<Array<{ path: string; content: string }>> {
    const active = await this.activeSkills(ws);
    return active.flatMap(({ skill, version }) =>
      version.files.map((f) => ({
        path: `home/agent/.pi/agent/skills/${skill.name}/${f.path.replace(/^\/+/, '').replace(/\.\.\//g, '')}`,
        content: f.content,
      })),
    );
  }

  async allowedMcpTools(ws: Pick<Ws, 'ownerId' | 'teamId'>) {
    const subject = { userId: ws.ownerId, teamId: ws.teamId };
    const servers = (await this.db.select().from(mcpServers).where(eq(mcpServers.enabled, true))).filter((s) =>
      scopeVisible(s.scope, s.teamId, s.ownerId, subject),
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
