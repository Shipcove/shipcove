import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { SecretProvider } from '@cap/secrets';
import { llmModels, modelCoefficients, type Database } from '@cap/database';
import { ENV, type BaseEnv } from '../config/config.js';
import { DB, SECRETS } from '../tokens.js';
import { AppError } from '../common/errors.js';
import { redactString } from '../common/redact.js';
import { fetchSameOrigin } from '../common/safe-fetch.js';

/** Unité de compte : 1 crédit = 0,001 USD (préremplissage des coefficients depuis les prix LiteLLM). */
export const USD_PER_CREDIT = 0.001;

export interface LiteLlmConnectionInfo {
  url: string;
  key: string | undefined;
  source: 'admin' | 'env';
}

/** Modèle tel que décrit par LiteLLM (`/model/info`, sinon `/v1/models`). */
export interface DiscoveredModel {
  name: string;
  provider: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsImages: boolean;
  supportsReasoning: boolean;
  /** Prix en USD par token, quand LiteLLM les connaît. */
  costs: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
}

interface ModelInfoEntry {
  model_name: string;
  litellm_params?: { model?: string; custom_llm_provider?: string };
  model_info?: {
    mode?: string | null;
    litellm_provider?: string | null;
    max_input_tokens?: number | null;
    max_tokens?: number | null;
    max_output_tokens?: number | null;
    supports_vision?: boolean | null;
    supports_reasoning?: boolean | null;
    input_cost_per_token?: number | null;
    output_cost_per_token?: number | null;
    cache_read_input_token_cost?: number | null;
    cache_creation_input_token_cost?: number | null;
  };
}

const CACHE_MS = 30_000;

/**
 * Accès à LiteLLM partagé par l'API, la gateway et le worker. L'URL et la clé maître sont dans
 * Vault (`infra/litellm`, réglables depuis l'administration) ; à défaut d'URL, `LITELLM_URL`.
 * Un changement est pris en compte par toutes les instances en moins de 30 s.
 */
@Injectable()
export class LiteLlmClient {
  private cache: { at: number; value: LiteLlmConnectionInfo } | null = null;

  constructor(
    @Inject(ENV) private readonly env: BaseEnv,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    @Inject(DB) private readonly db: Database,
  ) {}

  async connection(): Promise<LiteLlmConnectionInfo> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const data = await this.secrets.read(this.env.LITELLM_MASTER_KEY_REF).catch(() => ({}) as Record<string, string>);
    const value: LiteLlmConnectionInfo = {
      url: (data['url'] || this.env.LITELLM_URL).replace(/\/+$/, ''),
      key: data['masterKey'] || undefined,
      source: data['url'] ? 'admin' : 'env',
    };
    this.cache = { at: Date.now(), value };
    return value;
  }

  /** Enregistre l'URL (et la clé si fournie, sinon la clé actuelle est conservée). */
  async saveConnection(url: string, masterKey?: string): Promise<void> {
    const prev = await this.secrets.read(this.env.LITELLM_MASTER_KEY_REF).catch(() => ({}) as Record<string, string>);
    const key = masterKey ?? prev['masterKey'];
    await this.secrets.write(this.env.LITELLM_MASTER_KEY_REF.replace(/^vault:/, ''), { ...prev, url: url.replace(/\/+$/, ''), ...(key ? { masterKey: key } : {}) });
    this.cache = null;
  }

  invalidate(): void {
    this.cache = null;
  }

  /** Appel authentifié (clé maître) ; erreurs ramenées à un message sans secret. */
  async request<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000, conn?: LiteLlmConnectionInfo): Promise<T> {
    const c = conn ?? (await this.connection());
    let res: Response;
    try {
      res = await fetchSameOrigin(`${c.url}${path}`, {
        method,
        headers: { ...(c.key ? { Authorization: `Bearer ${c.key}` } : {}), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new AppError('conflict', `LiteLLM injoignable (${c.url}) : ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new AppError('conflict', `LiteLLM ${path} : HTTP ${res.status} ${redactString(text.slice(0, 300))}`);
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new AppError('conflict', `LiteLLM ${path} : réponse non JSON (est-ce bien l’URL du proxy LiteLLM ?)`);
    }
  }

  async health(): Promise<boolean> {
    const c = await this.connection();
    try {
      const res = await fetchSameOrigin(`${c.url}/health/liveliness`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Modèles de conversation exposés par LiteLLM. `/model/info` (clé d'administration) décrit
   * capacités et prix ; avec une clé limitée, repli sur `/v1/models` (noms seuls).
   */
  async discover(conn?: LiteLlmConnectionInfo): Promise<DiscoveredModel[]> {
    let entries: ModelInfoEntry[];
    try {
      entries = (await this.request<{ data?: ModelInfoEntry[] }>('GET', '/model/info', undefined, 20_000, conn)).data ?? [];
    } catch (err) {
      const list = await this.request<{ data?: Array<{ id: string; owned_by?: string }> }>('GET', '/v1/models', undefined, 20_000, conn).catch(() => {
        throw err;
      });
      entries = (list.data ?? []).map((m) => ({ model_name: m.id }));
    }
    const byName = new Map<string, DiscoveredModel>();
    for (const e of entries) {
      const info = e.model_info ?? {};
      if (info.mode && !['chat', 'responses', 'completion'].includes(info.mode)) continue; // embeddings, images, audio…
      if (!e.model_name || byName.has(e.model_name)) continue; // plusieurs déploiements : un seul modèle
      const provider = info.litellm_provider ?? e.litellm_params?.custom_llm_provider ?? e.litellm_params?.model?.split('/')[0] ?? 'litellm';
      const hasCost = typeof info.input_cost_per_token === 'number' || typeof info.output_cost_per_token === 'number';
      byName.set(e.model_name, {
        name: e.model_name,
        provider,
        contextWindow: positive(info.max_input_tokens) ?? positive(info.max_tokens),
        maxOutputTokens: positive(info.max_output_tokens) ?? (info.max_input_tokens ? positive(info.max_tokens) : null),
        supportsImages: !!info.supports_vision,
        supportsReasoning: !!info.supports_reasoning,
        costs: hasCost
          ? {
              input: info.input_cost_per_token ?? 0,
              output: info.output_cost_per_token ?? 0,
              cacheRead: info.cache_read_input_token_cost ?? info.input_cost_per_token ?? 0,
              cacheWrite: info.cache_creation_input_token_cost ?? info.input_cost_per_token ?? 0,
            }
          : null,
      });
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Synchronise le catalogue avec LiteLLM : nouveaux modèles ajoutés **désactivés** (l'administrateur
   * les active après avoir vérifié coefficients et accès), modèles disparus marqués indisponibles.
   * Les réglages de l'administrateur ne sont jamais écrasés.
   */
  async syncModels(actorId: string | null = null): Promise<{ discovered: number; added: string[]; missing: string[] }> {
    const found = await this.discover();
    const names = new Set(found.map((m) => m.name));
    const rows = await this.db.select().from(llmModels).where(isNull(llmModels.deletedAt));
    const known = new Map(rows.map((r) => [r.litellmModel, r]));
    const now = new Date();
    const added: string[] = [];
    for (const d of found) {
      const row = known.get(d.name);
      if (row) {
        if (!row.available || row.lastSyncError) {
          await this.db.update(llmModels).set({ available: true, lastSyncError: null, lastSyncAt: now }).where(eq(llmModels.id, row.id));
        } else {
          await this.db.update(llmModels).set({ lastSyncAt: now }).where(eq(llmModels.id, row.id));
        }
        continue;
      }
      const inserted = await this.db
        .insert(llmModels)
        .values({
          litellmModel: d.name,
          displayName: d.name,
          provider: d.provider,
          contextWindow: d.contextWindow ?? 128_000,
          maxOutputTokens: d.maxOutputTokens ?? 8_192,
          supportsImages: d.supportsImages,
          supportsReasoning: d.supportsReasoning,
          enabled: false,
          isDefault: false,
          available: true,
          lastSyncAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: llmModels.id });
      if (!inserted[0]) continue; // ajouté entre-temps par une autre instance
      const perK = (usdPerToken: number) => ((usdPerToken * 1000) / USD_PER_CREDIT).toFixed(6);
      const c = d.costs ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      await this.db.insert(modelCoefficients).values({ modelId: inserted[0].id, version: 1, input: perK(c.input), output: perK(c.output), cacheRead: perK(c.cacheRead), cacheWrite: perK(c.cacheWrite), createdBy: actorId });
      added.push(d.name);
    }
    const missing: string[] = [];
    for (const r of rows) {
      if (names.has(r.litellmModel)) continue;
      missing.push(r.litellmModel);
      if (r.available || r.lastSyncError !== 'Absent de LiteLLM') {
        await this.db.update(llmModels).set({ available: false, lastSyncError: 'Absent de LiteLLM', lastSyncAt: now }).where(and(eq(llmModels.id, r.id), isNull(llmModels.deletedAt)));
      }
    }
    return { discovered: found.length, added, missing };
  }
}

/** Liste blanche d'un modèle : vide = accessible à tous. */
export function modelAllowedFor(model: { allowedUserIds: string[] }, userId: string): boolean {
  return model.allowedUserIds.length === 0 || model.allowedUserIds.includes(userId);
}

function positive(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}
