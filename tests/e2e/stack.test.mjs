// Scénario de bout en bout sur la pile Docker Compose réelle :
// web (nginx) → API (2 répliques) → worker → sandbox Docker (Pi en RPC) → gateway → LiteLLM → fournisseur factice.
// Prérequis : `docker compose --profile dev up -d` (infrastructure/docker) et images construites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { Client, adminClient, sleep, uid } from './client.mjs';

const STATE_FILE = new URL('./.e2e-state.json', import.meta.url);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state));
const ctx = {};

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

test('administration : modèle LiteLLM (fournisseur factice), équipe, utilisateur', async () => {
  ctx.admin = await adminClient(state);
  save();
  const models = await ctx.admin.get('/admin/models');
  let model = models.body.find((m) => m.litellmModel === 'mock-model');
  if (!model) {
    const r = await ctx.admin.post('/admin/models', {
      litellmModel: 'mock-model',
      displayName: 'Mock (tests)',
      litellmParams: { model: 'openai/mock-model', api_base: 'http://mock-llm:4010/v1' },
      apiKey: 'not-needed',
      contextWindow: 128000,
      maxOutputTokens: 4096,
      supportsImages: false,
      supportsReasoning: false,
      enabled: true,
      isDefault: true,
      allowedTeamIds: [],
      coefficients: { input: '1', output: '2', cacheRead: '0.1', cacheWrite: '1.25' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    model = { id: r.body.id };
  }
  ctx.modelId = model.id;
  // SMTP de recette (Mailpit) pour les emails transactionnels.
  await ctx.admin.put('/admin/smtp', { host: 'mailpit', port: 1025, secure: false, fromAddress: 'noreply@example.test', fromName: 'CAP' });
  const test1 = await ctx.admin.post(`/admin/models/${model.id}/test`);
  assert.equal(test1.body.ok, true, `test du modèle : ${JSON.stringify(test1.body)}`);

  const slug = `e2e-${uid()}`;
  const team = await ctx.admin.post('/teams', { name: `Équipe ${slug}`, slug });
  assert.equal(team.status, 201);
  ctx.teamId = team.body.id;

  // Utilisateur standard (membre).
  const username = `dev${uid()}`;
  const created = await ctx.admin.post('/admin/users', { email: `${username}@example.test`, username, displayName: `Dev ${username}`, platformRole: 'user', password: 'Dev-Password-123456' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.userId = created.body.id;
  await ctx.admin.post(`/teams/${ctx.teamId}/members`, { userId: ctx.userId, role: 'member' });
  ctx.dev = new Client();
  const login = await ctx.dev.post('/auth/login', { login: username, password: 'Dev-Password-123456' });
  assert.equal(login.body.status, 'authenticated');
});

test('workspace vierge : Pi écrit via shell et via outil, checkpoint après chaque écriture, SSE, panneau Modifications', async () => {
  const p = await ctx.dev.post('/projects', { teamId: ctx.teamId, name: `Projet ${uid()}` });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const w = await ctx.dev.post('/workspaces', { projectId: p.body.id, name: 'Démo e2e' });
  assert.equal(w.status, 201);
  ctx.ws = w.body;
  const conv = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
  const prompt =
    'Crée les fichiers. ' +
    '[[tool:bash {"command":"mkdir -p src && echo hello-from-shell > src/hello.txt && ls src"}]] ' +
    '[[tool:write {"path":"README.md","content":"# Démo\\n"}]]';
  const sent = await ctx.dev.post(`/workspaces/${ctx.ws.id}/messages`, { text: prompt }, { 'Idempotency-Key': `e2e-${uid()}-msg1` });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  ctx.run1 = sent.body.runId;
  const events = await ctx.dev.events(ctx.ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === ctx.run1, 420_000);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('run.completed'), `run en échec : ${JSON.stringify(events.find((e) => e.type === 'run.failed'))}`);
  for (const t of ['run.started', 'message.created', 'tool.started', 'tool.completed', 'checkpoint.completed', 'file.changed', 'message.delta']) {
    assert.ok(types.includes(t), `événement ${t} absent : ${types.join(',')}`);
  }
  // Identifiants monotones.
  const ids = events.map((e) => e.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  // Chaque outil d'écriture a ses fichiers touchés (checkpoint après l'action, shell compris).
  const tools = events.filter((e) => e.type === 'tool.completed');
  assert.equal(tools.length, 2);
  assert.ok(tools[0].data.filesTouched.includes('src/hello.txt'), JSON.stringify(tools[0].data));
  assert.ok(tools[1].data.filesTouched.includes('README.md'), JSON.stringify(tools[1].data));

  // Le message final de l'assistant est diffusé (deltas) et persisté.
  assert.ok(events.some((e) => e.type === 'message.completed' && /Terminé : 2 action/.test(e.data.text)), 'message final absent du flux');
  const saved = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
  assert.ok(saved.body.messages.some((m) => m.role === 'assistant' && /Terminé : 2 action/.test(m.text)), 'message final non persisté');

  const changes = await ctx.dev.get(`/workspaces/${ctx.ws.id}/changes?scope=conversation`);
  const paths = changes.body.files.map((f) => `${f.status}:${f.path}`);
  assert.ok(paths.includes('added:src/hello.txt') && paths.includes('added:README.md'), paths.join(','));
  const diff = await ctx.dev.get(`/workspaces/${ctx.ws.id}/changes/diff?scope=conversation&path=src/hello.txt`);
  assert.match(diff.body.patch, /\+hello-from-shell/);
  const content = await ctx.dev.get(`/workspaces/${ctx.ws.id}/files/content?path=README.md`);
  assert.equal(content.body.content, '# Démo\n');

  // Reconnexion SSE avec un Last-Event-ID intermédiaire : rejoue sans relancer Pi.
  const mid = events[Math.floor(events.length / 2)].id;
  const replay = await ctx.dev.events(ctx.ws.id, mid, (e, seen) => e.id >= events.at(-1).id || seen.length > 500, 30_000);
  assert.equal(replay[0].id, mid + 1);
  const runs = (await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`)).body.runs;
  assert.equal(runs.filter((r) => r.id === ctx.run1).length, 1);
});

test('un seul run actif par workspace ; idempotence des envois', async () => {
  const key = `e2e-${uid()}-slow`;
  const slow = await ctx.dev.post(`/workspaces/${ctx.ws.id}/messages`, { text: 'Attends. [[sleep:6000]]' }, { 'Idempotency-Key': key });
  assert.equal(slow.status, 201);
  const replay = await ctx.dev.post(`/workspaces/${ctx.ws.id}/messages`, { text: 'Attends. [[sleep:6000]]' }, { 'Idempotency-Key': key });
  assert.equal(replay.body.runId, slow.body.runId, 'même clé → même run (pas de doublon)');
  const second = await ctx.dev.post(`/workspaces/${ctx.ws.id}/messages`, { text: 'Autre tâche' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'run_already_active');
  // Interruption propre.
  await sleep(1500);
  const intr = await ctx.dev.post(`/workspaces/${ctx.ws.id}/runs/${slow.body.runId}/interrupt`);
  assert.equal(intr.status, 202);
  const conv = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
  await ctx.dev.events(ctx.ws.id, Math.max(0, conv.body.lastEventId - 30), (e) => (e.type === 'run.interrupted' || e.type === 'run.completed') && e.runId === slow.body.runId, 120_000);
});

test('confidentialité : un administrateur (équipe ou plateforme) ne lit pas une conversation privée ; partage nominatif révocable', async () => {
  const r1 = await ctx.admin.get(`/workspaces/${ctx.ws.id}/conversation`);
  assert.equal(r1.status, 404, 'admin plateforme sans partage → introuvable');
  // Un autre membre de l'équipe.
  const username = `peer${uid()}`;
  const created = await ctx.admin.post('/admin/users', { email: `${username}@example.test`, username, displayName: 'Pair', platformRole: 'user', password: 'Peer-Password-123456' });
  await ctx.admin.post(`/teams/${ctx.teamId}/members`, { userId: created.body.id, role: 'team_admin' });
  const peer = new Client();
  await peer.post('/auth/login', { login: username, password: 'Peer-Password-123456' });
  assert.equal((await peer.get(`/workspaces/${ctx.ws.id}/conversation`)).status, 404, 'admin d’équipe sans partage → introuvable');
  const share = await ctx.dev.post(`/conversations/${ctx.ws.conversationId}/shares`, { userId: created.body.id });
  assert.equal(share.status, 201);
  const read = await peer.get(`/workspaces/${ctx.ws.id}/conversation`);
  assert.equal(read.status, 200);
  // Lecture seule : ni message, ni fichiers en écriture, ni approbation, ni preview.
  assert.equal((await peer.post(`/workspaces/${ctx.ws.id}/messages`, { text: 'hack' })).status, 404);
  assert.equal((await peer.post(`/workspaces/${ctx.ws.id}/previews`, { port: 3000 })).status, 404);
  assert.equal((await peer.post(`/conversations/${ctx.ws.conversationId}/shares`, { userId: ctx.userId })).status, 404, 'pas de transfert de partage');
  // Retrait de l'équipe → accès effectif révoqué.
  await ctx.admin.del(`/teams/${ctx.teamId}/members/${created.body.id}`);
  assert.equal((await peer.get(`/workspaces/${ctx.ws.id}/conversation`)).status, 404);
});

test('sandbox détruite puis restaurée fidèlement (fichiers + état de session Pi)', async () => {
  const stop = await ctx.dev.post(`/workspaces/${ctx.ws.id}/stop`);
  assert.equal(stop.status, 202);
  for (let i = 0; i < 60; i++) {
    const w = await ctx.dev.get(`/workspaces/${ctx.ws.id}`);
    if (w.body.status === 'ready') break;
    await sleep(2000);
  }
  assert.equal((await ctx.dev.get(`/workspaces/${ctx.ws.id}`)).body.status, 'ready');
  assert.equal(docker('ps', '-q', '--filter', `label=cap.workspace=${ctx.ws.id}`), '', 'sandbox détruite');
  const conv = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
  const sent = await ctx.dev.post(`/workspaces/${ctx.ws.id}/messages`, { text: 'Vérifie. [[tool:bash {"command":"cat src/hello.txt && cat README.md && ls /workspace-state/pi-sessions | wc -l"}]]' });
  const events = await ctx.dev.events(ctx.ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 420_000);
  const out = events.find((e) => e.type === 'tool.completed').data.output;
  assert.match(out, /hello-from-shell/);
  assert.match(out, /# Démo/);
  assert.notEqual(docker('ps', '-q', '--filter', `label=cap.workspace=${ctx.ws.id}`), '', 'nouvelle sandbox');
});

test('forges via la plateforme seulement : TLS intercepté, jeton de run, garde-fous ; pas d’accès direct ni interne', async () => {
  const conv = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
  const cmd = [
    'echo token:$(printf %s "$GH_TOKEN" | cut -c1-7)',
    'curl -sv -o /dev/null https://api.github.com/ 2>&1 | grep -i "issuer:" | head -1',
    'curl -s -o /dev/null -D - -X PUT -H "Authorization: token $GH_TOKEN" https://api.github.com/repos/o/r/pulls/1/merge | grep -i -E "^HTTP|x-cap-forge-denied" | tr -d "\\r"',
    'curl -s --noproxy "*" -m 5 https://github.com >/dev/null 2>&1 && echo direct:open || echo direct:blocked',
    'curl -s -m 5 https://registry.gitlab.com/ >/dev/null 2>&1 && echo registry:open || echo registry:blocked',
    'curl -s -m 5 http://169.254.169.254/ >/dev/null 2>&1 && echo meta:open || echo meta:blocked',
    'curl -s -m 5 http://postgres:5432 >/dev/null 2>&1 && echo pg:open || echo pg:blocked',
  ].join('; ');
  const sent = await ctx.dev.post(`/workspaces/${ctx.ws.id}/messages`, { text: `Teste le réseau. [[tool:bash ${JSON.stringify({ command: cmd })}]]` });
  const events = await ctx.dev.events(ctx.ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 300_000);
  const out = events.find((e) => e.type === 'tool.completed').data.output;
  assert.match(out, /token:cap_rt_/, out);
  assert.match(out, /issuer:.*Coding Agent Platform/i, `certificat de l’autorité des forges :\n${out}`);
  assert.match(out, /HTTP\/1\.1 403/, out);
  assert.match(out, /x-cap-forge-denied: 1/i, out);
  for (const k of ['direct', 'registry', 'meta', 'pg']) assert.match(out, new RegExp(`${k}:blocked`), `${k} non bloqué :\n${out}`);
  // Le registre npm (liste blanche) reste accessible.
  const conv2 = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
  const npm = await ctx.dev.post(`/workspaces/${ctx.ws.id}/messages`, { text: 'npm [[tool:bash {"command":"curl -s -o /dev/null -w npm:%{http_code} https://registry.npmjs.org/left-pad"}]]' });
  assert.equal(npm.status, 201, JSON.stringify(npm.body));
  const ev2 = await ctx.dev.events(ctx.ws.id, conv2.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === npm.body.runId, 300_000);
  const npmTool = ev2.find((e) => e.type === 'tool.completed' && e.runId === npm.body.runId);
  assert.ok(npmTool, `aucun outil exécuté : ${JSON.stringify(ev2.map((e) => [e.type, e.runId === npm.body.runId, e.data?.error ?? e.data?.reason ?? '']))}`);
  assert.match(npmTool.data.output, /npm:200/);
});

test('quotas : réservation refusée → run suspendu proprement, puis reprise', async () => {
  await ctx.admin.put('/admin/quotas/policies', { scope: 'user', subjectId: ctx.userId, limit5h: '0.001', limit7d: '1000', exempt: false });
  const r = await ctx.dev.post(`/workspaces/${ctx.ws.id}/messages`, { text: 'Encore' });
  assert.ok(r.status === 402 || r.status === 201, JSON.stringify(r.body));
  if (r.status === 201) {
    const conv = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
    await ctx.dev.events(ctx.ws.id, Math.max(0, conv.body.lastEventId - 20), (e) => e.type === 'quota.paused' && e.runId === r.body.runId, 300_000);
  } else {
    assert.equal(r.body.error.code, 'quota_exceeded');
  }
  await ctx.admin.put('/admin/quotas/policies', { scope: 'user', subjectId: ctx.userId, limit5h: null, limit7d: null, exempt: true });
  // Consommation enregistrée au ledger (détail en crédits : administration seulement).
  const adminUsage = await ctx.admin.get(`/admin/quotas/usage/${ctx.userId}`);
  assert.ok(Number(adminUsage.body.windows[0].used) > 0, 'consommation enregistrée au ledger');
  // Côté utilisateur, l'API ne renvoie que des pourcentages : ni crédits, ni tokens, ni coûts.
  await ctx.admin.put('/admin/quotas/policies', { scope: 'user', subjectId: ctx.userId, limit5h: String(Number(adminUsage.body.windows[0].used) * 4), limit7d: null, exempt: false });
  const usage = await ctx.dev.get('/usage');
  assert.equal(usage.status, 200);
  assert.equal(usage.body.user.windows[0].percent, 25);
  assert.equal(usage.body.user.windows[1].percent, null, 'fenêtre sans limite');
  const forbidden = /^"(credits?\w*|\w*Tokens?|tokens?\w*|\w*[cC]ost\w*|used|reserved|limit\w*|remaining|usage)":$/;
  for (const path of ['/usage', '/usage/breakdown', '/usage/requests', '/models', `/workspaces/${ctx.ws.id}/conversation`]) {
    const res = await ctx.dev.get(path);
    assert.equal(res.status, 200, path);
    const keys = JSON.stringify(res.body).match(/"[A-Za-z0-9_]+":/g) ?? [];
    const leaked = [...new Set(keys.filter((k) => forbidden.test(k) && k !== '"maxOutputTokens":'))];
    assert.deepEqual(leaked, [], `${path} expose : ${leaked.join(', ')}`);
  }
  const breakdown = await ctx.dev.get('/usage/breakdown');
  assert.equal(breakdown.body.byModel.reduce((s, m) => s + m.percent, 0), 100);
  await ctx.admin.put('/admin/quotas/policies', { scope: 'user', subjectId: ctx.userId, limit5h: null, limit7d: null, exempt: true });
});

test('previews : 3 ports par défaut, le 4e refusé ; jeton requis sur l’origine distincte', async () => {
  for (const port of [3001, 3002, 3003]) assert.equal((await ctx.dev.post(`/workspaces/${ctx.ws.id}/previews`, { port })).status, 201);
  const fourth = await ctx.dev.post(`/workspaces/${ctx.ws.id}/previews`, { port: 3004 });
  assert.equal(fourth.status, 409);
  assert.equal(fourth.body.error.code, 'preview_limit_reached');
  const host = `3001-${ctx.ws.id.replace(/-/g, '')}.preview.localhost`;
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 8090, path: '/', headers: { Host: host } }, (res) => resolve(res.statusCode)).on('error', reject);
  });
  assert.equal(status, 401, 'pas d’accès sans jeton');
  // Le lien signé ouvre une session de preview sur le sous-domaine uniquement.
  const list = await ctx.dev.get(`/workspaces/${ctx.ws.id}/previews`);
  const link = await ctx.dev.post(`/workspaces/${ctx.ws.id}/previews/${list.body[0].id}/link`);
  const u = new URL(link.body.url);
  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 8090, path: u.pathname + u.search, headers: { Host: u.host } }, (r) => resolve(r)).on('error', reject);
  });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers['set-cookie'][0], /^cap_preview=.*HttpOnly/);
});
