import { describe, expect, it } from 'vitest';
import { isEmpty, parseProvisioning } from './provisioning-env.js';
import { stable } from './provisioning.service.js';

const URL = 'http://litellm:4000/';

describe('configuration par variables d’environnement', () => {
  it('ne déclare rien sans variable (découverte des modèles active par défaut)', () => {
    const p = parseProvisioning({}, URL);
    expect(isEmpty(p)).toBe(true);
    expect(p.litellm.syncOnStart).toBe(true);
    expect(p.litellm.connection).toBeNull();
  });

  it('lit la connexion et les modèles LiteLLM', () => {
    const p = parseProvisioning(
      {
        LITELLM_MASTER_KEY: 'sk-1',
        LITELLM_MODELS: JSON.stringify([{ model_name: 'gpt', litellm_params: { model: 'openai/gpt-5', api_key: 'k' } }]),
        LITELLM_ENABLED_MODELS: 'a, b,',
        LITELLM_DEFAULT_MODEL: 'gpt',
        LITELLM_SYNC_ON_START: 'false',
        LITELLM_SYNC_INTERVAL_MINUTES: '15',
      },
      URL,
    );
    expect(p.litellm.connection).toEqual({ url: 'http://litellm:4000', masterKey: 'sk-1' });
    expect(p.litellm.models[0].litellm_params).toEqual({ model: 'openai/gpt-5', api_key: 'k' });
    expect(p.litellm.enable).toEqual(['a', 'b']);
    expect(p.litellm.syncOnStart).toBe(false);
    expect(p.litellm.syncIntervalMinutes).toBe(15);
    expect(parseProvisioning({ LITELLM_ENABLED_MODELS: '*' }, URL).litellm.enable).toBe('*');
  });

  it('refuse un JSON ou un booléen invalide, sans démarrer à moitié', () => {
    expect(() => parseProvisioning({ LITELLM_MODELS: '[{' }, URL)).toThrow(/LITELLM_MODELS/);
    expect(() => parseProvisioning({ LITELLM_MODELS: '[{"model_name":"x"}]' }, URL)).toThrow(/litellm_params/);
    expect(() => parseProvisioning({ LITELLM_SYNC_ON_START: 'peut-être' }, URL)).toThrow(/booléen/);
  });

  it('déclare un fournisseur OIDC à partir de variables à plat', () => {
    const p = parseProvisioning(
      {
        SSO_OIDC_ISSUER: 'https://idp.example.com/realms/x',
        SSO_OIDC_CLIENT_ID: 'shipcove',
        SSO_OIDC_CLIENT_SECRET: 's3cret',
        SSO_OIDC_SCOPES: 'openid,email',
        SSO_OIDC_NAME: 'Keycloak',
      },
      URL,
    );
    expect(p.authProviders).toEqual([
      {
        type: 'oidc',
        name: 'Keycloak',
        enabled: true,
        autoProvision: true,
        config: { issuer: 'https://idp.example.com/realms/x', clientId: 'shipcove', clientSecret: 's3cret', scopes: ['openid', 'email'] },
      },
    ]);
  });

  it('déclare LDAP, SAML et GitLab, et refuse deux fournisseurs du même nom', () => {
    const p = parseProvisioning(
      {
        SSO_LDAP_URL: 'ldaps://ldap.example.com',
        SSO_LDAP_BIND_DN: 'cn=svc',
        SSO_LDAP_SEARCH_BASE: 'dc=example,dc=com',
        SSO_LDAP_TIMEOUT_MS: '5000',
        SSO_LDAP_START_TLS: 'no',
        SSO_SAML_ENTRY_POINT: 'https://idp.example.com/sso',
        SSO_SAML_ISSUER: 'shipcove',
        SSO_SAML_IDP_CERT: '-----BEGIN CERTIFICATE-----\nMIIabc\n-----END CERTIFICATE-----',
        SSO_GITLAB_CLIENT_ID: 'app',
        SSO_GITLAB_HOST: 'gitlab.example.com',
        SSO_GITLAB_ENABLED: 'false',
      },
      URL,
    );
    expect(p.authProviders.map((a) => [a.type, a.name, a.enabled])).toEqual([
      ['saml', 'SAML', true],
      ['ldap', 'LDAP', true],
      ['gitlab', 'GitLab', false],
    ]);
    expect(p.authProviders[1].config).toMatchObject({ timeoutMs: 5000, startTls: false });
    expect(() => parseProvisioning({ SSO_LDAP_URL: 'ldap://x', SSO_LDAP_BIND_DN: 'a', SSO_LDAP_SEARCH_BASE: 'b', SSO_OIDC_ISSUER: 'https://i', SSO_OIDC_CLIENT_ID: 'c', SSO_OIDC_NAME: 'LDAP' }, URL)).toThrow(/deux fois/);
  });

  it('déduit le type de forge de son hôte', () => {
    const p = parseProvisioning(
      {
        GIT_GITLAB_CLIENT_ID: 'id',
        GIT_GITLAB_CLIENT_SECRET: 'sec',
        GIT_GITLAB_HOST: 'https://gitlab.example.com/',
        GIT_GITHUB_CLIENT_ID: 'gh',
      },
      URL,
    );
    expect(p.gitForges).toEqual([
      { provider: 'github', name: 'GitHub', host: 'github.com', clientId: 'gh', enabled: true },
      { provider: 'gitlab_self_managed', name: 'GitLab (gitlab.example.com)', host: 'gitlab.example.com', clientId: 'id', clientSecret: 'sec', enabled: true },
    ]);
  });

  it('lit le SMTP et les paramètres plateforme (JSON puis variables à plat)', () => {
    const p = parseProvisioning(
      {
        SMTP_HOST: 'mailpit',
        SMTP_PORT: '1025',
        SMTP_FROM_ADDRESS: 'shipcove@example.com',
        PLATFORM_SETTINGS: JSON.stringify({ sandbox: { cpu: 4 }, git: { allowPersonalTokens: false } }),
        GIT_ALLOW_PERSONAL_TOKENS: 'true',
        GIT_INSECURE_HTTP_HOSTS: 'gitlab.local:8929',
        AUTH_MFA_POLICY: 'required_all',
      },
      URL,
    );
    expect(p.smtp).toEqual({ host: 'mailpit', port: 1025, secure: false, fromAddress: 'shipcove@example.com', fromName: 'Shipcove' });
    expect(p.settings).toEqual({
      sandbox: { cpu: 4 },
      git: { allowPersonalTokens: true, insecureHttpHosts: ['gitlab.local:8929'] },
      auth: { mfaPolicy: 'required_all' },
    });
    expect(() => parseProvisioning({ PLATFORM_SETTINGS: '{"inconnue":{}}' }, URL)).toThrow(/PLATFORM_SETTINGS/);
    expect(() => parseProvisioning({ SMTP_HOST: 'x' }, URL)).toThrow(/SMTP/);
  });

  it('compare deux configurations sans dépendre de l’ordre des clés', () => {
    expect(stable({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stable({ a: [1, { c: 3, d: 2 }], b: 1, z: undefined }));
  });
});
