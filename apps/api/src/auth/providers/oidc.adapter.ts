import * as oidc from 'openid-client';
import type { OidcConfig } from '@cap/contracts';
import { FederationError, amrIndicatesMfa, type FederatedProfile } from './federation.types.js';

/**
 * OIDC (Keycloak et tout fournisseur conforme) : code d'autorisation + PKCE (S256), state et nonce.
 * Les configurations découvertes sont mises en cache par fournisseur et version.
 */
export class OidcAdapter {
  private readonly cache = new Map<string, { at: number; config: oidc.Configuration }>();

  private async configuration(key: string, cfg: OidcConfig, clientSecret: string | undefined): Promise<oidc.Configuration> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.config;
    const options = cfg.allowInsecureHttp ? { execute: [oidc.allowInsecureRequests] } : undefined;
    const config = await oidc
      .discovery(new URL(cfg.issuer), cfg.clientId, clientSecret ? { client_secret: clientSecret } : undefined, clientSecret ? undefined : oidc.None(), options)
      .catch((e: Error) => {
        throw new FederationError('sso_failed', `Découverte OIDC impossible (${cfg.issuer}) : ${e.message}`);
      });
    this.cache.set(key, { at: Date.now(), config });
    return config;
  }

  async start(key: string, cfg: OidcConfig, clientSecret: string | undefined, redirectUri: string, state: string) {
    const config = await this.configuration(key, cfg, clientSecret);
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const nonce = oidc.randomNonce();
    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: cfg.scopes.join(' '),
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    return { url: url.href, codeVerifier, nonce };
  }

  async callback(
    key: string,
    cfg: OidcConfig,
    clientSecret: string | undefined,
    currentUrl: URL,
    expected: { state: string; nonce: string; codeVerifier: string },
  ): Promise<FederatedProfile> {
    const config = await this.configuration(key, cfg, clientSecret);
    const tokens = await oidc
      .authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: expected.codeVerifier, expectedState: expected.state, expectedNonce: expected.nonce, idTokenExpected: true })
      .catch((e: Error) => {
        throw new FederationError('sso_failed', `Échange du code OIDC refusé : ${e.message}`);
      });
    const claims = tokens.claims();
    if (!claims) throw new FederationError('sso_failed', 'Jeton d’identité absent');
    // Complément via userinfo (certains fournisseurs ne mettent pas l'email dans l'ID token).
    let info: Record<string, unknown> = {};
    if (tokens.access_token && (!claims[cfg.emailClaim] || !claims[cfg.usernameClaim])) {
      info = (await oidc.fetchUserInfo(config, tokens.access_token, claims.sub).catch(() => ({}))) as Record<string, unknown>;
    }
    const all = { ...info, ...claims } as Record<string, unknown>;
    const str = (k: string) => (typeof all[k] === 'string' && all[k] ? (all[k] as string) : null);
    return {
      subject: claims.sub,
      email: str(cfg.emailClaim),
      emailVerified: typeof all['email_verified'] === 'boolean' ? (all['email_verified'] as boolean) : all['email_verified'] === 'true' ? true : all['email_verified'] === 'false' ? false : null,
      username: str(cfg.usernameClaim),
      displayName: str(cfg.nameClaim),
      mfa: amrIndicatesMfa(claims.amr, claims.acr),
      raw: { iss: claims.iss, sub: claims.sub, amr: claims.amr ?? null, acr: claims.acr ?? null },
    };
  }

  async test(key: string, cfg: OidcConfig, clientSecret: string | undefined): Promise<string> {
    this.cache.delete(key);
    const config = await this.configuration(key, cfg, clientSecret);
    const meta = config.serverMetadata();
    const pkce = meta.code_challenge_methods_supported?.includes('S256') ? 'PKCE S256 pris en charge' : 'PKCE S256 non annoncé';
    return `Découverte OK : ${meta.issuer} (autorisation ${meta.authorization_endpoint ? 'OK' : 'absente'}, jeton ${meta.token_endpoint ? 'OK' : 'absent'}, ${pkce})`;
  }

  invalidate(key: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${key.split(':')[0]}:`)) this.cache.delete(k);
  }
}
