import { Injectable } from '@nestjs/common';
import { LiteLlmClient } from '@cap/server-core';

/** Appels directs de l'API à LiteLLM (titres, tests, santé), via la connexion configurée. */
@Injectable()
export class LiteLlmAdminService {
  constructor(private readonly client: LiteLlmClient) {}

  /** Complétion courte (titres de conversation) : appel direct à LiteLLM, hors quotas des utilisateurs. */
  async complete(model: string, messages: Array<{ role: 'system' | 'user'; content: string }>, maxTokens: number): Promise<string> {
    const r = await this.client.request<{ choices?: Array<{ message?: { content?: string } }> }>('POST', '/v1/chat/completions', { model, messages, max_tokens: maxTokens, temperature: 0.2 }, 60_000);
    return r.choices?.[0]?.message?.content ?? '';
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
