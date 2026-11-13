import { readFile } from 'node:fs/promises';
import {
  SecretBackendError,
  SecretNotFoundError,
  assertSecretPath,
  parseRef,
  type SecretData,
  type SecretHealth,
  type SecretMetadata,
  type SecretProvider,
  type SecretRef,
} from './secret-provider.js';

export type VaultAuth =
  | { method: 'approle'; roleId?: string; roleIdFile?: string; secretId?: string; secretIdFile?: string; mount?: string }
  | { method: 'kubernetes'; role: string; jwtFile?: string; mount?: string }
  /** Jeton statique : réservé aux tests et au bootstrap. */
  | { method: 'token'; token: string };

export interface VaultProviderOptions {
  address: string;
  auth: VaultAuth;
  /** Point de montage KV v2 (défaut `cap`). */
  kvMount?: string;
  namespace?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface CachedToken {
  token: string;
  expiresAt: number;
  renewable: boolean;
}

/**
 * Implémentation officielle HashiCorp Vault (KV v2), via l'API HTTP.
 * - AppRole (Docker Compose) ou Kubernetes auth (Helm).
 * - Jeton de service mis en cache et renouvelé avant expiration.
 * - Les valeurs ne sont jamais journalisées.
 */
export class VaultSecretProvider implements SecretProvider {
  readonly backend = 'vault';
  private readonly kvMount: string;
  private readonly fetchImpl: typeof fetch;
  private cached: CachedToken | null = null;
  private loginPromise: Promise<CachedToken> | null = null;

  constructor(private readonly opts: VaultProviderOptions) {
    this.kvMount = opts.kvMount ?? 'cap';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  reference(path: string): SecretRef {
    assertSecretPath(path);
    return `vault:${path}`;
  }

  async write(path: string, data: SecretData): Promise<SecretRef> {
    assertSecretPath(path);
    await this.request('POST', `/v1/${this.kvMount}/data/${path}`, { data });
    return this.reference(path);
  }

  async read(ref: SecretRef): Promise<SecretData> {
    const path = parseRef(ref, this.backend);
    const res = await this.request<{ data: { data: SecretData } }>('GET', `/v1/${this.kvMount}/data/${path}`);
    if (!res) throw new SecretNotFoundError(ref);
    return res.data.data ?? {};
  }

  async readKey(ref: SecretRef, key: string): Promise<string | undefined> {
    const data = await this.read(ref);
    return data[key];
  }

  async metadata(ref: SecretRef): Promise<SecretMetadata | null> {
    const path = parseRef(ref, this.backend);
    const res = await this.request<{
      data: { current_version: number; created_time: string; updated_time: string };
    }>('GET', `/v1/${this.kvMount}/metadata/${path}`);
    if (!res) return null;
    return {
      ref,
      version: res.data.current_version,
      createdAt: res.data.created_time ?? null,
      updatedAt: res.data.updated_time ?? null,
    };
  }

  async rotate(ref: SecretRef, data: SecretData): Promise<SecretMetadata> {
    const path = parseRef(ref, this.backend);
    await this.write(path, data);
    const meta = await this.metadata(ref);
    if (!meta) throw new SecretBackendError('Rotation : métadonnées absentes après écriture');
    return meta;
  }

  async revoke(ref: SecretRef): Promise<void> {
    const path = parseRef(ref, this.backend);
    await this.request('DELETE', `/v1/${this.kvMount}/metadata/${path}`);
  }

  async health(): Promise<SecretHealth> {
    try {
      const res = await this.fetchWithTimeout(`${this.opts.address}/v1/sys/health?standbyok=true&perfstandbyok=true`, {
        method: 'GET',
      });
      const body = (await res.json().catch(() => ({}))) as { sealed?: boolean; version?: string; initialized?: boolean };
      if (body.sealed) return { ok: false, backend: this.backend, sealed: true, version: body.version, detail: 'Vault scellé' };
      if (!res.ok) return { ok: false, backend: this.backend, version: body.version, detail: `HTTP ${res.status}` };
      // Vérifie aussi que l'identité de service peut s'authentifier.
      await this.getToken();
      return { ok: true, backend: this.backend, sealed: false, version: body.version };
    } catch (err) {
      return { ok: false, backend: this.backend, detail: (err as Error).message };
    }
  }

  /* ------------------------------------------------------------------ */

  private async request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T | null> {
    const token = await this.getToken();
    const headers: Record<string, string> = { 'X-Vault-Token': token.token };
    if (this.opts.namespace) headers['X-Vault-Namespace'] = this.opts.namespace;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetchWithTimeout(`${this.opts.address}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) return null;
    if (res.status === 403 && retry && this.opts.auth.method !== 'token') {
      // Jeton révoqué/expiré : nouvelle authentification une seule fois.
      this.cached = null;
      return this.request<T>(method, path, body, false);
    }
    if (res.status === 204) return {} as T;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const msg = this.safeError(text);
      throw new SecretBackendError(`Vault ${method} ${path.split('/').slice(0, 4).join('/')} : HTTP ${res.status} ${msg}`, res.status, res.status >= 500 || res.status === 429);
    }
    return (await res.json()) as T;
  }

  private safeError(text: string): string {
    try {
      const parsed = JSON.parse(text) as { errors?: string[] };
      return (parsed.errors ?? []).join('; ').slice(0, 300);
    } catch {
      return '';
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 5000) });
    } catch (err) {
      throw new SecretBackendError(`Vault injoignable : ${(err as Error).message}`, undefined, true);
    }
  }

  private async getToken(): Promise<CachedToken> {
    const auth = this.opts.auth;
    if (auth.method === 'token') return { token: auth.token, expiresAt: Number.POSITIVE_INFINITY, renewable: false };
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 30_000 > now) return this.cached;
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    this.cached = await this.loginPromise;
    return this.cached;
  }

  private async login(): Promise<CachedToken> {
    const auth = this.opts.auth;
    let path: string;
    let payload: Record<string, string>;
    if (auth.method === 'approle') {
      const roleId = auth.roleId ?? (auth.roleIdFile ? (await readFile(auth.roleIdFile, 'utf8')).trim() : undefined);
      const secretId = auth.secretId ?? (auth.secretIdFile ? (await readFile(auth.secretIdFile, 'utf8')).trim() : undefined);
      if (!roleId || !secretId) throw new SecretBackendError('AppRole : role_id/secret_id manquants');
      path = `/v1/auth/${auth.mount ?? 'approle'}/login`;
      payload = { role_id: roleId, secret_id: secretId };
    } else if (auth.method === 'kubernetes') {
      const jwt = (await readFile(auth.jwtFile ?? '/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8')).trim();
      path = `/v1/auth/${auth.mount ?? 'kubernetes'}/login`;
      payload = { role: auth.role, jwt };
    } else {
      throw new SecretBackendError('Méthode d’authentification Vault non supportée');
    }
    const res = await this.fetchWithTimeout(`${this.opts.address}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.opts.namespace ? { 'X-Vault-Namespace': this.opts.namespace } : {}) },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new SecretBackendError(`Authentification Vault refusée (HTTP ${res.status})`, res.status, res.status >= 500);
    const body = (await res.json()) as { auth: { client_token: string; lease_duration: number; renewable: boolean } };
    return {
      token: body.auth.client_token,
      expiresAt: Date.now() + body.auth.lease_duration * 1000,
      renewable: body.auth.renewable,
    };
  }
}
