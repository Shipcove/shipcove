import { Controller, Get, Inject, Logger, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { SecretProvider } from '@cap/secrets';
import { llmModels, llmRequests, workspaces, type Database } from '@cap/database';
import {
  DB,
  ENV,
  EventsService,
  QuotaExceededError,
  QuotaService,
  SECRETS,
  SettingsService,
  estimateInputTokens,
  normalizeOpenAiUsage,
  redactString,
  type NormalizedUsage,
  EnvironmentService,
  scrubSecrets,
  LiteLlmClient,
  modelAllowedFor,
} from '@cap/server-core';
import type { GatewayEnv } from '../env.js';
import { RunTokenService, type RunPrincipal } from '../run-token.service.js';

function openAiError(res: Response, status: number, code: string, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ error: { message, type: code, code } });
}

/**
 * Proxy LLM compatible OpenAI exposé aux sandboxes (ADR 0005).
 * Chaque appel : authentification du jeton de run → contrôle du run et du modèle →
 * réservation atomique de crédits → relais vers LiteLLM → régularisation idempotente.
 */
@Controller('llm/v1')
export class LlmProxyController {
  private readonly logger = new Logger('LlmProxy');

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: GatewayEnv,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly tokens: RunTokenService,
    private readonly quotas: QuotaService,
    private readonly settings: SettingsService,
    private readonly events: EventsService,
    private readonly environment: EnvironmentService,
    private readonly litellm: LiteLlmClient,
  ) {}


  @Get('models')
  async models(@Req() req: Request, @Res() res: Response) {
    const p = await this.tokens.authenticate(req.headers.authorization);
    if (!p) return openAiError(res, 401, 'unauthenticated', 'Jeton de run invalide');
    const rows = await this.allowedModels(p.userId);
    res.json({ object: 'list', data: rows.map((m) => ({ id: m.litellmModel, object: 'model', owned_by: 'platform' })) });
  }

  @Post('chat/completions')
  async chat(@Req() req: Request, @Res() res: Response) {
    const started = Date.now();
    const principal = await this.tokens.authenticate(req.headers.authorization);
    if (!principal) return openAiError(res, 401, 'unauthenticated', 'Jeton de run invalide ou expiré');
    // Aucun appel LLM hors d'un run actif (interruption, pause quota, fin de run).
    if (principal.runStatus !== 'running' || !principal.runId) {
      return openAiError(res, 409, 'run_not_active', 'Aucun run actif : appel LLM refusé');
    }
    const body = req.body as Record<string, unknown>;
    const modelName = String(body?.model ?? '');
    const model = (await this.allowedModels(principal.userId)).find((m) => m.litellmModel === modelName);
    if (!model) return openAiError(res, 403, 'model_not_allowed', `Modèle non autorisé : ${modelName}`);

    const quotaSettings = await this.settings.section('quotas');
    const requestedOut = Number(body.max_completion_tokens ?? body.max_tokens ?? 0) || quotaSettings.defaultOutputReservation;
    const estimatedOut = Math.min(requestedOut, model.maxOutputTokens);
    const estimatedIn = estimateInputTokens(JSON.stringify(body.messages ?? []).length + JSON.stringify(body.tools ?? []).length);

    let reservation;
    try {
      reservation = await this.quotas.reserve({
        userId: principal.userId,
        workspaceId: principal.workspaceId,
        runId: principal.runId,
        modelId: model.id,
        estimatedInputTokens: Math.min(estimatedIn, model.contextWindow),
        estimatedOutputTokens: estimatedOut,
      });
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        // Non rejouable : Pi termine son tour ; le worker suspend le run proprement.
        return openAiError(res, 402, 'quota_exceeded', `Quota atteint (${err.window}). L'agent est suspendu jusqu'à la reprise.`);
      }
      throw err;
    }
    await this.touch(principal.workspaceId);

    const stream = body.stream === true;
    const upstreamBody = {
      ...body,
      model: model.litellmModel,
      ...(stream ? { stream_options: { ...(body.stream_options as object | undefined), include_usage: true } } : {}),
      user: principal.userId,
      metadata: { cap_request_id: reservation.requestId, cap_workspace_id: principal.workspaceId, cap_run_id: principal.runId },
    };
    const abort = new AbortController();
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        clientGone = true;
        abort.abort();
      }
    });

    let upstream: globalThis.Response;
    try {
      const conn = await this.litellm.connection();
      upstream = await fetch(`${conn.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(conn.key ? { Authorization: `Bearer ${conn.key}` } : {}), 'x-litellm-call-id': reservation.requestId },
        // Secrets de l'environnement du workspace retirés de ce qui part vers le fournisseur LLM
        // (ex. sortie d'une commande ayant affiché une variable secrète).
        body: scrubSecrets(JSON.stringify(upstreamBody), (await this.environment.forWorkspace(principal.workspaceId)).secretValues),
        signal: abort.signal,
      });
    } catch (err) {
      // Requête jamais acceptée par LiteLLM : aucun débit.
      await this.quotas.release(reservation.requestId, redactString((err as Error).message));
      return openAiError(res, 502, 'upstream_unavailable', 'Passerelle LLM indisponible');
    }
    const callId = upstream.headers.get('x-litellm-call-id') ?? reservation.requestId;
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      await this.quotas.release(reservation.requestId, redactString(text.slice(0, 1000)), upstream.status);
      res.status(upstream.status).type('application/json').send(text || JSON.stringify({ error: { message: 'Erreur LLM' } }));
      return;
    }
    await this.db.update(llmRequests).set({ status: 'streaming', litellmCallId: callId, httpStatus: upstream.status }).where(eq(llmRequests.id, reservation.requestId));

    let usage: NormalizedUsage | null = null;
    let providerCost: string | null = upstream.headers.get('x-litellm-response-cost');
    try {
      if (!stream) {
        const json = (await upstream.json()) as Record<string, unknown>;
        usage = normalizeOpenAiUsage(json.usage);
        res.status(200).json(json);
      } else {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const chunk = JSON.parse(data) as { usage?: unknown };
              if (chunk.usage) usage = normalizeOpenAiUsage(chunk.usage) ?? usage;
            } catch {
              /* fragment non JSON */
            }
          }
        }
        res.end();
      }
    } catch (err) {
      if (!clientGone) this.logger.warn(`Flux LLM interrompu : ${redactString((err as Error).message)}`);
      if (!res.headersSent) openAiError(res, 502, 'upstream_error', 'Flux LLM interrompu');
      else res.end();
    }
    providerCost = upstream.headers.get('x-litellm-response-cost') ?? providerCost;
    const latencyMs = Date.now() - started;
    if (usage) {
      await this.quotas.settle(reservation.requestId, usage, { providerCostUsd: providerCost, latencyMs, litellmCallId: callId });
      await this.emitUsage(principal);
    } else {
      // Usage inconnu (flux interrompu) : réconciliation ultérieure, rien n'est inventé.
      await this.quotas.markPendingReconciliation(reservation.requestId, { litellmCallId: callId, error: clientGone ? 'client_aborted' : 'usage_missing' });
    }
  }

  /** Modèles activés et disponibles (ouverts à tous les utilisateurs). */
  /** Modèles activés, disponibles et accessibles à l'utilisateur (liste blanche vide = tous). */
  private async allowedModels(userId: string) {
    const rows = await this.db
      .select()
      .from(llmModels)
      .where(and(eq(llmModels.enabled, true), eq(llmModels.available, true), isNull(llmModels.deletedAt)));
    return rows.filter((m) => modelAllowedFor(m, userId));
  }

  private async touch(workspaceId: string) {
    await this.db.update(workspaces).set({ lastActivityAt: sql`now()` }).where(eq(workspaces.id, workspaceId));
  }

  private async emitUsage(p: RunPrincipal) {
    try {
      // Signal de rafraîchissement : le client relit ses quotas (en %) via GET /usage.
      await this.events.emit(p.workspaceId, 'usage.updated', {}, p.runId);
    } catch (err) {
      this.logger.warn(`usage.updated : ${(err as Error).message}`);
    }
  }
}
