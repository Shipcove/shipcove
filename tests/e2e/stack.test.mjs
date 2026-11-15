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

/** API d'administration de LiteLLM (clé maître de l'environnement de développement, tests uniquement). */
const LITELLM = process.env.CAP_E2E_LITELLM_URL ?? 'http://127.0.0.1:4000';
const LITELLM_KEY = readFileSync(new URL('../../infrastructure/docker/.secrets/litellm_master_key', import.meta.url), 'utf8').trim();
async function litellm(method, path, body) {
  const res = await fetch(`${LITELLM}${path}`, { method, headers: { Authorization: `Bearer ${LITELLM_KEY}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  assert.ok(res.ok, `LiteLLM ${path} : ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
/** Déclare (ou remplace) un modèle dans LiteLLM ; `params` nul : le retire. Prix personnalisés dans litellm_params. */
async function litellmModel(name, params) {
  for (const m of (await litellm('GET', '/model/info')).data.filter((x) => x.model_name === name)) await litellm('POST', '/model/delete', { id: m.model_info.id });
  if (params) await litellm('POST', '/model/new', { model_name: name, litellm_params: { input_cost_per_token: 0.000003, output_cost_per_token: 0.000015, ...params }, model_info: { mode: 'chat' } });
}

test('administration : modèle LiteLLM (fournisseur factice), utilisateur', async () => {
  ctx.admin = await adminClient(state);
  save();
  // Le modèle se déclare dans LiteLLM ; la plateforme le découvre puis l'administrateur l'active.
  await litellmModel('mock-model', { model: 'openai/mock-model', api_base: 'http://mock-llm:4010/v1', api_key: 'not-needed' });
  const reload = await ctx.admin.post('/admin/models/reload');
  assert.equal(reload.status, 200, JSON.stringify(reload.body));
  let model = (await ctx.admin.get('/admin/models')).body.find((m) => m.litellmModel === 'mock-model');
  assert.ok(model, 'modèle découvert');
  const enable = await ctx.admin.patch(`/admin/models/${model.id}`, {
    displayName: 'Mock (tests)',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    enabled: true,
    isDefault: true,
    allowedUserIds: [],
    coefficients: { input: '1', output: '2', cacheRead: '0.1', cacheWrite: '1.25' },
  });
  assert.equal(enable.status, 200, JSON.stringify(enable.body));
  model = (await ctx.admin.get('/admin/models')).body.find((m) => m.id === model.id);
  assert.equal(model.isDefault, true);
  ctx.modelId = model.id;
  // SMTP de recette (Mailpit) pour les emails transactionnels.
  await ctx.admin.put('/admin/smtp', { host: 'mailpit', port: 1025, secure: false, fromAddress: 'noreply@example.test', fromName: 'CAP' });
  const test1 = await ctx.admin.post(`/admin/models/${model.id}/test`);
  assert.equal(test1.body.ok, true, `test du modèle : ${JSON.stringify(test1.body)}`);

  // Utilisateur standard.
  const username = `dev${uid()}`;
  const created = await ctx.admin.post('/admin/users', { email: `${username}@example.test`, username, displayName: `Dev ${username}`, platformRole: 'user', password: 'Dev-Password-123456' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ctx.userId = created.body.id;
  ctx.dev = new Client();
  const login = await ctx.dev.post('/auth/login', { login: username, password: 'Dev-Password-123456' });
  assert.equal(login.body.status, 'authenticated');
});

test('LiteLLM : connexion réglable depuis l’administration, découverte des modèles, activation, liste blanche', async () => {
  // Connexion actuelle (valeur de déploiement ou réglée dans l'interface) ; la clé n'est jamais renvoyée.
  const conn = await ctx.admin.get('/admin/litellm/connection');
  assert.equal(conn.status, 200);
  assert.ok(conn.body.keyConfigured);
  assert.ok(!JSON.stringify(conn.body).includes(LITELLM_KEY));
  assert.equal((await ctx.dev.get('/admin/litellm/connection')).status, 403);
  // Test d'une connexion sans l'enregistrer : URL injoignable, mauvaise clé, puis la bonne.
  assert.equal((await ctx.admin.post('/admin/litellm/connection/test', { url: 'http://inexistant.invalid:4000' })).body.ok, false);
  assert.equal((await ctx.admin.post('/admin/litellm/connection/test', { url: conn.body.url, masterKey: 'sk-mauvaise-cle' })).body.ok, false);
  const ok = await ctx.admin.post('/admin/litellm/connection/test', { url: conn.body.url });
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.ok(ok.body.models.includes('mock-model'));
  // Enregistrement (clé conservée) → recharge des modèles.
  const saved = await ctx.admin.put('/admin/litellm/connection', { url: conn.body.url });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.connection.source, 'admin');
  assert.equal(saved.body.syncError, null);

  // Nouveau modèle déclaré dans LiteLLM : découvert désactivé, coefficients préremplis depuis ses prix.
  const name = `mock-extra-${uid().toLowerCase()}`;
  await litellmModel(name, { model: 'openai/mock-model', api_base: 'http://mock-llm:4010/v1', api_key: 'not-needed' });
  try {
    const reload = await ctx.admin.post('/admin/models/reload');
    assert.ok(reload.body.added.includes(name), JSON.stringify(reload.body));
    let extra = (await ctx.admin.get('/admin/models')).body.find((m) => m.litellmModel === name);
    assert.equal(extra.enabled, false);
    assert.equal(extra.coefficients.input, '3.00000000');
    assert.equal(extra.coefficients.output, '15.00000000');
    assert.ok(!(await ctx.dev.get('/models')).body.some((m) => m.id === extra.id), 'modèle désactivé invisible');
    // Par défaut impossible tant qu'il est désactivé.
    assert.equal((await ctx.admin.patch(`/admin/models/${extra.id}`, { isDefault: true })).status, 400);
    assert.equal((await ctx.admin.patch(`/admin/models/${extra.id}`, { enabled: true })).status, 200);
    assert.ok((await ctx.dev.get('/models')).body.some((m) => m.id === extra.id), 'activé, sans liste blanche : accessible à tous');

    // Liste blanche : seul l'administrateur y figure → invisible et refusé pour l'utilisateur.
    const me = (await ctx.admin.get('/me')).body;
    assert.equal((await ctx.admin.patch(`/admin/models/${extra.id}`, { allowedUserIds: [me.id] })).status, 200);
    assert.ok(!(await ctx.dev.get('/models')).body.some((m) => m.id === extra.id), 'hors liste blanche : invisible');
    const w = await ctx.dev.post('/workspaces', { modelId: extra.id });
    assert.equal(w.status, 403, JSON.stringify(w.body));
    assert.equal(w.body.error.code, 'model_not_allowed');
    assert.ok((await ctx.admin.get('/models')).body.some((m) => m.id === extra.id), 'dans la liste blanche : visible');
    assert.equal((await ctx.admin.patch(`/admin/models/${extra.id}`, { allowedUserIds: ['00000000-0000-4000-8000-000000000000'] })).status, 400);

    // Retiré de LiteLLM : signalé absent et indisponible, plus proposé.
    await litellmModel(name, null);
    const again = await ctx.admin.post('/admin/models/reload');
    assert.ok(again.body.missing.includes(name));
    extra = (await ctx.admin.get('/admin/models')).body.find((m) => m.id === extra.id);
    assert.equal(extra.available, false);
    assert.equal(extra.lastSyncError, 'Absent de LiteLLM');
    assert.equal((await ctx.admin.del(`/admin/models/${extra.id}`)).status, 204);
  } finally {
    // Nettoyage même en cas d'échec : rien ne doit subsister dans LiteLLM ni dans le catalogue.
    await litellmModel(name, null).catch(() => undefined);
    const left = (await ctx.admin.get('/admin/models')).body.find((m) => m.litellmModel === name);
    if (left) await ctx.admin.del(`/admin/models/${left.id}`);
  }
});

test('conversation sans dépôt : Pi écrit via shell et via outil, checkpoint après chaque écriture, SSE, panneau Modifications, titre automatique', async () => {
  const w = await ctx.dev.post('/workspaces', {});
  assert.equal(w.status, 201, JSON.stringify(w.body));
  assert.equal(w.body.name, 'Nouvelle conversation');
  assert.equal(w.body.titleSource, 'auto');
  assert.equal(w.body.repository, null);
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

  // Titre généré après le premier message (sans modèle de titre : début du message), diffusé en direct.
  let renamed = null;
  for (let i = 0; i < 20 && !renamed; i++) {
    const cur = (await ctx.dev.get(`/workspaces/${ctx.ws.id}`)).body;
    if (cur.name !== 'Nouvelle conversation') renamed = cur;
    else await sleep(500);
  }
  assert.ok(renamed, 'titre non généré');
  assert.match(renamed.name, /^Crée les fichiers/);
  assert.ok(!renamed.name.includes('[[tool'), 'les directives ne font pas partie du titre');
  assert.ok(events.some((e) => e.type === 'workspace.renamed') || renamed.titleSource === 'auto');
  // Renommage par l'utilisateur : définitif (le titre automatique ne l'écrase plus).
  assert.equal((await ctx.dev.patch(`/workspaces/${ctx.ws.id}`, { name: 'Démo e2e' })).status, 200);
  const after = (await ctx.dev.get(`/workspaces/${ctx.ws.id}`)).body;
  assert.equal(after.name, 'Démo e2e');
  assert.equal(after.titleSource, 'user');
  // Liste de la barre latérale : la conversation y figure, sans dépôt.
  const list = (await ctx.dev.get('/workspaces')).body;
  assert.ok(list.some((x) => x.id === ctx.ws.id && x.repository === null));
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

test('confidentialité : un administrateur ne lit pas une conversation privée ; partage nominatif révocable avec tout utilisateur', async () => {
  const r1 = await ctx.admin.get(`/workspaces/${ctx.ws.id}/conversation`);
  assert.equal(r1.status, 404, 'admin plateforme sans partage → introuvable');
  // Un autre utilisateur de la plateforme, trouvé dans l'annuaire.
  const username = `peer${uid()}`;
  const created = await ctx.admin.post('/admin/users', { email: `${username}@example.test`, username, displayName: 'Pair', platformRole: 'user', password: 'Peer-Password-123456' });
  const peer = new Client();
  await peer.post('/auth/login', { login: username, password: 'Peer-Password-123456' });
  const found = await ctx.dev.get(`/users/search?q=${username}`);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.map((u) => u.id), [created.body.id]);
  assert.ok(!('email' in found.body[0]), 'l’annuaire n’expose pas les emails');
  assert.equal((await peer.get(`/workspaces/${ctx.ws.id}/conversation`)).status, 404, 'autre utilisateur sans partage → introuvable');
  assert.ok(!(await peer.get('/workspaces')).body.some((x) => x.id === ctx.ws.id));
  const share = await ctx.dev.post(`/conversations/${ctx.ws.conversationId}/shares`, { userId: created.body.id });
  assert.equal(share.status, 201);
  const read = await peer.get(`/workspaces/${ctx.ws.id}/conversation`);
  assert.equal(read.status, 200);
  // Lecture seule : ni message, ni fichiers en écriture, ni approbation, ni preview.
  assert.equal((await peer.post(`/workspaces/${ctx.ws.id}/messages`, { text: 'hack' })).status, 404);
  assert.equal((await peer.post(`/workspaces/${ctx.ws.id}/previews`, { port: 3000 })).status, 404);
  assert.equal((await peer.post(`/conversations/${ctx.ws.conversationId}/shares`, { userId: ctx.userId })).status, 404, 'pas de transfert de partage');
  // La conversation partagée apparaît dans la liste du destinataire, en lecture seule.
  assert.equal((await peer.get('/workspaces')).body.find((x) => x.id === ctx.ws.id)?.access, 'shared_read');
  // Révocation → accès effectif retiré.
  assert.equal((await ctx.dev.del(`/conversations/${ctx.ws.conversationId}/shares/${share.body.id}`)).status, 204);
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
    // Bloqué = refus explicite du proxy (403 X-Cap-Egress-Denied) ou connexion impossible.
    '(curl -s -m 5 -o /dev/null -D - http://169.254.169.254/ 2>/dev/null | grep -qi "x-cap-egress-denied" || ! curl -s -m 5 -o /dev/null http://169.254.169.254/ 2>/dev/null) && echo meta:blocked || echo meta:open',
    '(curl -s -m 5 -o /dev/null -D - http://postgres:5432/ 2>/dev/null | grep -qi "x-cap-egress-denied" || ! curl -s -m 5 -o /dev/null http://postgres:5432/ 2>/dev/null) && echo pg:blocked || echo pg:open',
  ].join('; ');
  const sent = await ctx.dev.post(`/workspaces/${ctx.ws.id}/messages`, { text: `Teste le réseau. [[tool:bash ${JSON.stringify({ command: cmd })}]]` });
  const events = await ctx.dev.events(ctx.ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 300_000);
  const out = events.find((e) => e.type === 'tool.completed').data.output;
  assert.match(out, /token:cap_rt_/, out);
  assert.match(out, /issuer:.*Shipcove/i, `certificat de l’autorité des forges :\n${out}`);
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

  // Un client qui coupe brutalement un tunnel (RST) ne fait jamais tomber la passerelle.
  const restarts = () => Number(docker('inspect', 'cap-gateway-1', '--format', '{{.RestartCount}}'));
  const before = restarts();
  const rst = (host) => `node -e 'const s=require("net").connect(3128,"gateway",()=>{s.write("CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}:443\\r\\n\\r\\n");s.resetAndDestroy();});s.on("error",()=>{})'`;
  const conv3 = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
  const reset = await ctx.dev.post(`/workspaces/${ctx.ws.id}/messages`, { text: `RST [[tool:bash ${JSON.stringify({ command: `for i in 1 2 3 4 5 6 7 8 9 10; do ${rst('registry.gitlab.com')}; ${rst('example.com')}; done; sleep 2; echo rst-ok` })}]]` });
  const ev3 = await ctx.dev.events(ctx.ws.id, conv3.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === reset.body.runId, 300_000);
  assert.equal(ev3.at(-1).type, 'run.completed', JSON.stringify(ev3.at(-1)));
  await sleep(2000);
  assert.equal(restarts(), before, 'la passerelle n’a pas redémarré');
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

test('previews : 3 ports par défaut, le 4e refusé ; jeton requis sur l’origine distincte', async (t) => {
  // Réglage de l'instance conservé : previews activées le temps du test seulement.
  const before = (await ctx.admin.get('/admin/settings')).body.previews;
  await ctx.admin.req('PATCH', '/admin/settings', { section: 'previews', values: { ...before, enabled: true, maxPortsPerWorkspace: 3 } });
  t.after(() => ctx.admin.req('PATCH', '/admin/settings', { section: 'previews', values: before }));
  await new Promise((r) => setTimeout(r, 1500));
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
  // Avec ce seul cookie (cas d'un navigateur neuf), la page servie par la sandbox est relayée.
  const conv = await ctx.dev.get(`/workspaces/${ctx.ws.id}/conversation`);
  const start = 'mkdir -p /tmp/pv && echo "<h1>preview ok</h1>" > /tmp/pv/index.html && (cd /tmp/pv && nohup python3 -m http.server 3001 > /tmp/pv.log 2>&1 &) && for i in $(seq 20); do curl -sf -o /dev/null http://127.0.0.1:3001/ && break; sleep 0.3; done';
  const sent = await ctx.dev.post(`/workspaces/${ctx.ws.id}/messages`, { text: `Serveur. [[tool:bash ${JSON.stringify({ command: start })}]]` });
  await ctx.dev.events(ctx.ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 300_000);
  const page = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: 8090, path: '/', headers: { Host: u.host, Cookie: res.headers['set-cookie'][0].split(';')[0] } }, (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => resolve({ status: r.statusCode, body }));
      })
      .on('error', reject);
  });
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /preview ok/);
});
