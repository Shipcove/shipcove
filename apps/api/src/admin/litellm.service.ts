import { Inject, Injectable, Logger } from '@nestjs/common';
import type { SecretProvider } from '@cap/secrets';
import { AppError, ENV, SECRETS, redactString, type BaseEnv } from '@cap/server-core';

/** Administration de LiteLLM via son API de gestion (modèles stockés dans la base de LiteLLM). */
@Injectable()
export class LiteLlmAdminService {
  private readonly logger = new Logger('LiteLLM');
  constructor(
    @Inject(ENV) private readonly env: BaseEnv,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
  ) {}

  private async headers() {
    const key = await this.secrets.readKey(this.env.LITELLM_MASTER_KEY_REF, 'masterKey');
    if (!key) throw new AppError('secret_backend_unavailable', 'Clé maître LiteLLM absente de Vault');
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.env.LITELLM_URL}${path}`, { method, headers: await this.headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw new AppError('conflict', `LiteLLM injoignable : ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new AppError('conflict', `LiteLLM ${path} : HTTP ${res.status} ${redactString(text.slice(0, 300))}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async findIds(modelName: string): Promise<string[]> {
    const r = await this.call<{ data: Array<{ model_name: string; model_info?: { id?: string } }> }>('GET', '/model/info');
    return r.data.filter((m) => m.model_name === modelName && m.model_info?.id).map((m) => m.model_info!.id!);
  }

  /** Crée ou remplace la déclaration du modèle dans LiteLLM. */
  async upsert(modelName: string, params: Record<string, unknown>, apiKey?: string): Promise<void> {
    for (const id of await this.findIds(modelName)) await this.call('POST', '/model/delete', { id });
    await this.call('POST', '/model/new', { model_name: modelName, litellm_params: { ...params, ...(apiKey ? { api_key: apiKey } : {}) } });
  }

  async remove(modelName: string): Promise<void> {
    for (const id of await this.findIds(modelName)) await this.call('POST', '/model/delete', { id });
  }

  /** Test réel d'un modèle (appel minimal). */
  async test(modelName: string): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const t0 = Date.now();
    try {
      const r = await this.call<{ choices?: Array<{ message?: { content?: string } }> }>('POST', '/v1/chat/completions', {
        model: modelName,
        messages: [{ role: 'user', content: 'Réponds uniquement « ok ».' }],
        max_tokens: 8,
      });
      return { ok: true, latencyMs: Date.now() - t0, detail: (r.choices?.[0]?.message?.content ?? '').slice(0, 100) };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (err as Error).message };
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.env.LITELLM_URL}/health/liveliness`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
