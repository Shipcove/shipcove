import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { GitProviderKind, RemoteRepositoryDto } from '@cap/contracts';
import type { SecretProvider } from '@cap/secrets';
import { gitConnections, gitForges, type Database } from '@cap/database';
import { DB, SECRETS } from '../tokens.js';
import { AppError } from '../common/errors.js';
import { SettingsService } from '../settings/settings.service.js';

export interface RepoMetadata {
  provider: GitProviderKind;
  host: string;
  fullName: string;
  externalId: string;
  cloneUrl: string;
  webUrl: string;
  defaultBranch: string;
  private: boolean;
}

export interface PullRequestResult {
  number: number;
  url: string;
  state: string;
  headSha?: string | null;
}

export class GitProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** `true` si le résultat distant est incertain (timeout, 5xx après envoi). */
    readonly uncertain = false,
  ) {
    super(message);
    this.name = 'GitProviderError';
  }
}

type Conn = typeof gitConnections.$inferSelect;
type Forge = typeof gitForges.$inferSelect;

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

/** Marge avant expiration à partir de laquelle un jeton OAuth est renouvelé. */
const REFRESH_MARGIN_MS = 2 * 60_000;

const isGitHub = (p: GitProviderKind) => p === 'github' || p === 'github_enterprise';

/**
 * Client des API GitHub (.com / Enterprise) et GitLab (.com / self-managed).
 * Les jetons sont lus dans Vault au moment de l'appel et ne quittent jamais le serveur.
 */
@Injectable()
export class GitProviderClient {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly settings: SettingsService,
  ) {}

  /**
   * HTTPS par défaut. HTTP uniquement pour une forge auto-hébergée explicitement listée par
   * l'administrateur (`git.insecureHttpHosts`, ex. forge interne de recette) ; jamais pour les SaaS.
   */
  private async scheme(host: string): Promise<'http' | 'https'> {
    const { insecureHttpHosts } = await this.settings.section('git');
    return insecureHttpHosts.map((h) => h.toLowerCase()).includes(host.toLowerCase()) ? 'http' : 'https';
  }

  async apiBase(provider: GitProviderKind, host: string): Promise<string> {
    if (provider === 'github') return 'https://api.github.com';
    const origin = `${await this.scheme(host)}://${host}`;
    return provider === 'github_enterprise' ? `${origin}/api/v3` : `${origin}/api/v4`;
  }

  /** URL de dépôt utilisable : HTTPS, ou HTTP pour un hôte autorisé ; ni identifiants ni autre schéma. */
  async assertTransport(url: string): Promise<URL> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new AppError('validation_failed', 'URL de dépôt invalide');
    }
    if (u.username || u.password) throw new AppError('validation_failed', 'URL de dépôt avec identifiants refusée');
    if (u.protocol === 'https:') return u;
    if (u.protocol === 'http:' && (await this.scheme(u.host)) === 'http') return u;
    throw new AppError('forbidden', `Transport non autorisé pour ${u.host} (HTTPS requis)`);
  }

  async connection(connectionId: string, userId?: string): Promise<Conn> {
    const [c] = await this.db.select().from(gitConnections).where(eq(gitConnections.id, connectionId));
    if (!c || c.revokedAt || (userId && c.userId !== userId)) throw new AppError('not_found', 'Connexion Git introuvable');
    if (c.status !== 'active') throw new AppError('conflict', 'Connexion Git inactive ou expirée');
    return c;
  }

  async token(conn: Conn): Promise<string> {
    if (conn.authType === 'oauth' && conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - Date.now() < REFRESH_MARGIN_MS) {
      return this.refresh(conn.id);
    }
    const t = await this.secrets.readKey(conn.secretRef, 'accessToken');
    if (!t) throw new AppError('conflict', 'Jeton Git absent');
    return t;
  }

  /* ------------------------------- OAuth ------------------------------- */

  /** Origine web de la forge (pages OAuth, et non API). */
  async webOrigin(provider: GitProviderKind, host: string): Promise<string> {
    if (provider === 'github') return 'https://github.com';
    if (provider === 'gitlab') return 'https://gitlab.com';
    return `${await this.scheme(host)}://${host}`;
  }

  /** Portées nécessaires : lecture du profil, lecture/écriture des dépôts, PR/MR. */
  oauthScopes(provider: GitProviderKind): string[] {
    return isGitHub(provider) ? ['repo', 'read:user', 'user:email', 'read:org'] : ['api', 'read_user', 'read_repository', 'write_repository'];
  }

  async authorizeUrl(forge: Forge, redirectUri: string, state: string, codeChallenge: string): Promise<string> {
    const origin = await this.webOrigin(forge.provider, forge.host);
    const u = isGitHub(forge.provider) ? new URL('/login/oauth/authorize', origin) : new URL('/oauth/authorize', origin);
    u.search = new URLSearchParams({
      client_id: forge.clientId,
      redirect_uri: redirectUri,
      scope: this.oauthScopes(forge.provider).join(' '),
      state,
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(isGitHub(forge.provider) ? { allow_signup: 'false' } : {}),
    }).toString();
    return u.href;
  }

  private async tokenRequest(forge: Forge, params: Record<string, string>): Promise<OAuthTokens> {
    const secret = forge.secretRef ? await this.secrets.readKey(forge.secretRef, 'clientSecret') : undefined;
    if (!secret) throw new GitProviderError('Secret client OAuth non configuré pour cette forge', null);
    const origin = await this.webOrigin(forge.provider, forge.host);
    const url = isGitHub(forge.provider) ? `${origin}/login/oauth/access_token` : `${origin}/oauth/token`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'shipcove' },
      body: new URLSearchParams({ client_id: forge.clientId, client_secret: secret, ...params }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    }).catch((err: Error) => {
      throw new GitProviderError(`Forge injoignable : ${err.message}`, null);
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) {
      // Code d'erreur OAuth (invalid_client, invalid_grant…) conservé : il qualifie la cause.
      const detail = [j.error, j.error_description].filter(Boolean).join(' — ') || `HTTP ${res.status}`;
      throw new GitProviderError(`Échange OAuth refusé : ${detail}`, res.status);
    }
    return {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? null,
      expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000) : null,
      scopes: (j.scope ?? '').split(/[ ,]+/).filter(Boolean),
    };
  }

  exchangeCode(forge: Forge, code: string, redirectUri: string, codeVerifier: string): Promise<OAuthTokens> {
    return this.tokenRequest(forge, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier });
  }

  /**
   * Renouvellement du jeton OAuth. Verrou sur la connexion : les jetons de renouvellement GitLab
   * sont à usage unique, deux renouvellements concurrents (plusieurs instances) invalideraient
   * la connexion. Le second appelant relit le jeton déjà renouvelé.
   */
  private async refresh(connectionId: string): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [conn] = await tx.select().from(gitConnections).where(eq(gitConnections.id, connectionId)).for('update');
      if (!conn || conn.revokedAt) throw new AppError('not_found', 'Connexion Git introuvable');
      const data = await this.secrets.read(conn.secretRef);
      if (conn.tokenExpiresAt && conn.tokenExpiresAt.getTime() - Date.now() >= REFRESH_MARGIN_MS && data['accessToken']) return data['accessToken'];
      const [forge] = conn.forgeId ? await tx.select().from(gitForges).where(eq(gitForges.id, conn.forgeId)) : [];
      if (!forge || !data['refreshToken']) {
        await tx.update(gitConnections).set({ status: 'expired' }).where(eq(gitConnections.id, conn.id));
        throw new AppError('conflict', 'Connexion Git expirée : reconnectez votre compte dans vos paramètres');
      }
      let t: OAuthTokens;
      try {
        t = await this.tokenRequest(forge, { grant_type: 'refresh_token', refresh_token: data['refreshToken'] });
      } catch (err) {
        if (err instanceof GitProviderError && err.status !== null && err.status < 500) {
          await tx.update(gitConnections).set({ status: 'expired' }).where(eq(gitConnections.id, conn.id));
          throw new AppError('conflict', 'Connexion Git expirée : reconnectez votre compte dans vos paramètres');
        }
        throw err;
      }
      await this.secrets.write(`git-connections/${conn.id}`, { accessToken: t.accessToken, ...(t.refreshToken ? { refreshToken: t.refreshToken } : { refreshToken: data['refreshToken'] }) });
      await tx.update(gitConnections).set({ tokenExpiresAt: t.expiresAt, status: 'active' }).where(eq(gitConnections.id, conn.id));
      return t.accessToken;
    });
  }

  private async call<T>(conn: Conn, method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const token = await this.token(conn);
    const headers: Record<string, string> = isGitHub(conn.provider)
      ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
      : { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    headers['User-Agent'] = 'shipcove';
    let res: Response;
    try {
      res = await fetch(`${await this.apiBase(conn.provider, conn.host)}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Requête peut-être reçue par la forge : résultat incertain pour les écritures.
      throw new GitProviderError(`Forge injoignable : ${(err as Error).message}`, null, method !== 'GET');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { message?: string; error?: string };
        msg = j.message ?? j.error ?? msg;
      } catch {
        /* texte brut */
      }
      throw new GitProviderError(`${res.status} ${msg}`, res.status, method !== 'GET' && res.status >= 500);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Identité du compte (validation d'un jeton lors du rattachement). */
  async whoAmI(provider: GitProviderKind, host: string, token: string): Promise<{ id: string; login: string; name: string | null; scopes: string[] }> {
    const isGh = isGitHub(provider);
    const res = await fetch(`${await this.apiBase(provider, host)}/user`, {
      headers: isGh ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'shipcove' } : { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    }).catch((err: Error) => {
      throw new GitProviderError(`Forge injoignable : ${err.message}`, null);
    });
    if (!res.ok) throw new GitProviderError(`Jeton refusé par la forge (HTTP ${res.status})`, res.status);
    const j = (await res.json()) as { id: number; login?: string; username?: string; name?: string };
    const scopes = (res.headers.get('x-oauth-scopes') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return { id: String(j.id), login: j.login ?? j.username ?? String(j.id), name: j.name ?? null, scopes };
  }

  /**
   * Branche par défaut et, parmi `branches`, celles que la forge protège (garde-fous des pushs de
   * l'agent). Une branche inexistante n'est protégée que si une règle GitLab à joker la couvre.
   */
  async branchFacts(conn: Conn, fullName: string, branches: string[]): Promise<{ defaultBranch: string; protectedBranches: Set<string> }> {
    const repo = await this.getRepository(conn, fullName);
    const protectedBranches = new Set<string>();
    if (isGitHub(conn.provider)) {
      for (const b of branches) {
        try {
          const r = await this.call<{ protected?: boolean }>(conn, 'GET', `/repos/${repo.fullName.split('/').map(encodeURIComponent).join('/')}/branches/${encodeURIComponent(b)}`);
          if (r.protected) protectedBranches.add(b);
        } catch (err) {
          if (!(err instanceof GitProviderError && err.status === 404)) throw err;
        }
      }
    } else {
      const rules = await this.call<Array<{ name: string }>>(conn, 'GET', `/projects/${encodeURIComponent(repo.fullName)}/protected_branches?per_page=100`);
      const patterns = rules.map((r) => new RegExp(`^${r.name.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`));
      for (const b of branches) if (patterns.some((p) => p.test(b))) protectedBranches.add(b);
    }
    return { defaultBranch: repo.defaultBranch, protectedBranches };
  }

  async getRepository(conn: Conn, fullName: string): Promise<RepoMetadata> {
    if (isGitHub(conn.provider)) {
      const r = await this.call<{ id: number; full_name: string; clone_url: string; html_url: string; default_branch: string; private: boolean }>(
        conn,
        'GET',
        `/repos/${fullName.split('/').map(encodeURIComponent).join('/')}`,
      );
      return { provider: conn.provider, host: conn.host, fullName: r.full_name, externalId: String(r.id), cloneUrl: r.clone_url, webUrl: r.html_url, defaultBranch: r.default_branch, private: r.private };
    }
    const r = await this.call<{ id: number; path_with_namespace: string; http_url_to_repo: string; web_url: string; default_branch: string | null; visibility: string }>(
      conn,
      'GET',
      `/projects/${encodeURIComponent(fullName)}`,
    );
    return {
      provider: conn.provider,
      host: conn.host,
      fullName: r.path_with_namespace,
      externalId: String(r.id),
      cloneUrl: r.http_url_to_repo,
      webUrl: r.web_url,
      defaultBranch: r.default_branch ?? 'main',
      private: r.visibility !== 'public',
    };
  }

  async listRepositories(conn: Conn, query?: string): Promise<RemoteRepositoryDto[]> {
    if (isGitHub(conn.provider)) {
      const rows = query
        ? (await this.call<{ items: Array<Record<string, unknown>> }>(conn, 'GET', `/search/repositories?q=${encodeURIComponent(`${query} in:name fork:true user:${conn.accountLogin}`)}&per_page=50`)).items
        : await this.call<Array<Record<string, unknown>>>(conn, 'GET', `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`);
      return rows.map((r) => ({
        fullName: r.full_name as string,
        defaultBranch: (r.default_branch as string) ?? 'main',
        private: !!r.private,
        webUrl: r.html_url as string,
        description: (r.description as string | null) ?? null,
      }));
    }
    const rows = await this.call<Array<Record<string, unknown>>>(
      conn,
      'GET',
      `/projects?membership=true&per_page=100&order_by=last_activity_at${query ? `&search=${encodeURIComponent(query)}` : ''}`,
    );
    return rows.map((r) => ({
      fullName: r.path_with_namespace as string,
      defaultBranch: (r.default_branch as string) ?? 'main',
      private: r.visibility !== 'public',
      webUrl: r.web_url as string,
      description: (r.description as string | null) ?? null,
    }));
  }

  async listBranches(conn: Conn, fullName: string): Promise<string[]> {
    if (isGitHub(conn.provider)) {
      const rows = await this.call<Array<{ name: string }>>(conn, 'GET', `/repos/${fullName}/branches?per_page=100`);
      return rows.map((r) => r.name);
    }
    const rows = await this.call<Array<{ name: string }>>(conn, 'GET', `/projects/${encodeURIComponent(fullName)}/repository/branches?per_page=100`);
    return rows.map((r) => r.name);
  }

  async createPullRequest(conn: Conn, fullName: string, p: { source: string; target: string; title: string; body: string; draft: boolean }): Promise<PullRequestResult> {
    if (isGitHub(conn.provider)) {
      const r = await this.call<{ number: number; html_url: string; state: string; head: { sha: string } }>(conn, 'POST', `/repos/${fullName}/pulls`, {
        head: p.source,
        base: p.target,
        title: p.title,
        body: p.body,
        draft: p.draft,
      });
      return { number: r.number, url: r.html_url, state: r.state, headSha: r.head.sha };
    }
    const r = await this.call<{ iid: number; web_url: string; state: string; sha: string }>(conn, 'POST', `/projects/${encodeURIComponent(fullName)}/merge_requests`, {
      source_branch: p.source,
      target_branch: p.target,
      title: p.draft ? `Draft: ${p.title}` : p.title,
      description: p.body,
    });
    return { number: r.iid, url: r.web_url, state: r.state, headSha: r.sha };
  }

  /** Recherche d'une PR/MR ouverte existante (réconciliation d'un résultat incertain). */
  async findOpenPullRequest(conn: Conn, fullName: string, source: string, target: string): Promise<PullRequestResult | null> {
    if (isGitHub(conn.provider)) {
      const owner = fullName.split('/')[0];
      const rows = await this.call<Array<{ number: number; html_url: string; state: string; head: { sha: string } }>>(
        conn,
        'GET',
        `/repos/${fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${source}`)}&base=${encodeURIComponent(target)}`,
      );
      return rows[0] ? { number: rows[0].number, url: rows[0].html_url, state: rows[0].state, headSha: rows[0].head.sha } : null;
    }
    const rows = await this.call<Array<{ iid: number; web_url: string; state: string; sha: string }>>(
      conn,
      'GET',
      `/projects/${encodeURIComponent(fullName)}/merge_requests?state=opened&source_branch=${encodeURIComponent(source)}&target_branch=${encodeURIComponent(target)}`,
    );
    return rows[0] ? { number: rows[0].iid, url: rows[0].web_url, state: rows[0].state, headSha: rows[0].sha } : null;
  }

  async getPullRequest(conn: Conn, fullName: string, number: number): Promise<PullRequestResult & { merged: boolean }> {
    if (isGitHub(conn.provider)) {
      const r = await this.call<{ number: number; html_url: string; state: string; merged: boolean; head: { sha: string } }>(conn, 'GET', `/repos/${fullName}/pulls/${number}`);
      return { number: r.number, url: r.html_url, state: r.state, merged: r.merged, headSha: r.head.sha };
    }
    const r = await this.call<{ iid: number; web_url: string; state: string; sha: string }>(conn, 'GET', `/projects/${encodeURIComponent(fullName)}/merge_requests/${number}`);
    return { number: r.iid, url: r.web_url, state: r.state, merged: r.state === 'merged', headSha: r.sha };
  }

  async mergePullRequest(conn: Conn, fullName: string, number: number, method: 'merge' | 'squash' | 'rebase', expectedHeadSha?: string | null): Promise<{ merged: boolean; sha: string | null }> {
    if (isGitHub(conn.provider)) {
      const r = await this.call<{ merged: boolean; sha: string }>(conn, 'PUT', `/repos/${fullName}/pulls/${number}/merge`, {
        merge_method: method,
        ...(expectedHeadSha ? { sha: expectedHeadSha } : {}),
      });
      return { merged: r.merged, sha: r.sha };
    }
    const r = await this.call<{ state: string; merge_commit_sha: string | null }>(conn, 'PUT', `/projects/${encodeURIComponent(fullName)}/merge_requests/${number}/merge`, {
      squash: method === 'squash',
      ...(expectedHeadSha ? { sha: expectedHeadSha } : {}),
    });
    return { merged: r.state === 'merged', sha: r.merge_commit_sha };
  }

  async deleteBranch(conn: Conn, fullName: string, branch: string): Promise<void> {
    if (isGitHub(conn.provider)) {
      await this.call(conn, 'DELETE', `/repos/${fullName}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      return;
    }
    await this.call(conn, 'DELETE', `/projects/${encodeURIComponent(fullName)}/repository/branches/${encodeURIComponent(branch)}`);
  }

  async branchHead(conn: Conn, fullName: string, branch: string): Promise<string | null> {
    try {
      if (isGitHub(conn.provider)) {
        const r = await this.call<{ object: { sha: string } }>(conn, 'GET', `/repos/${fullName}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
        return r.object.sha;
      }
      const r = await this.call<{ commit: { id: string } }>(conn, 'GET', `/projects/${encodeURIComponent(fullName)}/repository/branches/${encodeURIComponent(branch)}`);
      return r.commit.id;
    } catch (err) {
      if (err instanceof GitProviderError && err.status === 404) return null;
      throw err;
    }
  }

  /** États CI/CD du dernier commit d'une branche. */
  async ciStatus(conn: Conn, fullName: string, ref: string): Promise<Array<{ name: string; status: string; url: string | null }>> {
    if (isGitHub(conn.provider)) {
      const r = await this.call<{ check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string }> }>(
        conn,
        'GET',
        `/repos/${fullName}/commits/${encodeURIComponent(ref)}/check-runs?per_page=50`,
      );
      return r.check_runs.map((c) => ({ name: c.name, status: c.conclusion ?? c.status, url: c.html_url }));
    }
    const rows = await this.call<Array<{ id: number; status: string; web_url: string; ref: string }>>(
      conn,
      'GET',
      `/projects/${encodeURIComponent(fullName)}/pipelines?ref=${encodeURIComponent(ref)}&per_page=5`,
    );
    return rows.map((p) => ({ name: `pipeline #${p.id}`, status: p.status, url: p.web_url }));
  }

  /** URL HTTPS avec identifiants, **uniquement** pour usage interne côté serveur (jamais journalisée). */
  async authenticatedCloneUrl(conn: Conn, cloneUrl: string): Promise<string> {
    const token = await this.token(conn);
    const u = await this.assertTransport(cloneUrl);
    u.username = isGitHub(conn.provider) ? 'x-access-token' : 'oauth2';
    u.password = token;
    return u.toString();
  }
}
