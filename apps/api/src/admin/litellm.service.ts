import { Injectable } from '@nestjs/common';
import { LiteLlmClient } from '@cap/server-core';

/** Appels directs de l'API à LiteLLM (titres, tests, santé), via la connexion configurée. */
@Injectable()
export class LiteLlmAdminService {
  constructor(private readonly client: LiteLlmClient) {}

  /**
   * Complétion courte (titres de conversation) : appel direct à LiteLLM, hors quotas des
   * utilisateurs, sans limite de tokens. `responseFormat` contraint la sortie (JSON Schema).
   * Renvoie aussi la raison d'arrêt et la présence d'un raisonnement, pour expliquer une réponse vide.
   */
  async complete(
    model: string,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    opts: { responseFormat?: Record<string, unknown> } = {},
  ): Promise<{ content: string; finishReason: string | null; reasoning: boolean }> {
    const r = await this.client.request<{ choices?: Array<{ finish_reason?: string; message?: { content?: string | null; reasoning_content?: string | null } }> }>(
      'POST',
      '/v1/chat/completions',
      { model, messages, temperature: 0.2, ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}) },
      120_000,
    );
    const c = r.choices?.[0];
    return { content: c?.message?.content ?? '', finishReason: c?.finish_reason ?? null, reasoning: !!c?.message?.reasoning_content };
  }

  /** Test réel d'un modèle (appel minimal). */
  async test(modelName: string): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const t0 = Date.now();
    try {
      const r = await this.client.request<{ choices?: Array<{ message?: { content?: string } }> }>(
        'POST',
        '/v1/chat/completions',
        { model: modelName, messages: [{ role: 'user', content: 'Réponds uniquement « ok ».' }], max_tokens: 8 },
        60_000,
      );
      return { ok: true, latencyMs: Date.now() - t0, detail: (r.choices?.[0]?.message?.content ?? '').slice(0, 100) };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (err as Error).message };
    }
  }

  health(): Promise<boolean> {
    return this.client.health();
  }
}
