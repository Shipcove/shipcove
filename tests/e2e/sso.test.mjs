// Fédération d'identité de bout en bout : vrais Keycloak (OIDC + SAML) et OpenLDAP.
// Prérequis : pile Compose démarrée + `docker compose -f tests/e2e/sso/compose.sso.yml up -d --wait`.
// Le navigateur doit utiliser l'URL publique de la plateforme (PUBLIC_URL, défaut http://localhost:8080)
// pour que les cookies posés au retour du fournisseur soient ceux de l'application.
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { BASE, Client, adminClient } from './client.mjs';

const PUBLIC = process.env.CAP_PUBLIC_URL ?? 'http://localhost:8080';
const KEYCLOAK = 'http://keycloak:18080';
const STATE_FILE = new URL('./.e2e-state.json', import.meta.url);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const OUT = new URL('./artifacts/', import.meta.url);
mkdirSync(OUT, { recursive: true });
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

const NAMES = { oidc: 'Keycloak OIDC (tests)', saml: 'Keycloak SAML (tests)', ldap: 'Annuaire LDAP (tests)' };
const TEST_EMAILS = ['alice.sso@example.test', 'sam.saml@example.test', 'bob.ldap@example.test', 'erin.local@example.test'];
const ctx = {};

// Fournisseurs de test absents : suite ignorée (voir l'en-tête pour les démarrer).
const SSO_UP = await fetch('http://127.0.0.1:18080/realms/cap/.well-known/openid-configuration')
  .then((r) => r.ok)
  .catch(() => false);
if (!SSO_UP) console.warn('# SSO : Keycloak/OpenLDAP de test non démarrés — suite ignorée (docker compose -f tests/e2e/sso/compose.sso.yml up -d --wait)');
const test = SSO_UP ? nodeTest : nodeTest.skip;

async function samlIdpCert() {
  // Le descripteur est lu depuis l'hôte ; l'URL publique de Keycloak (keycloak:18080) est mappée sur 127.0.0.1.
  const xml = await (await fetch('http://127.0.0.1:18080/realms/cap/protocol/saml/descriptor')).text();
  const m = xml.match(/<ds:X509Certificate>([^<]+)<\/ds:X509Certificate>/);
  assert.ok(m, 'certificat SAML de Keycloak');
  return m[1];
}

/** Crée ou met à jour un fournisseur (idempotent par nom : les identités survivent aux relances). */
async function upsertProvider(admin, type, name, config, extra = {}) {
  const list = (await admin.get('/admin/auth-providers')).body;
  const existing = list.find((p) => p.name === name);
  const body = { type, name, enabled: true, autoProvision: true, config, ...extra };
  const r = existing ? await admin.put(`/admin/auth-providers/${existing.id}`, body) : await admin.post('/admin/auth-providers', body);
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  return r.body;
}

async function browser() {
  return chromium.launch({ executablePath, args: ['--no-sandbox', `--host-resolver-rules=MAP keycloak 127.0.0.1`] });
}

/** Connexion Keycloak : remplit le formulaire s'il est présenté. */
async function keycloakLogin(page, username, password) {
  await page.waitForURL(/keycloak:18080\/realms\/cap\//, { timeout: 30_000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
}

async function sessionOf(page) {
  return page.evaluate(async () => (await fetch('/api/v1/auth/session', { credentials: 'include' })).json());
}

before(async () => {
  if (!SSO_UP) return;
  const admin = await adminClient(state);
  ctx.admin = admin;
  // Comptes de test supprimés à chaque exécution : provisionnement réellement exercé.
  for (const email of TEST_EMAILS) {
    const users = (await admin.get(`/admin/users?q=${encodeURIComponent(email)}`)).body;
    for (const u of users.filter((x) => x.email === email)) assert.equal((await admin.del(`/admin/users/${u.id}`)).status, 204);
  }

  ctx.oidc = await upsertProvider(admin, 'oidc', NAMES.oidc, {
    issuer: `${KEYCLOAK}/realms/cap`,
    clientId: 'cap-oidc',
    clientSecret: 'oidc-client-secret-test-only',
    allowInsecureHttp: true,
    mfa: 'auto',
  });
  ctx.saml = await upsertProvider(admin, 'saml', NAMES.saml, {
    entryPoint: `${KEYCLOAK}/realms/cap/protocol/saml`,
    issuer: 'cap-saml-sp',
    idpCert: await samlIdpCert(),
    wantAssertionsSigned: true,
  });
  ctx.ldap = await upsertProvider(admin, 'ldap', NAMES.ldap, {
    url: 'ldap://openldap:389',
    bindDn: 'cn=admin,dc=example,dc=test',
    bindPassword: 'ldap-admin-test-only',
    searchBase: 'ou=people,dc=example,dc=test',
    searchFilter: '(uid={{username}})',
  });
  ctx.browser = await browser();
});

after(async () => {
  if (!SSO_UP) return;
  await ctx.browser?.close();
  // Fournisseurs désactivés après les tests (identités conservées pour les relances).
  for (const p of [ctx.oidc, ctx.saml, ctx.ldap]) if (p) await ctx.admin.post(`/admin/auth-providers/${p.id}/disable`);
});

test('administration : secrets dans Vault (jamais renvoyés), tests de configuration, liste publique', async () => {
  const list = (await ctx.admin.get('/admin/auth-providers')).body;
  const oidc = list.find((p) => p.id === ctx.oidc.id);
  assert.equal(oidc.secretConfigured, true);
  assert.equal(oidc.callbackUrl, `${PUBLIC}/api/v1/auth/sso/${oidc.id}/callback`);
  assert.ok(!JSON.stringify(list).includes('oidc-client-secret-test-only'), 'secret OIDC non renvoyé');
  assert.ok(!JSON.stringify(list).includes('ldap-admin-test-only'), 'mot de passe LDAP non renvoyé');
  for (const p of [ctx.oidc, ctx.saml, ctx.ldap]) {
    const t = await ctx.admin.post(`/admin/auth-providers/${p.id}/test`);
    assert.equal(t.body.ok, true, `${p.name} : ${t.body.detail}`);
  }
  // Configuration invalide refusée.
  const bad = await ctx.admin.post('/admin/auth-providers', { type: 'ldap', name: `LDAP invalide ${Date.now()}`, enabled: false, autoProvision: true, config: { url: 'http://x', bindDn: 'a', searchBase: 'b', searchFilter: '(uid=x)' } });
  assert.equal(bad.status, 400);
  // Métadonnées SAML du fournisseur de services.
  const meta = await fetch(`${BASE}/api/v1/auth/sso/${ctx.saml.id}/metadata`);
  assert.match(await meta.text(), /AssertionConsumerService[^>]+\/api\/v1\/auth\/sso\/[0-9a-f-]+\/callback/);
  const pub = await new Client().get('/auth/providers');
  const names = pub.body.providers.map((p) => p.name);
  for (const n of Object.values(NAMES)) assert.ok(names.includes(n), `${n} listé`);
  // Accès réservé aux administrateurs.
  assert.equal((await new Client().get('/admin/auth-providers')).status, 401);
});

test('OIDC (Keycloak) : PKCE + state + nonce, création du compte, pas de redirection ouverte, flux non rejouable', async () => {
  const context = await ctx.browser.newContext({ locale: 'fr-FR' });
  const page = await context.newPage();
  let callbackUrl = null;
  page.on('request', (r) => {
    if (r.url().includes(`/auth/sso/${ctx.oidc.id}/callback`)) callbackUrl = r.url();
  });
  await page.goto(`${PUBLIC}/auth/login`);
  // returnTo absolu vers un autre site : ignoré.
  await page.goto(`${PUBLIC}/api/v1/auth/sso/${ctx.oidc.id}/start?returnTo=${encodeURIComponent('//evil.example/x')}`);
  const authUrl = new URL(page.url());
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(authUrl.searchParams.get('state') && authUrl.searchParams.get('nonce'));
  await keycloakLogin(page, 'alice', 'Alice-Sso-Password-1');
  await page.waitForURL(`${PUBLIC}/`, { timeout: 30_000 });
  const s = await sessionOf(page);
  assert.equal(s.authenticated, true);
  assert.equal(s.user.email, 'alice.sso@example.test');
  assert.equal(s.user.emailVerified, true);
  assert.equal(s.user.username, 'alice');
  await page.screenshot({ path: new URL('sso-oidc-home.png', OUT).pathname });
  // Rejeu du retour (code + state déjà consommés) dans une autre session : refusé.
  assert.ok(callbackUrl);
  const replay = await ctx.browser.newContext({ locale: 'fr-FR' });
  const rp = await replay.newPage();
  await rp.goto(callbackUrl);
  await rp.waitForURL(/\/auth\/login\?sso_error=sso_expired/);
  await rp.waitForSelector('text=La demande de connexion a expiré');
  assert.equal((await sessionOf(rp)).authenticated, false);
  await replay.close();
  // Deuxième connexion : même compte (identité rattachée), pas de doublon.
  const again = await ctx.browser.newContext({ locale: 'fr-FR' });
  const ap = await again.newPage();
  await ap.goto(`${PUBLIC}/auth/login`);
  await ap.click(`a:has-text("Continuer avec ${NAMES.oidc}")`);
  await keycloakLogin(ap, 'alice', 'Alice-Sso-Password-1');
  await ap.waitForURL(`${PUBLIC}/`);
  assert.equal((await sessionOf(ap)).user.id, s.user.id);
  await again.close();
  await context.close();
});

test('OIDC : politique « require_idp » → refus sans MFA attestée par le fournisseur', async () => {
  const p = ctx.oidc;
  await ctx.admin.put(`/admin/auth-providers/${p.id}`, { type: 'oidc', name: p.name, enabled: true, autoProvision: true, config: { ...p.config, mfa: 'require_idp' } });
  try {
    const context = await ctx.browser.newContext({ locale: 'fr-FR' });
    const page = await context.newPage();
    await page.goto(`${PUBLIC}/api/v1/auth/sso/${p.id}/start`);
    await keycloakLogin(page, 'alice', 'Alice-Sso-Password-1');
    await page.waitForURL(/\/auth\/login\?sso_error=mfa_required_by_idp/);
    await page.waitForSelector('text=Une authentification multifacteur auprès du fournisseur est exigée');
    assert.equal((await sessionOf(page)).authenticated, false);
    await context.close();
  } finally {
    await ctx.admin.put(`/admin/auth-providers/${p.id}`, { type: 'oidc', name: p.name, enabled: true, autoProvision: true, config: { ...p.config, mfa: 'auto' } });
  }
});

test('SAML 2.0 (Keycloak) : assertion signée validée, InResponseTo lié au flux, compte créé', async () => {
  const context = await ctx.browser.newContext({ locale: 'fr-FR' });
  const page = await context.newPage();
  await page.goto(`${PUBLIC}/auth/login`);
  await page.click(`a:has-text("Continuer avec ${NAMES.saml}")`);
  await keycloakLogin(page, 'sam', 'Sam-Saml-Password-1');
  await page.waitForURL(`${PUBLIC}/`, { timeout: 30_000 });
  const s = await sessionOf(page);
  assert.equal(s.authenticated, true);
  assert.equal(s.user.email, 'sam.saml@example.test');
  assert.equal(s.user.displayName, 'Sam');
  await context.close();
  // Réponse SAML forgée (non signée) : refusée.
  const forged = Buffer.from('<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>').toString('base64');
  const res = await fetch(`${BASE}/api/v1/auth/sso/${ctx.saml.id}/callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: forged, RelayState: 'inconnu' }),
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /sso_error=sso_expired/);
});

test('LDAP : connexion annuaire, filtre échappé, mauvais mot de passe et bind anonyme refusés', async () => {
  const api = new Client();
  // Injection de filtre : « * » ne doit correspondre à personne.
  assert.equal((await api.post('/auth/ldap/login', { providerId: ctx.ldap.id, username: '*', password: 'x' })).status, 401);
  assert.equal((await api.post('/auth/ldap/login', { providerId: ctx.ldap.id, username: 'bob', password: 'mauvais' })).status, 401);
  // Mot de passe vide (bind anonyme) : rejeté dès la validation.
  assert.equal((await api.post('/auth/ldap/login', { providerId: ctx.ldap.id, username: 'bob', password: '' })).status, 400);

  const context = await ctx.browser.newContext({ locale: 'fr-FR' });
  const page = await context.newPage();
  await page.goto(`${PUBLIC}/auth/login`);
  await page.click(`button:has-text("Annuaire : ${NAMES.ldap}")`);
  await page.fill('#ldap-login', 'bob');
  await page.fill('#ldap-password', 'Bob-Ldap-Password-1');
  await page.click('button:has-text("Se connecter via l’annuaire")');
  await page.waitForURL(`${PUBLIC}/`);
  const s = await sessionOf(page);
  assert.equal(s.user.email, 'bob.ldap@example.test');
  assert.equal(s.user.displayName, 'Bob Annuaire');
  await context.close();
});

test('pas de fusion par email : refus, puis rattachement explicite depuis les paramètres', async () => {
  // Compte local préexistant avec la même adresse que l'utilisateur Keycloak « erin ».
  const password = 'Phrase-Secrete-Locale-2026!';
  const created = await ctx.admin.post('/admin/users', { email: 'erin.local@example.test', username: 'erin-local', displayName: 'Erin Locale', platformRole: 'user', password });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const c1 = await ctx.browser.newContext({ locale: 'fr-FR' });
  const p1 = await c1.newPage();
  await p1.goto(`${PUBLIC}/api/v1/auth/sso/${ctx.oidc.id}/start`);
  await keycloakLogin(p1, 'erin', 'Erin-Sso-Password-1');
  await p1.waitForURL(/\/auth\/login\?sso_error=account_exists/);
  await p1.waitForSelector('text=Un compte utilise déjà cette adresse email');
  assert.equal((await sessionOf(p1)).authenticated, false);
  await c1.close();

  // Connexion locale puis rattachement explicite de l’identité Keycloak.
  const c2 = await ctx.browser.newContext({ locale: 'fr-FR' });
  const p2 = await c2.newPage();
  await p2.goto(`${PUBLIC}/auth/login`);
  await p2.fill('#login', 'erin-local');
  await p2.fill('#password', password);
  await p2.click('button:has-text("Se connecter")');
  await p2.waitForURL(`${PUBLIC}/`);
  await p2.goto(`${PUBLIC}/settings?tab=security`);
  await p2.click(`a:has-text("Rattacher ${NAMES.oidc}")`);
  await keycloakLogin(p2, 'erin', 'Erin-Sso-Password-1');
  await p2.waitForURL(/\/settings/);
  await p2.waitForSelector(`[aria-label="Identités de connexion"] >> text=${NAMES.oidc}`);
  await p2.screenshot({ path: new URL('sso-linked-identities.png', OUT).pathname });
  await c2.close();

  // Désormais, la connexion OIDC ouvre le compte local d'Erin.
  const c3 = await ctx.browser.newContext({ locale: 'fr-FR' });
  const p3 = await c3.newPage();
  await p3.goto(`${PUBLIC}/api/v1/auth/sso/${ctx.oidc.id}/start`);
  await keycloakLogin(p3, 'erin', 'Erin-Sso-Password-1');
  await p3.waitForURL(`${PUBLIC}/`);
  const s = await sessionOf(p3);
  assert.equal(s.user.username, 'erin-local');
  assert.equal(s.user.id, created.body.id);
  await c3.close();
});

test('fournisseur désactivé : démarrage refusé proprement', async () => {
  await ctx.admin.post(`/admin/auth-providers/${ctx.saml.id}/disable`);
  try {
    const res = await fetch(`${BASE}/api/v1/auth/sso/${ctx.saml.id}/start`, { redirect: 'manual' });
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /sso_error=provider_disabled/);
    const pub = await new Client().get('/auth/providers');
    assert.ok(!pub.body.providers.some((p) => p.id === ctx.saml.id));
  } finally {
    await ctx.admin.post(`/admin/auth-providers/${ctx.saml.id}/enable`);
  }
});
