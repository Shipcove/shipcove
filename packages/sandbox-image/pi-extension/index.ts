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

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }], details: {} });
/**
 * Réponse de la plateforme : Pi ne tient pas compte d'un champ `isError` renvoyé par un outil,
 * seule une exception marque l'appel en échec (affiché comme tel et transmis au modèle).
 */
const reply = (r: { ok: boolean; text: string }) => {
  if (!r.ok) throw new Error(r.text);
  return text(r.text);
};

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

  // 2. Forges Git (ADR 0013) : git push, gh et glab fonctionnent directement (authentifiés par la
  //    plateforme). Seules les opérations sensibles passent par ces outils, après approbation.
  pi.registerTool({
    name: 'platform_git_push',
    label: 'Publier sur une branche protégée (approbation requise)',
    description:
      'Demande la publication d’une branche locale vers la branche PAR DÉFAUT ou une branche PROTÉGÉE du dépôt du projet, ' +
      'après approbation humaine de l’opération exacte. Pour toute autre branche, utilisez directement `git push`.',
    promptSnippet: 'Publier sur la branche par défaut / protégée (approbation humaine)',
    promptGuidelines: [
      'git push, gh and glab work directly in this sandbox, authenticated as the user by the platform: push work branches, open and update PRs/MRs, comment, read CI logs and issues with them.',
      'The platform refuses, for gh/glab/git: pushing to the default or a protected branch, merging, deleting branches or tags, changing repository settings, and creating keys or tokens. For these, use platform_git_push, platform_merge_pull_request or platform_delete_remote_branch (human approval), or ask the user.',
      'After calling a platform_* Git tool, tell the user an approval is pending; do not retry.',
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
      return reply(r);
    },
  });

  pi.registerTool({
    name: 'platform_create_pull_request',
    label: 'Créer une PR/MR (approbation requise)',
    description:
      'Demande la création d’une pull request (GitHub) ou merge request (GitLab) après approbation humaine. ' +
      'En général, préférez `gh pr create` ou `glab mr create`, qui ne demandent pas d’approbation.',
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
      return reply(r);
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
      return reply(r);
    },
  });

  pi.registerTool({
    name: 'platform_delete_remote_branch',
    label: 'Supprimer une branche distante (approbation requise)',
    description: 'Demande la suppression d’une branche du dépôt distant. Exécutée après approbation humaine.',
    parameters: Type.Object({ branch: Type.String() }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const r = await rpc(ctx, 'git.request', { toolCallId, action: 'delete_remote_branch', branch: params.branch });
      return reply(r);
    },
  });

  pi.registerTool({
    name: 'platform_ci_status',
    label: 'État CI/CD',
    description: 'Lit l’état des pipelines CI/CD (checks GitHub, pipelines GitLab) pour une branche ou un commit du dépôt du projet.',
    parameters: Type.Object({ ref: Type.String({ description: 'Branche ou SHA' }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const r = await rpc(ctx, 'git.ci_status', { ref: params.ref });
      return reply(r);
    },
  });

  // 3. Services d'appui (bases de données, caches, files…) : catalogue approuvé par
  //    l'administrateur ; Pi les lance lui-même quand il en a besoin, rien ne démarre sans lui.
  let catalog: Array<{ key: string; name: string; image: string; port: number | null; defaultEnv: Record<string, string>; maxMemoryMb: number }> = [];
  try {
    catalog = JSON.parse(readFileSync('/run/cap/services.json', 'utf8')) as typeof catalog;
  } catch {
    catalog = [];
  }
  if (catalog.length) {
    const listing = catalog
      .map((c) => `${c.key} — ${c.name}${c.port ? `, localhost:${c.port}` : ''}${Object.keys(c.defaultEnv).length ? ` (défaut : ${Object.entries(c.defaultEnv).map(([k, v]) => `${k}=${v}`).join(', ')})` : ''}`)
      .join(' ; ');
    pi.registerTool({
      name: 'platform_services',
      label: 'Services d’appui (bases de données, caches, files)',
      description:
        'Lance à la demande des services d’appui dans le réseau de la sandbox (joignables sur localhost), pour exécuter ' +
        'l’application ou ses tests. Disponibles : ' + listing + '. ' +
        'Actions : « start » (service = clé, name optionnel pour une 2e instance, env pour les variables du conteneur — ' +
        '« ${NOM} » reprend une variable ou un secret du projet sans que tu en connaisses la valeur —, memoryMb), ' +
        '« stop » (name), « status », « logs » (name, lines), « catalog ». Les services durent autant que la sandbox ; leurs ' +
        'données sont éphémères (refais les migrations / données de test après un redémarrage).',
      promptSnippet: 'Lancer PostgreSQL, Redis, RabbitMQ… à la demande sur localhost (catalogue de la plateforme)',
      promptGuidelines: [
        'When the code or its tests need a database, cache or message broker, start it with platform_services instead of installing or running it yourself; Docker is not available in the sandbox.',
        'Only start the services you actually need, and reuse a running one (action « status »).',
        'Use the clients installed in the sandbox (psql, pg_dump, redis-cli) to create tables, run migrations or inspect data. Never put a password on a command line (no PGPASSWORD=…, no password in a psql URL): psql reads it from PGPASSFILE, written when the service starts.',
      ],
      parameters: Type.Object({
        action: Type.Union([Type.Literal('start'), Type.Literal('stop'), Type.Literal('status'), Type.Literal('logs'), Type.Literal('catalog')]),
        service: Type.Optional(Type.String({ description: 'Clé du catalogue (start)' })),
        name: Type.Optional(Type.String({ description: 'Nom de l’instance (start, stop, logs)' })),
        env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Variables du conteneur (start)' })),
        memoryMb: Type.Optional(Type.Number({ description: 'Mémoire en Mo (start)' })),
        lines: Type.Optional(Type.Number({ description: 'Lignes de journal (logs, défaut 100)' })),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const r = await rpc(ctx, `services.${params.action}`, { service: params.service, name: params.name ?? params.service, env: params.env, memoryMb: params.memoryMb, lines: params.lines });
        return reply(r);
      },
    });
  }

  // 4. Pont MCP : la liste des outils autorisés est fournie par le worker au démarrage.
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
        return reply(r);
      },
    });
  }
}
