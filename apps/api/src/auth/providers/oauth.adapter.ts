import { createHash, randomBytes } from 'node:crypto';
import type { GitHubOAuthConfig, GitLabOAuthConfig } from '@cap/contracts';
import { FederationError, type FederatedProfile } from './federation.types.js';

const TIMEOUT_MS = 10_000;

/** `github.com`, `gitlab.example.com` ou `http://gitlab.local:8080` → origine HTTP(S). */
export function originOf(host: string): string {
  const withScheme = /^https?:\/\//.test(host) ? host : `https://${host}`;
  return new URL(withScheme).origin;
}

async function call<T>(url: string, init: RequestInit, what: string): Promise<T> {
  const res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e: Error) => {
    throw new FederationError('sso_failed', `${what} : ${e.message}`);
  });
  const body = (await res.json().catch(() => null)) as T & { error?: string; error_description?: string };
  if (!res.ok || !body || (body as { error?: string }).error) {
    throw new FederationError('sso_failed', `${what} : HTTP ${res.status} ${body?.error_description ?? body?.error ?? ''}`.trim());
  }
  return body;
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** OAuth GitHub (github.com ou GitHub Enterprise Server). */
export class GitHubAdapter {
  private api(cfg: GitHubOAuthConfig): string {
    const origin = originOf(cfg.host);
    return origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
  }

  start(cfg: GitHubOAuthConfig, redirectUri: string, state: string) {
    const scopes = ['read:user', 'user:email', ...(cfg.allowedOrganizations.length ? ['read:org'] : [])];
    const u = new URL('/login/oauth/authorize', originOf(cfg.host));
    u.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, scope: scopes.join(' '), state, allow_signup: 'false' }).toString();
    return { url: u.href, codeVerifier: null, nonce: null };
  }

  async callback(cfg: GitHubOAuthConfig, clientSecret: string, code: string, redirectUri: string): Promise<FederatedProfile> {
    const token = await call<{ access_token: string }>(
      new URL('/login/oauth/access_token', originOf(cfg.host)).href,
      {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      },
      'Échange du code GitHub',
    );
    const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token.access_token}`, 'user-agent': 'coding-agent-platform' };
    const api = this.api(cfg);
    const user = await call<{ id: number; login: string; name: string | null; email: string | null; two_factor_authentication?: boolean }>(`${api}/user`, { headers }, 'Profil GitHub');
    const emails = await call<Array<{ email: string; primary: boolean; verified: boolean }>>(`${api}/user/emails`, { headers }, 'Emails GitHub').catch(() => []);
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    if (cfg.allowedOrganizations.length) {
      const orgs = await call<Array<{ login: string }>>(`${api}/user/orgs?per_page=100`, { headers }, 'Organisations GitHub');
      const allowed = new Set(cfg.allowedOrganizations.map((o) => o.toLowerCase()));
      if (!orgs.some((o) => allowed.has(o.login.toLowerCase()))) throw new FederationError('not_allowed', `${user.login} n’appartient à aucune organisation autorisée`);
    }
    return {
      subject: String(user.id),
      email: primary?.email ?? null,
      emailVerified: !!primary,
      username: user.login,
      displayName: user.name ?? user.login,
      mfa: false,
      raw: { id: user.id, login: user.login },
    };
  }

  async test(cfg: GitHubOAuthConfig, clientSecret: string | undefined): Promise<string> {
    const meta = await call<Record<string, unknown>>(`${this.api(cfg)}/meta`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'coding-agent-platform' } }, 'API GitHub');
    if (!clientSecret) throw new FederationError('sso_failed', 'Secret client absent');
    return `API GitHub joignable (${originOf(cfg.host)}${meta['installed_version'] ? `, version ${String(meta['installed_version'])}` : ''}) ; secret client présent`;
  }
}

/** OAuth GitLab (gitlab.com ou instance auto-hébergée), avec PKCE. */
export class GitLabAdapter {
  start(cfg: GitLabOAuthConfig, redirectUri: string, state: string) {
    const { verifier, challenge } = pkce();
    const scopes = ['read_user', ...(cfg.allowedGroups.length ? ['read_api'] : [])];
    const u = new URL('/oauth/authorize', originOf(cfg.host));
    u.search = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString();
    return { url: u.href, codeVerifier: verifier, nonce: null };
  }

  async callback(cfg: GitLabOAuthConfig, clientSecret: string, code: string, redirectUri: string, codeVerifier: string): Promise<FederatedProfile> {
    const origin = originOf(cfg.host);
    const token = await call<{ access_token: string }>(
      `${origin}/oauth/token`,
      {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg.clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier }),
      },
      'Échange du code GitLab',
    );
    const headers = { authorization: `Bearer ${token.access_token}` };
    const user = await call<{ id: number; username: string; name: string; email: string | null; confirmed_at?: string | null; state: string }>(`${origin}/api/v4/user`, { headers }, 'Profil GitLab');
    if (user.state !== 'active') throw new FederationError('account_suspended', `Compte GitLab ${user.username} inactif`);
    if (cfg.allowedGroups.length) {
      const groups = await call<Array<{ full_path: string }>>(`${origin}/api/v4/groups?min_access_level=10&per_page=100`, { headers }, 'Groupes GitLab');
      const allowed = new Set(cfg.allowedGroups.map((g) => g.toLowerCase()));
      if (!groups.some((g) => allowed.has(g.full_path.toLowerCase()))) throw new FederationError('not_allowed', `${user.username} n’appartient à aucun groupe autorisé`);
    }
    return {
      subject: String(user.id),
      email: user.email,
      // /user ne renvoie que l'email principal ; `confirmed_at` atteste sa vérification lorsqu'il est présent.
      emailVerified: !!user.email && user.confirmed_at !== null,
      username: user.username,
      displayName: user.name,
      mfa: false,
      raw: { id: user.id, username: user.username },
    };
  }

  async test(cfg: GitLabOAuthConfig, clientSecret: string | undefined): Promise<string> {
    const origin = originOf(cfg.host);
    const meta = await call<{ issuer?: string }>(`${origin}/.well-known/openid-configuration`, {}, 'Instance GitLab');
    if (!clientSecret) throw new FederationError('sso_failed', 'Secret client absent');
    return `Instance GitLab joignable (${meta.issuer ?? origin}) ; secret client présent`;
  }
}
