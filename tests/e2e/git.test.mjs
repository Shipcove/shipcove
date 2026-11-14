// Parcours Git complet contre une vraie forge GitLab (tests/e2e/forge) :
// connexion par jeton, projet depuis un dépôt, clone via la passerelle, publication et MR
// uniquement après approbation, commit exact publié, approbation à usage unique, refus.
// Prérequis : pile Compose + `docker compose -f tests/e2e/forge/compose.forge.yml up -d --wait`.
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

before(async () => {
  if (!FORGE_UP) return;
  if ((await gl('GET', '/user')).status !== 200) ensureRootToken();
  assert.equal((await gl('GET', '/user')).status, 200, 'jeton root GitLab');
  // Utilisateur GitLab et dépôt de démonstration (idempotent).
  let [glUser] = (await gl('GET', '/users?username=capdev')).body;
  if (!glUser) {
    const r = await gl('POST', '/users', { email: 'capdev@example.test', username: 'capdev', name: 'Cap Dev', password: 'Hx8-qPz3-Nm6v-Ws2k-e2e', skip_confirmation: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    glUser = r.body;
  }
  const pat = await gl('POST', `/users/${glUser.id}/personal_access_tokens`, { name: `cap-${uid()}`, scopes: ['api', 'read_repository', 'write_repository'], expires_at: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10) });
  assert.equal(pat.status, 201, JSON.stringify(pat.body));
  ctx.glToken = pat.body.token;
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
  ctx.dev = new Client();
  assert.equal((await ctx.dev.post('/auth/login', { login: username, password })).body.status, 'authenticated');
});

after(async () => {
  if (!FORGE_UP) return;
  await ctx.admin?.req('PATCH', '/admin/settings', { section: 'git', values: { insecureHttpHosts: [] } });
  if (ctx.ws) await ctx.dev.post(`/workspaces/${ctx.ws.id}/stop`).catch(() => undefined);
});

test('forge auto-hébergée : HTTPS exigé par défaut, HTTP seulement pour un hôte autorisé par l’administrateur', async () => {
  await ctx.admin.req('PATCH', '/admin/settings', { section: 'git', values: { insecureHttpHosts: [] } });
  const refused = await ctx.dev.post('/me/git-connections/token', { provider: 'gitlab_self_managed', host: FORGE_HOST, token: ctx.glToken });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  // Un membre ne peut pas modifier ce réglage.
  assert.equal((await ctx.dev.req('PATCH', '/admin/settings', { section: 'git', values: { insecureHttpHosts: [FORGE_HOST] } })).status, 403);
  assert.equal((await ctx.admin.req('PATCH', '/admin/settings', { section: 'git', values: { insecureHttpHosts: [FORGE_HOST] } })).status, 200);
  const conn = await ctx.dev.post('/me/git-connections/token', { provider: 'gitlab_self_managed', host: FORGE_HOST, token: ctx.glToken });
  assert.equal(conn.status, 201, JSON.stringify(conn.body));
  assert.ok(!JSON.stringify(conn.body).includes(ctx.glToken), 'jeton jamais renvoyé');
  ctx.connId = conn.body.id;
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
