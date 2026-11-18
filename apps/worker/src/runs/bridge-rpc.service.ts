import { Injectable, Logger } from '@nestjs/common';
import type { BridgeRequest } from '@cap/agent-runtime';
import { EnvironmentService, redactString } from '@cap/server-core';
import { toUserPath } from '@cap/storage';
import { CheckpointService } from '../sandbox/checkpoint.service.js';
import { SandboxManager } from '../sandbox/sandbox-manager.service.js';
import { GitBrokerService } from '../git/git-broker.service.js';
import { McpBridgeService } from '../mcp/mcp-bridge.service.js';
import { ServicesService } from '../sandbox/services.service.js';
import { AgentFilesService } from '../sandbox/agent-files.service.js';
import type { RunContext } from './run-orchestrator.service.js';

/**
 * Requêtes de l'extension « platform bridge » (dialogue bloquant côté Pi).
 * Toute réponse est un JSON `{ ok, text }` ; aucune donnée sensible n'y figure.
 */
@Injectable()
export class BridgeRpcService {
  private readonly logger = new Logger('Bridge');

  constructor(
    private readonly checkpoints: CheckpointService,
    private readonly sandboxes: SandboxManager,
    private readonly git: GitBrokerService,
    private readonly mcp: McpBridgeService,
    private readonly services: ServicesService,
    private readonly environment: EnvironmentService,
    private readonly agentFiles: AgentFilesService,
  ) {}

  async handle(ctx: RunContext, req: BridgeRequest): Promise<string> {
    if (req.kind === 'checkpoint') {
      const toolCallId = (req.payload as { toolCallId?: string } | null)?.toolCallId ?? `unknown-${Date.now()}`;
      try {
        const res = await this.checkpoints.run({
          workspaceId: ctx.workspaceId,
          fencingToken: ctx.sandbox.fencingToken,
          provider: this.sandboxes.provider,
          handle: ctx.sandbox.handle,
          reason: 'tool',
          triggerKey: `tool:${ctx.runId}:${toolCallId}`,
          runId: ctx.runId,
        });
        const paths = res.changed.map((c) => toUserPath(c.path)).filter((p): p is string => !!p);
        ctx.toolFiles.set(toolCallId, paths.slice(0, 200));
        return JSON.stringify({ ok: true, text: `checkpoint ${res.generation}` });
      } catch {
        // L'agent poursuit ; l'état « non synchronisé » est signalé et un nouveau checkpoint sera tenté.
        ctx.toolFiles.set(toolCallId, []);
        return JSON.stringify({ ok: false, text: 'checkpoint en échec (nouvelle tentative programmée)' });
      }
    }
    const { method, params } = (req.payload ?? {}) as { method?: string; params?: Record<string, unknown> };
    try {
      switch (method) {
        case 'git.request': {
          const text = await this.git.requestFromAgent(ctx, params ?? {});
          return JSON.stringify({ ok: true, text });
        }
        case 'git.ci_status': {
          const text = await this.git.ciStatus(ctx.workspaceId, String(params?.ref ?? 'HEAD'));
          return JSON.stringify({ ok: true, text });
        }
        case 'mcp.call': {
          const text = await this.mcp.call(ctx, String(params?.server), String(params?.tool), (params?.arguments as Record<string, unknown>) ?? {});
          return JSON.stringify({ ok: true, text });
        }
        case 'files.share': {
          const toolCallId = String(params?.toolCallId ?? '');
          const { files, errors } = await this.agentFiles.share(ctx.sandbox, params?.paths, ctx.secretValues);
          // Rattachés à l'appel d'outil à sa fin (carte de téléchargement dans la conversation).
          if (toolCallId && files.length) ctx.sharedFiles.set(toolCallId, [...(ctx.sharedFiles.get(toolCallId) ?? []), ...files]);
          const lines = [
            ...(files.length ? [`Proposé${files.length > 1 ? 's' : ''} au téléchargement dans la conversation : ${files.map((f) => f.path).join(', ')}`] : []),
            ...errors.map((e) => `Non partagé — ${e}`),
          ];
          return JSON.stringify({ ok: files.length > 0, text: lines.join('\n') });
        }
        case 'services.catalog':
          return JSON.stringify({ ok: true, text: await this.services.catalogText() });
        case 'services.status':
          return JSON.stringify({ ok: true, text: await this.services.status(ctx.sandbox) });
        case 'services.start': {
          const env = await this.environment.forWorkspace(ctx.workspaceId);
          const p = params ?? {};
          const text = await this.services.start(ctx.sandbox, env, {
            service: String(p.service ?? ''),
            name: typeof p.name === 'string' ? p.name : undefined,
            env: p.env && typeof p.env === 'object' ? Object.fromEntries(Object.entries(p.env as Record<string, unknown>).map(([k, v]) => [k, String(v)])) : undefined,
            memoryMb: typeof p.memoryMb === 'number' ? p.memoryMb : undefined,
          });
          await this.sandboxes.touch(ctx.workspaceId);
          return JSON.stringify({ ok: true, text });
        }
        case 'services.stop':
          return JSON.stringify({ ok: true, text: await this.services.stop(ctx.sandbox, String(params?.name ?? '')) });
        case 'services.logs': {
          const env = await this.environment.forWorkspace(ctx.workspaceId);
          const text = await this.services.logs(ctx.sandbox, env, String(params?.name ?? params?.service ?? ''), Number(params?.lines ?? 100) || 100);
          return JSON.stringify({ ok: true, text });
        }
        default:
          return JSON.stringify({ ok: false, text: `Méthode inconnue : ${method}` });
      }
    } catch (err) {
      const msg = redactString((err as Error).message);
      this.logger.warn(`bridge ${method}: ${msg}`);
      return JSON.stringify({ ok: false, text: msg });
    }
  }
}
