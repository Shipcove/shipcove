import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { authProviders, gitForges } from '@cap/database';
import { SettingsService } from '@cap/server-core';
import { startApp, type TestContext } from '../test/helpers.js';
import { parseProvisioning } from './provisioning-env.js';
import { ProvisioningService } from './provisioning.service.js';

let ctx: TestContext;
let service: ProvisioningService;

beforeAll(async () => {
  ctx = await startApp();
  service = ctx.app.get(ProvisioningService);
});
afterAll(async () => ctx?.close());

const env = {
  SSO_OIDC_ISSUER: 'https://idp.example.test/realms/cap',
  SSO_OIDC_CLIENT_ID: 'shipcove',
  SSO_OIDC_CLIENT_SECRET: 'oidc-secret',
  SSO_OIDC_NAME: 'Keycloak (env)',
  GIT_GITLAB_HOST: 'gitlab.env.example.test',
  GIT_GITLAB_CLIENT_ID: 'gitlab-app',
  GIT_GITLAB_CLIENT_SECRET: 'gitlab-secret',
  GIT_ALLOW_PERSONAL_TOKENS: 'true',
  SMTP_HOST: 'mailpit',
  SMTP_PORT: '1025',
  SMTP_FROM_ADDRESS: 'shipcove@example.test',
};

describe('Configuration par variables d’environnement (e2e)', () => {
  it('crée fournisseur, forge, SMTP et paramètres, puis ne réécrit rien au démarrage suivant', async () => {
    const p = parseProvisioning(env, 'http://litellm:4000');
    const first = await service.applyConfig(p);
    expect(first).toEqual(expect.arrayContaining(['sso:Keycloak (env)', 'git:gitlab.env.example.test', 'smtp', 'settings.git']));

    const [idp] = await ctx.db.select().from(authProviders).where(eq(authProviders.name, 'Keycloak (env)'));
    expect(idp).toMatchObject({ type: 'oidc', enabled: true });
    expect(idp.secretRef).toBeTruthy();
    expect(idp.config).not.toHaveProperty('clientSecret');
    const [forge] = await ctx.db.select().from(gitForges).where(eq(gitForges.host, 'gitlab.env.example.test'));
    expect(forge).toMatchObject({ provider: 'gitlab_self_managed', clientId: 'gitlab-app', enabled: true });
    expect((await ctx.app.get(SettingsService).section('git')).allowPersonalTokens).toBe(true);

    expect(await service.applyConfig(parseProvisioning(env, 'http://litellm:4000'))).toEqual([]);

    // Un changement de valeur est appliqué au démarrage suivant (sans dupliquer l'objet).
    const changed = await service.applyConfig(parseProvisioning({ ...env, SSO_OIDC_CLIENT_SECRET: 'rotated' }, 'http://litellm:4000'));
    expect(changed).toEqual(['sso:Keycloak (env)']);
    expect(await ctx.db.select().from(authProviders).where(eq(authProviders.name, 'Keycloak (env)'))).toHaveLength(1);
  });

  it('refuse un fournisseur dont le nom est déjà pris par un autre type', async () => {
    const p = parseProvisioning({ SSO_LDAP_URL: 'ldap://ldap', SSO_LDAP_BIND_DN: 'cn=a', SSO_LDAP_SEARCH_BASE: 'dc=a', SSO_LDAP_NAME: 'Keycloak (env)' }, 'http://litellm:4000');
    await expect(service.applyConfig(p)).rejects.toThrow(/déjà déclaré avec le type oidc/);
  });
});
