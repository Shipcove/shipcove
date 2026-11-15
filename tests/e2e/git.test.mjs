// Parcours Git complet contre une vraie forge GitLab (tests/e2e/forge) :
// connexion par jeton, projet depuis un dépôt, clone via la passerelle, publication et MR
// uniquement après approbation, commit exact publié, approbation à usage unique, refus.
// Prérequis : pile Compose + `docker compose -f tests/e2e/forge/compose.forge.yml up -d --wait`.
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { Client, adminClient, uid } from './client.mjs';

const GITLAB = process.env.CAP_E2E_GITLAB_URL ?? 'http://127.0.0.1:8929';
const FORGE_HOST = 'gitlab.test:8929';
const ROOT_TOKEN = 'glpat-cap-e2e-root-token-0001';
const STATE_FILE = new URL('./.e2e-state.json', import.meta.url);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const ctx = {};

const FORGE_UP = await fetch(`${GITLAB}/users/sign_in`)
  .then((r) => r.ok)
  .catch(() => false);
if (!FORGE_UP) console.warn('# Git : forge GitLab de test non démarrée — suite ignorée (docker compose -f tests/e2e/forge/compose.forge.yml up -d --wait)');
const test = FORGE_UP ? nodeTest : nodeTest.skip;

/** Appel de l'API GitLab (jeton root de test par défaut). */
async function gl(method, path, body, token = ROOT_TOKEN) {
  // GitLab (Puma en mode simple) peut couper une connexion pendant un redémarrage : quelques reprises.
  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${GITLAB}/api/v4${path}`, {
        method,
        headers: { 'PRIVATE-TOKEN': token, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status !== 502 || attempt >= 5) break;
    } catch (e) {
      if (attempt >= 5) throw e;
    }
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Jeton root à valeur fixe (créé une fois via la console Rails, idempotent). */
function ensureRootToken() {
  const ruby = [
    "u = User.find_by_username('root')",
    "t = u.personal_access_tokens.find_by(name: 'cap-e2e') || u.personal_access_tokens.new(name: 'cap-e2e', scopes: ['api', 'sudo'], expires_at: 300.days.from_now)",
    `t.set_token('${ROOT_TOKEN}')`,
    't.save!',
  ].join('; ');
  execFileSync('docker', ['exec', 'cap-forge-test-gitlab-1', 'gitlab-rails', 'runner', ruby], { stdio: 'pipe', timeout: 300_000 });
}

/** Lance un message et attend la fin du run ; renvoie les événements. */
async function run(client, wsId, text, until) {
  const conv = await client.get(`/workspaces/${wsId}/conversation`);
  const sent = await client.post(`/workspaces/${wsId}/messages`, { text }, { 'Idempotency-Key': `g-${uid()}` });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const events = await client.events(wsId, conv.body.lastEventId, until ?? ((e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId), 420_000);
  return events;
}

const tool = (name, args) => `[[tool:${name} ${JSON.stringify(args)}]]`;

const FORGE_NAME = 'GitLab (tests)';
const GL_PASSWORD = 'Hx8-qPz3-Nm6v-Ws2k-e2e';
const PUBLIC = process.env.CAP_PUBLIC_URL ?? 'http://localhost:8080';
const executablePath = process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

/** Lecture d'un secret Vault (jeton root de l'environnement de développement, tests uniquement). */
function vaultRead(path) {
  const init = JSON.parse(readFileSync(new URL('../../infrastructure/docker/.secrets/vault-init.json', import.meta.url), 'utf8'));
  const out = execFileSync('docker', ['exec', '-e', `VAULT_TOKEN=${init.root_token}`, '-e', 'VAULT_ADDR=http://127.0.0.1:8200', 'cap-vault-1', 'vault', 'kv', 'get', '-format=json', `cap/${path}`], { encoding: 'utf8' });
  return JSON.parse(out).data.data;
}
const sql = (q) => execFileSync('docker', ['exec', '-i', 'cap-postgres-1', 'psql', '-U', 'cap', '-d', 'cap', '-tAc', q], { encoding: 'utf8' }).trim();

before(async () => {
  if (!FORGE_UP) return;
  if ((await gl('GET', '/user')).status !== 200) ensureRootToken();
  assert.equal((await gl('GET', '/user')).status, 200, 'jeton root GitLab');
  // Utilisateur GitLab et dépôt de démonstration (idempotent).
  let [glUser] = (await gl('GET', '/users?username=capdev')).body;
  if (!glUser) {
    const r = await gl('POST', '/users', { email: 'capdev@example.test', username: 'capdev', name: 'Cap Dev', password: GL_PASSWORD, skip_confirmation: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    glUser = r.body;
  }
  // Jeton personnel : sert uniquement à vérifier qu'il est refusé par défaut.
  const pat = await gl('POST', `/users/${glUser.id}/personal_access_tokens`, { name: `cap-${uid()}`, scopes: ['api'], expires_at: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10) });
  ctx.glPat = pat.body.token;
  let project = await gl('GET', `/projects/${encodeURIComponent('capdev/cap-demo')}`);
  if (project.status === 404) {
    project = await gl('POST', `/projects/user/${glUser.id}`, { name: 'cap-demo', path: 'cap-demo', initialize_with_readme: true, default_branch: 'main', visibility: 'private' });
    assert.equal(project.status, 201, JSON.stringify(project.body));
  }
  ctx.glProject = project.body;

  ctx.admin = await adminClient(state);
  const slug = `git-${uid()}`;
  const team = await ctx.admin.post('/teams', { name: `Git ${slug}`, slug });
  const username = `g${uid()}`;
  const password = 'Git-Password-123456';
  const u = await ctx.admin.post('/admin/users', { email: `${username}@example.test`, username, displayName: `Git ${username}`, platformRole: 'user', password });
  await ctx.admin.post(`/teams/${team.body.id}/members`, { userId: u.body.id, role: 'member' });
  ctx.teamId = team.body.id;
  ctx.devLogin = { username, password };
  ctx.dev = new Client();
  assert.equal((await ctx.dev.post('/auth/login', { login: username, password })).body.status, 'authenticated');
});

after(async () => {
  if (!FORGE_UP) return;
  await ctx.admin?.req('PATCH', '/admin/settings', { section: 'git', values: { insecureHttpHosts: [], allowPersonalTokens: false } });
  if (ctx.ws) await ctx.dev.post(`/workspaces/${ctx.ws.id}/stop`).catch(() => undefined);
});

test('forges Git administrées : jeton personnel refusé par défaut, configuration réservée à l’administrateur, test des identifiants', async () => {
  // Par défaut : OAuth uniquement.
  const pat = await ctx.dev.post('/me/git-connections/token', { provider: 'gitlab_self_managed', host: FORGE_HOST, token: ctx.glPat });
  assert.equal(pat.status, 403, JSON.stringify(pat.body));
  // Seul l'administrateur déclare les forges et les réglages Git.
  assert.equal((await ctx.dev.post('/admin/git-forges', { provider: 'gitlab_self_managed', name: 'x', host: 'x.test', clientId: 'x' })).status, 403);
  assert.equal((await ctx.dev.req('PATCH', '/admin/settings', { section: 'git', values: { insecureHttpHosts: [FORGE_HOST] } })).status, 403);

  // Forge déclarée (idempotent par hôte) ; HTTPS exigé tant que l'hôte n'est pas autorisé en HTTP.
  await ctx.admin.req('PATCH', '/admin/settings', { section: 'git', values: { insecureHttpHosts: [] } });
  let forge = (await ctx.admin.get('/admin/git-forges')).body.find((f) => f.host === FORGE_HOST);
  if (!forge) {
    const r = await ctx.admin.post('/admin/git-forges', { provider: 'gitlab_self_managed', name: FORGE_NAME, host: FORGE_HOST, clientId: 'en-attente', enabled: false });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    forge = r.body;
  }
  assert.equal(forge.callbackUrl, `${PUBLIC}/api/v1/me/git-connections/oauth/${forge.id}/callback`);
  // Application OAuth GitLab déclarant l'URL de rappel de la plateforme.
  for (const app of (await gl('GET', '/applications')).body.filter((a) => a.application_name === 'cap-e2e')) await gl('DELETE', `/applications/${app.id}`);
  const app = await gl('POST', '/applications', { name: 'cap-e2e', redirect_uri: forge.callbackUrl, scopes: forge.scopes.join(' '), confidential: true });
  assert.equal(app.status, 201, JSON.stringify(app.body));
  const upsert = (values) => ctx.admin.put(`/admin/git-forges/${forge.id}`, { provider: 'gitlab_self_managed', name: FORGE_NAME, host: FORGE_HOST, clientId: app.body.application_id, enabled: true, ...values });

  assert.equal((await upsert({ clientSecret: app.body.secret })).status, 200);
  let t = await ctx.admin.post(`/admin/git-forges/${forge.id}/test`);
  assert.equal(t.body.ok, false, 'HTTPS exigé par défaut : la forge HTTP est injoignable');
  assert.equal((await ctx.admin.req('PATCH', '/admin/settings', { section: 'git', values: { insecureHttpHosts: [FORGE_HOST] } })).status, 200);
  // Mauvais secret détecté par le test, puis bon secret.
  await upsert({ clientSecret: 'secret-errone' });
  t = await ctx.admin.post(`/admin/git-forges/${forge.id}/test`);
  assert.equal(t.body.ok, false, JSON.stringify(t.body));
  assert.match(t.body.detail, /Identifiants client refusés/);
  await upsert({ clientSecret: app.body.secret });
  t = await ctx.admin.post(`/admin/git-forges/${forge.id}/test`);
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
  const listed = await ctx.admin.get('/admin/git-forges');
  assert.ok(!JSON.stringify(listed.body).includes(app.body.secret), 'secret client jamais renvoyé');
  const pub = await ctx.dev.get('/me/git-connections/oauth/providers');
  assert.ok(pub.body.forges.some((f) => f.id === forge.id), 'forge active proposée aux utilisateurs');
  assert.equal(pub.body.allowPersonalTokens, false);
  ctx.forge = forge;
});

test('rattachement OAuth dans le navigateur (PKCE + state), retour non rejouable', async () => {
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--host-resolver-rules=MAP gitlab.test 127.0.0.1'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.goto(`${PUBLIC}/auth/login`);
    await page.fill('#login', ctx.devLogin.username);
    await page.fill('#password', ctx.devLogin.password);
    await page.click('button:has-text("Se connecter")');
    await page.waitForURL(`${PUBLIC}/`);
    await page.goto(`${PUBLIC}/settings/git`);
    let callback = null;
    page.on('request', (r) => {
      if (r.url().includes(`/oauth/${ctx.forge.id}/callback`)) callback = r.url();
    });
    await page.click(`a:has-text("Connecter via ${FORGE_NAME}")`);
    await page.waitForURL(/gitlab\.test:8929\/users\/sign_in/, { timeout: 60_000 });
    const authorize = new URL(page.url()).searchParams.get('redirect_to') ?? '';
    await page.fill('#user_login', 'capdev');
    await page.fill('#user_password', GL_PASSWORD);
    await page.click('[data-testid="sign-in-button"], button[type="submit"]:has-text("Sign in")');
    await page.waitForURL(/oauth\/authorize/, { timeout: 60_000 });
    assert.match(page.url() + authorize, /code_challenge_method=S256/);
    // La mise en page GitLab recouvre parfois le bouton : clic direct sur l'élément du formulaire.
    await page.locator('[data-testid="authorization-button"]').evaluate((b) => b.click());
    await page.waitForURL(/\/settings\/git/, { timeout: 60_000 });
    await page.waitForSelector('[aria-label="Connexions Git"] >> text=capdev');
    await page.screenshot({ path: new URL('artifacts/git-oauth-connected.png', import.meta.url).pathname });
    // Le retour (code + state) ne peut pas être rejoué.
    assert.ok(callback);
    await page.goto(callback);
    await page.waitForURL(/git_error=expired/);
  } finally {
    await browser.close();
  }
  const conns = (await ctx.dev.get('/me/git-connections')).body.filter((c) => c.host === FORGE_HOST && c.status === 'active');
  assert.equal(conns.length, 1, JSON.stringify(conns));
  ctx.connId = conns[0].id;
  ctx.glToken = vaultRead(`git-connections/${ctx.connId}`).accessToken;
  assert.ok(ctx.glToken);
  assert.equal(sql(`select auth_type || ' ' || (forge_id = '${ctx.forge.id}') || ' ' || (token_expires_at > now()) from git_connections where id = '${ctx.connId}'`), 'oauth true true');
});

test('renouvellement du jeton OAuth : automatique, sûr sous concurrence', async () => {
  const before = vaultRead(`git-connections/${ctx.connId}`);
  sql(`update git_connections set token_expires_at = now() - interval '1 minute' where id = '${ctx.connId}'`);
  // Plusieurs appels simultanés : un seul renouvellement (jeton de renouvellement GitLab à usage unique).
  const results = await Promise.all(Array.from({ length: 5 }, () => ctx.dev.get(`/me/git-connections/${ctx.connId}/repositories`)));
  for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = vaultRead(`git-connections/${ctx.connId}`);
  assert.notEqual(after.accessToken, before.accessToken, 'jeton renouvelé');
  assert.notEqual(after.refreshToken, before.refreshToken, 'jeton de renouvellement remplacé');
  assert.equal(sql(`select status || ' ' || (token_expires_at > now() + interval '30 minutes') from git_connections where id = '${ctx.connId}'`), 'active true');
  // Second renouvellement : le nouveau jeton de renouvellement est bien celui conservé.
  sql(`update git_connections set token_expires_at = now() - interval '1 minute' where id = '${ctx.connId}'`);
  assert.equal((await ctx.dev.get(`/me/git-connections/${ctx.connId}/repositories`)).status, 200);
  ctx.glToken = vaultRead(`git-connections/${ctx.connId}`).accessToken;
});

test('projet depuis un dépôt GitLab : clone via la passerelle, sans jeton dans la sandbox', async () => {
  const p = await ctx.dev.post('/projects', { teamId: ctx.teamId, name: `Démo Git ${uid()}`, repository: { gitConnectionId: ctx.connId, fullName: 'capdev/cap-demo' } });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const w = await ctx.dev.post('/workspaces', { projectId: p.body.id, name: 'Git e2e' });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  ctx.ws = w.body;
  const events = await run(ctx.dev, ctx.ws.id, `Inspecte. ${tool('bash', { command: 'cat README.md; git log --oneline -1; git remote -v; cat ~/.gitconfig; env' })}`);
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  const out = events.filter((e) => e.type === 'tool.completed').map((e) => e.data.output).join('\n');
  assert.match(out, /cap-demo/i, out);
  assert.ok(!out.includes(ctx.glToken), 'le jeton GitLab ne doit jamais atteindre la sandbox');
});

test('publication : aucune écriture avant approbation, commit exact publié, approbation à usage unique', async () => {
  const branch = `feat-${uid().toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const pid = ctx.glProject.id;
  let events = await run(
    ctx.dev,
    ctx.ws.id,
    `Publie. ${tool('bash', { command: `git checkout -b ${branch} && echo e2e > e2e.txt && git add e2e.txt && git commit -qm "e2e: ajout" && git rev-parse HEAD` })} ${tool('platform_git_push', { local_branch: branch })}`,
  );
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  const sha = events.find((e) => e.type === 'tool.completed').data.output.trim().split('\n').pop();
  const required = events.find((e) => e.type === 'approval.required');
  assert.ok(required, 'approbation demandée');
  // Rien n'est publié tant que l'humain n'a pas décidé.
  assert.equal((await gl('GET', `/projects/${pid}/repository/branches/${branch}`)).status, 404);
  const approvals = (await ctx.dev.get(`/workspaces/${ctx.ws.id}/git/approvals?status=pending`)).body;
  const approval = approvals.find((a) => a.id === required.data.approvalId);
  assert.ok(approval, JSON.stringify(approvals));
  assert.equal(approval.commitSha, sha, 'opération exacte : commit figé à la demande');

  // Pi ajoute un commit APRÈS la demande : l'opération approuvée ne correspond plus, rien n'est publié.
  await run(ctx.dev, ctx.ws.id, `Encore. ${tool('bash', { command: 'echo tardif >> e2e.txt && git commit -qam "tardif"' })}`);
  let conv = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
  let decided = await ctx.dev.post(`/approvals/${approval.id}/decision`, { decision: 'approve' }, { 'Idempotency-Key': `g-${uid()}` });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  events = await ctx.dev.events(ctx.ws.id, conv.body.lastEventId, (e) => e.type === 'git.operation' && ['succeeded', 'failed', 'unknown'].includes(e.data.status), 240_000);
  assert.equal(events.at(-1).data.status, 'failed', JSON.stringify(events.at(-1)));
  assert.match(events.at(-1).data.detail, /changé depuis l’approbation/);
  assert.equal((await gl('GET', `/projects/${pid}/repository/branches/${branch}`)).status, 404, 'rien de publié');

  // Nouvelle demande sur l'état courant → approuvée → exactement ce commit est publié.
  events = await run(ctx.dev, ctx.ws.id, `Republie. ${tool('bash', { command: 'git rev-parse HEAD' })} ${tool('platform_git_push', { local_branch: branch })}`);
  const head = events.find((e) => e.type === 'tool.completed').data.output.trim();
  const req2 = events.find((e) => e.type === 'approval.required');
  conv = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
  decided = await ctx.dev.post(`/approvals/${req2.data.approvalId}/decision`, { decision: 'approve' }, { 'Idempotency-Key': `g-${uid()}` });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  events = await ctx.dev.events(ctx.ws.id, conv.body.lastEventId, (e) => e.type === 'git.operation' && ['succeeded', 'failed', 'unknown'].includes(e.data.status), 240_000);
  assert.equal(events.at(-1).data.status, 'succeeded', JSON.stringify(events.at(-1)));
  const remote = await gl('GET', `/projects/${pid}/repository/branches/${branch}`);
  assert.equal(remote.status, 200);
  assert.equal(remote.body.commit.id, head, 'commit approuvé publié');
  assert.notEqual(head, sha);
  // Usage unique.
  const again = await ctx.dev.post(`/approvals/${approval.id}/decision`, { decision: 'approve' }, { 'Idempotency-Key': `g-${uid()}` });
  assert.equal(again.status, 409, JSON.stringify(again.body));
  ctx.branch = branch;
});

test('merge request créée sur GitLab après approbation ; une demande refusée ne publie rien', async () => {
  const pid = ctx.glProject.id;
  let events = await run(ctx.dev, ctx.ws.id, `MR. ${tool('platform_create_pull_request', { source_branch: ctx.branch, target_branch: 'main', title: `E2E ${ctx.branch}` })}`);
  const required = events.find((e) => e.type === 'approval.required');
  assert.ok(required, JSON.stringify(events.map((e) => e.type)));
  assert.equal((await gl('GET', `/projects/${pid}/merge_requests?source_branch=${ctx.branch}`)).body.length, 0);
  const conv = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
  await ctx.dev.post(`/approvals/${required.data.approvalId}/decision`, { decision: 'approve' }, { 'Idempotency-Key': `g-${uid()}` });
  events = await ctx.dev.events(ctx.ws.id, conv.body.lastEventId, (e) => e.type === 'git.operation' && ['succeeded', 'failed', 'unknown'].includes(e.data.status), 240_000);
  assert.equal(events.at(-1).data.status, 'succeeded', JSON.stringify(events.at(-1)));
  const mrs = (await gl('GET', `/projects/${pid}/merge_requests?source_branch=${ctx.branch}`)).body;
  assert.equal(mrs.length, 1);
  assert.equal(mrs[0].target_branch, 'main');

  // Refus : la branche n'est jamais publiée.
  const other = `${ctx.branch}-refus`;
  events = await run(ctx.dev, ctx.ws.id, `Publie. ${tool('bash', { command: `git checkout -qb ${other} && echo x > refus.txt && git add . && git commit -qm refus` })} ${tool('platform_git_push', { local_branch: other })}`);
  const req2 = events.find((e) => e.type === 'approval.required');
  assert.equal((await ctx.dev.post(`/approvals/${req2.data.approvalId}/decision`, { decision: 'reject' }, { 'Idempotency-Key': `g-${uid()}` })).body.status, 'rejected');
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal((await gl('GET', `/projects/${pid}/repository/branches/${other}`)).status, 404);
});

test('autonomie de Pi : git push et MR sans approbation ; main, fusion et suppression refusées par la plateforme', async () => {
  const pid = ctx.glProject.id;
  const b = `auto-${uid().toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const mainBefore = (await gl('GET', `/projects/${pid}/repository/branches/main`)).body.commit.id;
  const api = `http://${FORGE_HOST}/api/v4/projects/${pid}`;
  const cmd = [
    `echo token:$(printf %s "$GITLAB_TOKEN" | cut -c1-7)`,
    `env | grep -c glpat- || true`,
    `git checkout -qb ${b} && echo auto > auto.txt && git add auto.txt && git commit -qm "auto: ajout" && git push -q origin ${b} 2>&1 && echo PUSH_OK`,
    `timeout 60 git push origin HEAD:main 2>&1 | grep -E "rejected|refus" | head -2`,
    `timeout 60 git push origin --delete ${ctx.branch} 2>&1 | grep -E "rejected|refus" | head -2`,
    `curl -s -o /tmp/mr.json -w "mr:%{http_code}\\n" -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -X POST "${api}/merge_requests" -d source_branch=${b} -d target_branch=main -d title=auto-${b}`,
    `IID=$(python3 -c "import json;print(json.load(open('/tmp/mr.json'))['iid'])")`,
    `curl -s -o /tmp/merge.json -w "merge:%{http_code}\\n" -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -X PUT "${api}/merge_requests/$IID/merge"; cat /tmp/merge.json; echo`,
    `curl -s -o /dev/null -w "deploykey:%{http_code}\\n" -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -X POST "${api}/deploy_keys" -d title=x -d key=x`,
    `GITLAB_HOST=http://${FORGE_HOST} glab api projects/${pid} 2>&1 | grep -o '"path_with_namespace":"[^"]*"' || echo glab:ko`,
  ].join('; ');
  const events = await run(ctx.dev, ctx.ws.id, `Autonomie. ${tool('bash', { command: cmd, timeout: 300 })}`);
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  assert.equal(events.filter((e) => e.type === 'approval.required').length, 0, 'aucune approbation demandée');
  const out = events.filter((e) => e.type === 'tool.completed').map((e) => e.data.output).join('\n');
  assert.match(out, /token:cap_rt_/, out);
  assert.match(out, /^0$/m, 'aucun jeton GitLab dans l’environnement');
  assert.ok(!out.includes(ctx.glToken ?? 'jamais'), 'jeton OAuth absent des sorties');
  assert.match(out, /PUSH_OK/, out);
  assert.match(out, /main.*(rejected|refus)|(rejected|refus).*main/, out);
  assert.match(out, /mr:201/, out);
  assert.match(out, /merge:403/, out);
  assert.match(out, /platform_merge_pull_request/, out);
  assert.match(out, /deploykey:403/, out);
  assert.match(out, /"path_with_namespace":"capdev\/cap-demo"/, `glab : ${out}`);

  // État réel de la forge.
  const pushed = await gl('GET', `/projects/${pid}/repository/branches/${b}`);
  assert.equal(pushed.status, 200, 'branche de travail poussée directement');
  assert.equal((await gl('GET', `/projects/${pid}/repository/branches/main`)).body.commit.id, mainBefore, 'main intacte');
  assert.equal((await gl('GET', `/projects/${pid}/repository/branches/${ctx.branch}`)).status, 200, 'suppression refusée');
  const mrs = (await gl('GET', `/projects/${pid}/merge_requests?source_branch=${b}`)).body;
  assert.equal(mrs.length, 1);
  assert.equal(mrs[0].state, 'opened', 'MR ouverte mais non fusionnée');
  assert.equal(mrs[0].author.username, 'capdev', 'MR créée au nom de l’utilisateur');
  // Écritures et refus journalisés.
  assert.ok(Number(sql(`select count(*) from audit_events where action = 'git.agent_write' and outcome = 'success' and target_id = '${ctx.ws.id}'`)) >= 2);
  assert.ok(Number(sql(`select count(*) from audit_events where action = 'git.agent_write' and outcome = 'failure' and target_id = '${ctx.ws.id}'`)) >= 2);
});

test('suppression de la forge par l’administrateur : connexions révoquées', async () => {
  const r = await ctx.admin.req('DELETE', `/admin/git-forges/${ctx.forge.id}`);
  assert.equal(r.status, 204);
  const conns = (await ctx.dev.get('/me/git-connections')).body.filter((c) => c.id === ctx.connId);
  assert.equal(conns.length, 0, 'connexion révoquée (plus listée)');
  assert.equal(sql(`select status from git_connections where id = '${ctx.connId}'`), 'revoked');
  assert.ok(!(await ctx.dev.get('/me/git-connections/oauth/providers')).body.forges.some((f) => f.id === ctx.forge.id), 'forge supprimée retirée de la liste');
});
