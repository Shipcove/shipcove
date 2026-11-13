/**
 * Extension Pi « platform bridge » — préinstallée dans l'image, en lecture seule pour l'agent.
 *
 * Canal : sous-protocole officiel `extension_ui_request` / `extension_ui_response` du mode RPC.
 * Le worker de la plateforme répond aux requêtes dont le titre commence par `__cap_` ;
 * aucune connexion réseau n'est nécessaire et aucun secret n'est présent dans la sandbox.
 *
 * Rôle :
 *  1. Checkpoint bloquant après chaque outil susceptible d'écrire (cohérence : l'agent ne
 *     poursuit qu'une fois l'état du système de fichiers capturé). Le worker effectue aussi un
 *     checkpoint indépendant sur `tool_execution_end` : la sécurité ne dépend pas de cette extension.
 *  2. Outils plateforme pour les opérations Git distantes : ils créent des demandes d'approbation
 *     (push, PR/MR, merge, suppression de branche) exécutées hors sandbox après décision humaine.
 *  3. Pont MCP : outils MCP autorisés par la politique, relayés par le worker.
 */
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import { readFileSync } from 'node:fs';

const READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

async function rpc(ctx: ExtensionContext, method: string, params: unknown): Promise<{ ok: boolean; text: string; data?: unknown }> {
  const raw = await ctx.ui.input('__cap_rpc__', JSON.stringify({ method, params }));
  if (!raw) return { ok: false, text: 'La plateforme n’a pas répondu.' };
  try {
    return JSON.parse(raw) as { ok: boolean; text: string; data?: unknown };
  } catch {
    return { ok: false, text: 'Réponse invalide de la plateforme.' };
  }
}

const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], details: {}, isError });

interface McpToolConfig {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export default function platformBridge(pi: ExtensionAPI) {
  // 1. Checkpoint après chaque action potentiellement en écriture.
  pi.on('tool_result', async (event, ctx) => {
    if (READ_ONLY_TOOLS.has(event.toolName)) return undefined;
    await ctx.ui.input('__cap_checkpoint__', JSON.stringify({ toolCallId: event.toolCallId, toolName: event.toolName }));
    return undefined;
  });

  // 2. Opérations Git distantes soumises à approbation.
  pi.registerTool({
    name: 'platform_git_push',
    label: 'Publier une branche (approbation requise)',
    description:
      'Demande la publication (git push) d’une branche locale vers le dépôt distant du projet. ' +
      'Un humain doit approuver l’opération exacte (commits, cible) avant exécution. ' +
      'Les commandes `git push`, `gh` ou `glab` directes ne peuvent pas publier depuis cette sandbox.',
    promptSnippet: 'Publier une branche via la plateforme (approbation humaine)',
    promptGuidelines: [
      'Use platform_git_push to push commits: direct git push/gh/glab cannot reach the remote from this sandbox.',
      'After calling platform_git_push or platform_create_pull_request, tell the user an approval is pending; do not retry.',
    ],
    parameters: Type.Object({
      local_branch: Type.String({ description: 'Branche locale à publier' }),
      remote_branch: Type.Optional(Type.String({ description: 'Branche distante cible (défaut : même nom)' })),
      force: Type.Optional(Type.Boolean({ description: 'Push forcé (déconseillé)' })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await rpc(ctx, 'git.request', {
        toolCallId,
        action: 'push',
        localBranch: params.local_branch,
        remoteBranch: params.remote_branch ?? params.local_branch,
        force: params.force ?? false,
      });
      return text(r.text, !r.ok);
    },
  });

  pi.registerTool({
    name: 'platform_create_pull_request',
    label: 'Créer une PR/MR (approbation requise)',
    description:
      'Demande la création d’une pull request (GitHub) ou merge request (GitLab). La branche source doit déjà être publiée ' +
      '(platform_git_push). Exécutée après approbation humaine.',
    parameters: Type.Object({
      source_branch: Type.String(),
      target_branch: Type.String(),
      title: Type.String(),
      body: Type.Optional(Type.String()),
      draft: Type.Optional(Type.Boolean()),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await rpc(ctx, 'git.request', {
        toolCallId,
        action: 'create_pull_request',
        sourceBranch: params.source_branch,
        targetBranch: params.target_branch,
        title: params.title,
        body: params.body ?? '',
        draft: params.draft ?? false,
      });
      return text(r.text, !r.ok);
    },
  });

  pi.registerTool({
    name: 'platform_merge_pull_request',
    label: 'Fusionner une PR/MR (approbation requise)',
    description: 'Demande la fusion d’une pull/merge request existante. Exécutée après approbation humaine.',
    parameters: Type.Object({
      number: Type.Number(),
      method: Type.Optional(Type.Union([Type.Literal('merge'), Type.Literal('squash'), Type.Literal('rebase')])),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await rpc(ctx, 'git.request', { toolCallId, action: 'merge', number: params.number, method: params.method ?? 'merge' });
      return text(r.text, !r.ok);
    },
  });

  pi.registerTool({
    name: 'platform_delete_remote_branch',
    label: 'Supprimer une branche distante (approbation requise)',
    description: 'Demande la suppression d’une branche du dépôt distant. Exécutée après approbation humaine.',
    parameters: Type.Object({ branch: Type.String() }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await rpc(ctx, 'git.request', { toolCallId, action: 'delete_remote_branch', branch: params.branch });
      return text(r.text, !r.ok);
    },
  });

  pi.registerTool({
    name: 'platform_ci_status',
    label: 'État CI/CD',
    description: 'Lit l’état des pipelines CI/CD (checks GitHub, pipelines GitLab) pour une branche ou un commit du dépôt du projet.',
    parameters: Type.Object({ ref: Type.String({ description: 'Branche ou SHA' }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = await rpc(ctx, 'git.ci_status', { ref: params.ref });
      return text(r.text, !r.ok);
    },
  });

  // 3. Pont MCP : la liste des outils autorisés est fournie par le worker au démarrage.
  let mcpTools: McpToolConfig[] = [];
  try {
    mcpTools = JSON.parse(readFileSync('/run/cap/mcp-tools.json', 'utf8')) as McpToolConfig[];
  } catch {
    mcpTools = [];
  }
  for (const tool of mcpTools) {
    const name = `mcp__${tool.server}__${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
    pi.registerTool({
      name,
      label: `MCP ${tool.server}/${tool.name}`,
      description: tool.description || `Outil MCP ${tool.name} (serveur ${tool.server})`,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema ?? { type: 'object' }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const r = await rpc(ctx, 'mcp.call', { server: tool.server, tool: tool.name, arguments: params });
        return text(r.text, !r.ok);
      },
    });
  }
}
