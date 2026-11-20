// Parcours fonctionnels complémentaires (SPEC §25) sur la pile Compose réelle :
// édition manuelle et conflits (n°9), skills/MCP (n°13), pièces jointes, notifications, rétention (n°15).
// Prérequis : pile démarrée, modèle par défaut créé (stack.test.mjs).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { BASE, Client, adminClient, uid } from './client.mjs';

const STATE_FILE = new URL('./.e2e-state.json', import.meta.url);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const ctx = {};

/** Utilisateur connecté. */
async function newUser() {
  const username = `f${uid()}`;
  const password = 'Feature-Password-123456';
  const r = await ctx.admin.post('/admin/users', { email: `${username}@example.test`, username, displayName: `F ${username}`, platformRole: 'user', password });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = new Client();
  const login = await c.post('/auth/login', { login: username, password });
  assert.equal(login.body.status, 'authenticated');
  c.id = r.body.id;
  c.email = `${username}@example.test`;
  return c;
}

/** Envoie un message et attend la fin du run. */
async function run(client, wsId, text) {
  const conv = await client.get(`/workspaces/${wsId}/conversation`);
  const sent = await client.post(`/workspaces/${wsId}/messages`, { text }, { 'Idempotency-Key': `f-${uid()}` });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const events = await client.events(wsId, conv.body.lastEventId, (e) => ['run.completed', 'run.failed', 'run.interrupted'].includes(e.type) && e.runId === sent.body.runId, 420_000);
  const end = events.at(-1);
  assert.equal(end.type, 'run.completed', JSON.stringify(end));
  return sent.body.runId;
}

const opened = [];
async function workspace(client, name) {
  const w = await client.post('/workspaces', { name });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  opened.push({ client, id: w.body.id });
  return w.body;
}

/**
 * Dépôt de test sans forge : ligne du catalogue créée directement en base et rattachée à une
 * conversation déjà « initialisée » (pas de clonage). Suffit pour l'environnement par dépôt
 * (variables, secrets, script de préparation, image), qui ne dépend pas du contenu Git.
 */
function fakeRepository(label) {
  const name = `e2e/${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${uid().toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  return sql(
    `insert into repositories (provider, host, full_name, clone_url, web_url, default_branch) values ('gitlab_self_managed', 'forge.e2e.test', '${name}', 'https://forge.e2e.test/${name}.git', 'https://forge.e2e.test/${name}', 'main') returning id`,
  ).split('\n')[0];
}
async function repoWorkspace(client, name, repositoryId) {
  const ws = await workspace(client, name);
  sql(`update workspaces set repository_id = '${repositoryId}', initialized = true where id = '${ws.id}'`);
  return (await client.get(`/workspaces/${ws.id}`)).body;
}

// Libère les sandboxes entre scénarios (limite par défaut : 3 sandboxes actives par utilisateur).
afterEach(async () => {
  while (opened.length) {
    const { client, id } = opened.pop();
    await client.post(`/workspaces/${id}/stop`).catch(() => undefined);
  }
});

const setEditing = (enabled) => ctx.admin.req('PATCH', '/admin/settings', { section: 'editor', values: { manualEditingEnabled: enabled } });

before(async () => {
  ctx.admin = await adminClient(state);
  writeFileSync(STATE_FILE, JSON.stringify(state));
  ctx.dev = await newUser();
});

after(async () => {
  await setEditing(false);
});

test('édition manuelle : désactivée par défaut, If-Match obligatoire, conflit avec Pi détecté, checkpoint', async () => {
  const ws = await workspace(ctx.dev, 'Édition');
  ctx.editWs = ws;
  await run(ctx.dev, ws.id, 'Écris. [[tool:bash {"command":"printf \'v1\\n\' > notes.txt"}]]');
  const path = 'notes.txt';
  const read = async () => ctx.dev.get(`/workspaces/${ws.id}/files/content?path=${encodeURIComponent(path)}`);
  const v1 = await read();
  assert.equal(v1.body.content, 'v1\n');

  // Désactivée par défaut côté serveur (l'interface n'est jamais la barrière).
  await setEditing(false);
  let r = await ctx.dev.put(`/workspaces/${ws.id}/files`, { path, content: 'manuel\n' }, { 'If-Match': `"${v1.body.etag}"` });
  assert.equal(r.status, 403, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'editing_disabled');

  assert.equal((await setEditing(true)).status, 200);
  // Sans précondition : refus (aucun écrasement silencieux).
  r = await ctx.dev.put(`/workspaces/${ws.id}/files`, { path, content: 'manuel\n' });
  assert.equal(r.status, 428, JSON.stringify(r.body));

  // Édition valide → nouvel etag, contenu relu depuis le checkpoint.
  r = await ctx.dev.put(`/workspaces/${ws.id}/files`, { path, content: 'manuel\n' }, { 'If-Match': `"${v1.body.etag}"` });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const manualEtag = r.body.etag;
  const v2 = await read();
  assert.equal(v2.body.content, 'manuel\n');
  assert.equal(v2.body.etag, manualEtag);

  // Pi modifie ensuite le fichier : une sauvegarde fondée sur l'ancienne version est refusée.
  await run(ctx.dev, ws.id, 'Modifie. [[tool:bash {"command":"printf \'pi\\n\' > notes.txt"}]]');
  r = await ctx.dev.put(`/workspaces/${ws.id}/files`, { path, content: 'écrasement\n' }, { 'If-Match': `"${manualEtag}"` });
  assert.equal(r.status, 412, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'edit_conflict');
  assert.equal((await read()).body.content, 'pi\n', 'la version de Pi est conservée');

  // Création : If-None-Match: * ; refusée si le fichier existe déjà.
  r = await ctx.dev.put(`/workspaces/${ws.id}/files`, { path: 'nouveau.md', content: '# Nouveau\n' }, { 'If-None-Match': '*' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await ctx.dev.put(`/workspaces/${ws.id}/files`, { path: 'nouveau.md', content: 'autre\n' }, { 'If-None-Match': '*' });
  assert.equal(r.status, 412, JSON.stringify(r.body));

  // Chemins hors du workspace refusés.
  for (const bad of ['../etc/passwd', '/etc/passwd', 'a/../../x', '.git/config', '.git', 'lib/.git/HEAD', '.cap/x', 'a\\b', 'dir/']) {
    r = await ctx.dev.put(`/workspaces/${ws.id}/files`, { path: bad, content: 'x' }, { 'If-None-Match': '*' });
    assert.equal(r.status, 400, `${bad} → ${r.status} ${JSON.stringify(r.body)}`);
  }

  // Un autre membre de l'équipe ne peut ni lire ni écrire ce workspace privé.
  const other = await newUser();
  assert.ok([403, 404].includes((await other.get(`/workspaces/${ws.id}/files/content?path=${path}`)).status));
  r = await other.put(`/workspaces/${ws.id}/files`, { path, content: 'intrus\n' }, { 'If-None-Match': '*' });
  assert.ok([403, 404].includes(r.status), JSON.stringify(r.body));

  // Pendant un run, l'édition est refusée.
  const conv = await ctx.dev.get(`/workspaces/${ws.id}/conversation`);
  const long = await ctx.dev.post(`/workspaces/${ws.id}/messages`, { text: 'Attends. [[sleep:8000]]' }, { 'Idempotency-Key': `f-${uid()}` });
  await ctx.dev.events(ws.id, conv.body.lastEventId, (e) => e.type === 'run.started' && e.runId === long.body.runId, 240_000);
  const cur = await read();
  r = await ctx.dev.put(`/workspaces/${ws.id}/files`, { path, content: 'pendant\n' }, { 'If-Match': `"${cur.body.etag}"` });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.error.code, 'workspace_busy');
  await ctx.dev.events(ws.id, conv.body.lastEventId, (e) => e.type === 'run.completed' && e.runId === long.body.runId, 240_000);
});

/** Exécute une commande via Pi et renvoie la sortie de l'outil. */
async function bashViaPi(client, wsId, command) {
  const conv = await client.get(`/workspaces/${wsId}/conversation`);
  const sent = await client.post(`/workspaces/${wsId}/messages`, { text: `Exécute. [[tool:bash ${JSON.stringify({ command })}]]` }, { 'Idempotency-Key': `f-${uid()}` });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const events = await client.events(wsId, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 420_000);
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  return events.filter((e) => e.type === 'tool.completed').map((e) => e.data.output).join('\n');
}

const skillFiles = (name) => [{ path: 'SKILL.md', content: `---\nname: ${name}\ndescription: Skill de test ${name}\n---\n\nUtilise des tests.\n` }];

test('skills : disponibles dès la création, chaque utilisateur active et réactive (même un skill global désactivé par défaut), suppression, validation', async () => {
  const ws = await workspace(ctx.dev, 'Skills');
  const id = uid().toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = { global: `glob-${id}`, global2: `glob2-${id}`, personal: `perso-${id}`, otherUser: `voisin-${id}` };
  const mine = async (n) => (await ctx.dev.get('/skills')).body.find((s) => s.name === n);

  // Global et personnel : disponibles tout de suite, sans étape de publication. Un skill global est
  // un skill personnel de l'administrateur rendu global (méthode unique : PUT /skills/:id/scope).
  const makeGlobal = async (name) => {
    const r = await ctx.admin.post('/skills', { name, files: skillFiles(name) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'published');
    assert.equal((await ctx.admin.put(`/skills/${r.body.id}/scope`, { scope: 'global' })).status, 200);
    return r;
  };
  const g = await makeGlobal(names.global);
  const g2 = await makeGlobal(names.global2);
  const p = await ctx.dev.post('/skills', { name: names.personal, files: skillFiles(names.personal) });
  assert.equal(p.body.status, 'published', JSON.stringify(p.body));
  const neighbour = await newUser();
  assert.equal((await neighbour.post('/skills', { name: names.otherUser, files: skillFiles(names.otherUser) })).status, 201);
  // Le voisin ne voit ni ne pilote le skill personnel de dev.
  assert.equal((await neighbour.get(`/skills/${p.body.id}`)).status, 404);
  assert.equal((await neighbour.put(`/skills/${p.body.id}/installation`, { scope: 'personal', enabled: false })).status, 404);

  const ls = () => bashViaPi(ctx.dev, ws.id, 'ls -1 /home/agent/.pi/agent/skills');
  let out = await ls();
  for (const n of [names.global, names.global2, names.personal]) assert.ok(out.includes(n), `${n} présent :\n${out}`);
  assert.ok(!out.includes(names.otherUser), `${names.otherUser} absent :\n${out}`);

  // Un utilisateur simple désactive puis RÉACTIVE un skill personnel et un skill global.
  for (const target of [p.body.id, g.body.id]) assert.equal((await ctx.dev.put(`/skills/${target}/installation`, { scope: 'personal', enabled: false })).status, 200);
  out = await ls();
  assert.ok(!out.includes(names.personal) && !out.includes(names.global), `désactivés encore présents :\n${out}`);
  assert.equal((await mine(names.global)).enabledForMe, false);
  for (const target of [p.body.id, g.body.id]) assert.equal((await ctx.dev.put(`/skills/${target}/installation`, { scope: 'personal', enabled: true })).status, 200);
  assert.equal((await mine(names.global)).enabledForMe, true, 'réactivation possible');
  out = await ls();
  assert.ok(out.includes(names.personal) && out.includes(names.global), `réactivés absents :\n${out}`);

  // L'administrateur désactive un skill global par défaut : chacun peut le réactiver pour soi.
  assert.equal((await ctx.dev.put(`/skills/${g2.body.id}/installation`, { scope: 'global', enabled: false })).status, 403, 'réglage par défaut réservé à l’admin');
  assert.equal((await ctx.admin.put(`/skills/${g2.body.id}/installation`, { scope: 'global', enabled: false })).status, 200);
  assert.equal((await mine(names.global2)).enabledForMe, false);
  assert.equal((await mine(names.global2)).enabledByDefault, false);
  assert.ok(!(await ls()).includes(names.global2), 'désactivé par défaut');
  assert.equal((await ctx.dev.put(`/skills/${g2.body.id}/installation`, { scope: 'personal', enabled: true })).status, 200);
  assert.equal((await mine(names.global2)).enabledForMe, true, 'le choix de l’utilisateur l’emporte');
  assert.ok((await ls()).includes(names.global2));
  assert.equal((await neighbour.get('/skills')).body.find((s) => s.id === g2.body.id).enabledForMe, false, 'les autres gardent le réglage par défaut');

  // Suppression : réservée à qui gère le skill ; effective au run suivant.
  assert.equal((await ctx.dev.del(`/skills/${g.body.id}`)).status, 403);
  // Une portée demandée à la création est ignorée (toujours personnel) ; rendre global est réservé à l'admin.
  const x = await ctx.dev.post('/skills', { name: `x-${id}`, scope: 'global', files: skillFiles(`x-${id}`) });
  assert.equal(x.status, 201);
  assert.equal((await mine(`x-${id}`)).scope, 'personal', 'création toujours personnelle');
  assert.equal((await ctx.dev.put(`/skills/${x.body.id}/scope`, { scope: 'global' })).status, 403, 'skill global réservé à l’admin');
  assert.equal((await ctx.admin.del(`/skills/${g.body.id}`)).status, 204);
  assert.equal((await ctx.dev.get(`/skills/${g.body.id}`)).status, 404);
  assert.ok(!(await ls()).includes(names.global), 'skill supprimé absent');

  // Revue imposée par l'administrateur : skill personnel en attente, inactif jusqu'à validation.
  assert.equal((await ctx.admin.req('PATCH', '/admin/settings', { section: 'skills', values: { personalSkillsRequireReview: true } })).status, 200);
  try {
    const r = await neighbour.post('/skills', { name: `revue-${id}`, files: skillFiles(`revue-${id}`) });
    assert.equal(r.body.status, 'pending_review');
    let mineR = (await neighbour.get('/skills')).body.find((s) => s.id === r.body.id);
    assert.equal(mineR.enabledForMe, false);
    assert.ok((await ctx.admin.get('/skills/review/pending')).body.some((s) => s.id === r.body.id));
    assert.equal((await neighbour.post(`/skills/${r.body.id}/approve`)).status, 403);
    assert.equal((await ctx.admin.post(`/skills/${r.body.id}/approve`)).status, 200);
    mineR = (await neighbour.get('/skills')).body.find((s) => s.id === r.body.id);
    assert.equal(mineR.status, 'published');
    assert.equal(mineR.enabledForMe, true);
  } finally {
    await ctx.admin.req('PATCH', '/admin/settings', { section: 'skills', values: { personalSkillsRequireReview: false } });
  }
});

// Serveur MCP Streamable HTTP de test : endpoint /mcp du faux LLM (réseau interne de la plateforme).
const MCP_URL = 'http://mock-llm:4010/mcp';

test('MCP : outil HTTP appelé par le worker, secret d’en-tête jamais exposé, stdio refusé, permissions globale et personnelle, cloisonnement', async () => {
  const ws = await workspace(ctx.dev, 'MCP');
  // Majuscules acceptées dans le nom.
  const name = `Echo_${uid().replace(/[^A-Za-z0-9]/g, '')}`;
  // Le transport stdio (serveur lancé dans la sandbox, secrets compris) n'existe plus.
  const stdio = await ctx.admin.post('/mcp-servers', { name, scope: 'global', transport: 'stdio', command: 'node', args: ['x.cjs'] });
  assert.equal(stdio.status, 400, JSON.stringify(stdio.body));
  const created = await ctx.admin.post('/mcp-servers', { name, description: 'écho de test', scope: 'global', transport: 'streamable_http', url: MCP_URL, secretHeaders: { 'X-Echo-Secret': 'valeur-secrete-mcp' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const srv = created.body.id;
  // Découverte automatique à l'ajout.
  assert.equal(created.body.discovery.ok, true, JSON.stringify(created.body.discovery));
  assert.deepEqual(created.body.discovery.tools.map((t) => t.name), ['echo']);
  // Le secret n'apparaît jamais dans l'API.
  const listed = await ctx.dev.get('/mcp-servers');
  assert.ok(listed.body.some((s) => s.id === srv));
  assert.ok(!JSON.stringify(listed.body).includes('valeur-secrete-mcp'));

  const tool = `mcp__${name}__echo`;
  const callEcho = async () => {
    const conv = await ctx.dev.get(`/workspaces/${ws.id}/conversation`);
    const sent = await ctx.dev.post(`/workspaces/${ws.id}/messages`, { text: `Appelle l’outil. [[tool:${tool} {"text":"bonjour"}]]` }, { 'Idempotency-Key': `f-${uid()}` });
    const events = await ctx.dev.events(ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 420_000);
    assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
    assert.ok(!JSON.stringify(events).includes('valeur-secrete-mcp'), 'secret absent du flux SSE');
    return events.find((e) => e.type === 'tool.completed');
  };
  let done = await callEcho();
  assert.equal(done.data.isError, false, JSON.stringify(done.data));
  // Le worker a présenté le secret au serveur MCP ; la sandbox ne l'a jamais vu.
  assert.match(done.data.output, /echo:bonjour:secret-ok/);

  const effective = async () => (await ctx.dev.get('/mcp-servers')).body.find((s) => s.id === srv).tools[0].effective;
  // Outil décoché (sélection personnelle) : il n'est plus proposé à Pi et l'appel est refusé.
  assert.equal((await ctx.dev.put(`/mcp-servers/${srv}/selection`, { scope: 'personal', denied: ['echo'] })).status, 200);
  done = await callEcho();
  assert.equal(done.data.isError, true, JSON.stringify(done.data));
  assert.doesNotMatch(done.data.output, /echo:bonjour/);
  assert.equal(await effective(), 'denied');
  // Recoché, puis refusé par l'administrateur : la règle globale l'emporte (outil verrouillé).
  assert.equal((await ctx.dev.put(`/mcp-servers/${srv}/selection`, { scope: 'personal', denied: [] })).status, 200);
  assert.equal(await effective(), 'allowed');
  assert.equal((await ctx.admin.put(`/mcp-servers/${srv}/selection`, { scope: 'global', denied: ['echo'] })).status, 200);
  assert.equal(await effective(), 'denied');
  assert.equal((await ctx.dev.get('/mcp-servers')).body.find((s) => s.id === srv).tools[0].lockedByAdmin, true);
  done = await callEcho();
  assert.equal(done.data.isError, true, JSON.stringify(done.data));
  // Un utilisateur ne pose pas de règle globale ; la portée « équipe » n'existe plus.
  assert.equal((await ctx.dev.put(`/mcp-servers/${srv}/permissions`, { toolName: 'echo', scope: 'global', effect: 'allow' })).status, 403);
  assert.equal((await ctx.dev.put(`/mcp-servers/${srv}/permissions`, { toolName: 'echo', scope: 'team', effect: 'allow' })).status, 400);

  // Serveur personnel d'un autre utilisateur : invisible (liste, règles, permissions). Son hôte doit
  // être autorisé par l'administration.
  const neighbour = await newUser();
  const personal = { name: `${name}_x`, scope: 'personal', transport: 'streamable_http', url: MCP_URL };
  assert.equal((await neighbour.post('/mcp-servers', personal)).status, 403);
  const mcpCfg = (await ctx.admin.get('/admin/settings')).body.mcp;
  await ctx.admin.req('PATCH', '/admin/settings', { section: 'mcp', values: { allowedRemoteHosts: [...mcpCfg.allowedRemoteHosts, 'mock-llm'] } });
  let hidden;
  try {
    hidden = await neighbour.post('/mcp-servers', personal);
  } finally {
    await ctx.admin.req('PATCH', '/admin/settings', { section: 'mcp', values: { allowedRemoteHosts: mcpCfg.allowedRemoteHosts } });
  }
  assert.equal(hidden.status, 201, JSON.stringify(hidden.body));
  assert.ok(!(await ctx.dev.get('/mcp-servers')).body.some((s) => s.id === hidden.body.id));
  assert.equal((await ctx.dev.get(`/mcp-servers/${hidden.body.id}/permissions`)).status, 404);
  assert.equal((await ctx.dev.put(`/mcp-servers/${hidden.body.id}/permissions`, { toolName: 'echo', scope: 'personal', effect: 'deny' })).status, 404);

  await ctx.admin.del(`/mcp-servers/${srv}`);
});

/** Envoi multipart (FormData) avec les cookies et le jeton CSRF du client. */
async function upload(client, wsId, files) {
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([f.data], { type: f.type }), f.name);
  const res = await fetch(`${BASE}/api/v1/workspaces/${wsId}/attachments`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': client.csrf, Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const PNG_1PX = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

/** ZIP « stored » minimal (voir aussi apps/api/.../attachment-inspection.spec.ts). */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const setAttachments = (values) => ctx.admin.req('PATCH', '/admin/settings', { section: 'attachments', values });

test('pièces jointes : type réel, exécutables et archives dangereuses refusés, taille bornée, cloisonnement, remise à Pi', async () => {
  const ws = await workspace(ctx.dev, 'Pièces jointes');
  const r = await upload(ctx.dev, ws.id, [
    { name: 'notes.txt', type: 'text/plain', data: 'contenu-de-la-piece-jointe\n' },
    { name: 'pixel.png', type: 'image/png', data: PNG_1PX },
    { name: 'outil.exe', type: 'application/octet-stream', data: Buffer.from('MZ\x90\x00binaire') },
    { name: 'fausse-image.png', type: 'image/png', data: zip([{ name: 'a.txt', data: 'a' }]) },
    { name: 'sain.zip', type: 'application/zip', data: zip([{ name: 'src/a.txt', data: 'a' }]) },
    { name: 'slip.zip', type: 'application/zip', data: zip([{ name: '../../home/agent/.bashrc', data: 'x' }]) },
    { name: 'inconnu.bin', type: 'application/octet-stream', data: Buffer.from([0, 1, 2, 3, 255, 254]) },
  ]);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.map((a) => [a.fileName, a]));
  assert.equal(by['notes.txt'].status, 'ready');
  assert.equal(by['notes.txt'].kind, 'text');
  assert.equal(by['pixel.png'].status, 'ready');
  assert.equal(by['pixel.png'].mimeType, 'image/png');
  assert.equal(by['outil.exe'].status, 'rejected');
  assert.equal(by['fausse-image.png'].status, 'rejected', 'type déclaré incohérent avec le contenu');
  assert.equal(by['sain.zip'].status, 'ready', JSON.stringify(by['sain.zip']));
  assert.equal(by['slip.zip'].status, 'rejected');
  assert.match(by['slip.zip'].rejectionReason, /Chemin dangereux/);
  assert.equal(by['inconnu.bin'].status, 'rejected');

  // Bombe gzip : 10 Mo de zéros compressés en quelques Ko, limite abaissée à 5 Mo.
  assert.equal((await setAttachments({ maxArchiveExpandedMb: 5 })).status, 200);
  try {
    const { gzipSync } = await import('node:zlib');
    const bomb = await upload(ctx.dev, ws.id, [{ name: 'bombe.gz', type: 'application/gzip', data: gzipSync(Buffer.alloc(10 * 1024 * 1024)) }]);
    assert.equal(bomb.body[0].status, 'rejected', JSON.stringify(bomb.body));
    assert.match(bomb.body[0].rejectionReason, /décompressée/);
    // Envoi trop volumineux refusé avant lecture en mémoire.
    await setAttachments({ maxFileMb: 1, maxFilesPerMessage: 1 });
    const big = await upload(ctx.dev, ws.id, [{ name: 'gros.txt', type: 'text/plain', data: 'x'.repeat(3 * 1024 * 1024) }]);
    assert.equal(big.status, 413, JSON.stringify(big.body));
  } finally {
    await setAttachments({ maxArchiveExpandedMb: 200, maxFileMb: 20, maxFilesPerMessage: 10 });
  }

  // Téléchargement : propriétaire uniquement, jamais interprété par le navigateur.
  const dl = await fetch(`${BASE}/api/v1/workspaces/${ws.id}/attachments/${by['notes.txt'].id}`, { headers: { Cookie: [...ctx.dev.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(dl.headers.get('x-frame-options'), 'DENY', 'un seul X-Frame-Options');
  assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  const other = await newUser();
  assert.ok([403, 404].includes((await other.get(`/workspaces/${ws.id}/attachments/${by['notes.txt'].id}`)).status));
  assert.ok([403, 404].includes((await upload(other, ws.id, [{ name: 'x.txt', type: 'text/plain', data: 'x' }])).status));

  // Pièce jointe remise à Pi dans la sandbox, puis non réutilisable.
  const conv = await ctx.dev.get(`/workspaces/${ws.id}/conversation`);
  const sent = await ctx.dev.post(
    `/workspaces/${ws.id}/messages`,
    { text: `Lis la pièce jointe. [[tool:bash {"command":"cat /workspace/.cap/attachments/${by['notes.txt'].id}/notes.txt"}]]`, attachmentIds: [by['notes.txt'].id] },
    { 'Idempotency-Key': `f-${uid()}` },
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const events = await ctx.dev.events(ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 420_000);
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  assert.match(events.find((e) => e.type === 'tool.completed')?.data.output ?? JSON.stringify(events.map((e) => e.type)), /contenu-de-la-piece-jointe/);
  const reuse = await ctx.dev.post(`/workspaces/${ws.id}/messages`, { text: 'encore', attachmentIds: [by['notes.txt'].id] }, { 'Idempotency-Key': `f-${uid()}` });
  assert.equal(reuse.status, 422, JSON.stringify(reuse.body));
  // Une pièce jointe refusée ne peut pas être envoyée.
  const rejected = await ctx.dev.post(`/workspaces/${ws.id}/messages`, { text: 'exe', attachmentIds: [by['outil.exe'].id] }, { 'Idempotency-Key': `f-${uid()}` });
  assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
  ctx.attachWs = ws;
  ctx.attachmentId = by['pixel.png'].id;
});

const MAILPIT = process.env.CAP_MAILPIT_URL ?? 'http://127.0.0.1:8025';
async function mails(to) {
  const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
  return (await r.json()).messages ?? [];
}
async function waitFor(fn, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

test('notifications : in-app et email (Mailpit) selon les préférences', async () => {
  const user = await newUser();
  const ws = await workspace(user, 'Notifications');
  // run.completed : in-app seul par défaut ; on active l'email.
  assert.equal((await user.put('/notifications/preferences', { type: 'run.completed', inApp: true, email: true })).status, 204);
  await run(user, ws.id, 'Bonjour');
  const inApp = await waitFor(async () => (await user.get('/notifications')).body.items.find((n) => n.type === 'run.completed'));
  assert.ok(inApp, 'notification in-app');
  assert.equal(inApp.link, `/workspaces/${ws.id}`);
  const mail = await waitFor(async () => (await mails(user.email)).find((m) => /Tâche terminée/.test(m.Subject)));
  assert.ok(mail, `email reçu par ${user.email}`);
  // Le contenu de la conversation n'est pas recopié dans l'email.
  const full = await (await fetch(`${MAILPIT}/api/v1/message/${mail.ID}`)).json();
  assert.doesNotMatch(full.Text ?? '', /Réponse factice/);

  // Email désactivé : plus aucun envoi, l'in-app reste.
  await user.put('/notifications/preferences', { type: 'run.completed', inApp: true, email: false });
  const before = (await mails(user.email)).length;
  await run(user, ws.id, 'Deuxième');
  await waitFor(async () => (await user.get('/notifications')).body.items.filter((n) => n.type === 'run.completed').length >= 2);
  await new Promise((r) => setTimeout(r, 5000));
  assert.equal((await mails(user.email)).length, before, 'aucun nouvel email');
  // Marquage comme lu.
  assert.equal((await user.post('/notifications/read', {})).status, 204);
  assert.equal((await user.get('/notifications?unread=true')).body.unreadCount, 0);
  ctx.notifUser = user;
});

/** Requête SQL directe (vieillissement artificiel des données pour tester la rétention). */
function sql(query) {
  return execFileSync('docker', ['exec', '-i', 'cap-postgres-1', 'psql', '-U', 'cap', '-d', 'cap', '-tAc', query], { encoding: 'utf8' }).trim();
}

test('rétention : purge déclenchée par l’administrateur, gel légal respecté, reprise de conversation préservée', async () => {
  const user = ctx.notifUser;
  const ws = ctx.attachWs;
  // Données « anciennes » : notifications de l'utilisateur, pièce jointe, événements d'audit.
  sql(`update notifications set created_at = now() - interval '3 days' where user_id = '${user.id}'`);
  sql(`update attachments set created_at = now() - interval '3 days' where id = '${ctx.attachmentId}'`);
  const marker = `retention-test-${uid()}`;
  sql(`insert into audit_events (action, outcome, occurred_at) values ('${marker}', 'success', now() - interval '3 days')`);
  const policies = [
    { dataType: 'notifications', retentionDays: 1, legalHold: false },
    { dataType: 'attachments', retentionDays: 1, legalHold: false },
    { dataType: 'audit', retentionDays: 1, legalHold: true },
    { dataType: 'checkpoints', retentionDays: 1, legalHold: false },
  ];
  // Un non-administrateur ne fixe pas les durées.
  assert.equal((await ctx.dev.put('/admin/retention', policies[0])).status, 403);
  try {
    for (const p of policies) assert.equal((await ctx.admin.put('/admin/retention', p)).status, 200);
    const startedAt = new Date().toISOString();
    assert.equal((await ctx.admin.post('/admin/retention/run')).status, 202);
    const jobs = await waitFor(async () => {
      const list = (await ctx.admin.get('/admin/deletion-jobs')).body.filter((j) => j.kind === 'retention_purge' && j.createdAt >= startedAt);
      const types = new Set(list.filter((j) => j.status !== 'running').map((j) => j.dataType));
      return ['notifications', 'attachments', 'audit', 'checkpoints'].every((t) => types.has(t)) ? list : null;
    }, 120_000);
    assert.ok(jobs, 'purge exécutée');
    assert.equal(jobs.find((j) => j.dataType === 'audit').status, 'blocked', 'gel légal');
    assert.equal(sql(`select count(*) from audit_events where action = '${marker}'`), '1', 'audit gelé conservé');
    assert.equal(jobs.find((j) => j.dataType === 'notifications').status, 'succeeded');
    assert.equal((await user.get('/notifications')).body.items.length, 0, 'notifications anciennes purgées');
    assert.equal((await ctx.dev.get(`/workspaces/${ws.id}/attachments/${ctx.attachmentId}`)).status, 404, 'pièce jointe purgée');
    // La génération courante (fichiers + session Pi) est conservée : la conversation reprend.
    await run(ctx.dev, ws.id, 'Toujours là ? [[tool:bash {"command":"ls /workspace"}]]');
  } finally {
    for (const p of policies) await ctx.admin.put('/admin/retention', { dataType: p.dataType, retentionDays: null, legalHold: false });
    sql(`delete from audit_events where action = '${marker}'`);
  }
});

test('limite de sandboxes actives par utilisateur : le run échoue avec un message explicite', async () => {
  const user = await newUser();
  const ws = [];
  for (let i = 0; i < 4; i++) ws.push(await workspace(user, `Limite ${i}`));
  for (let i = 0; i < 3; i++) await run(user, ws[i].id, `Run ${i}`);
  const conv = await user.get(`/workspaces/${ws[3].id}/conversation`);
  const sent = await user.post(`/workspaces/${ws[3].id}/messages`, { text: 'Quatrième' }, { 'Idempotency-Key': `f-${uid()}` });
  const events = await user.events(ws[3].id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 240_000);
  const end = events.at(-1);
  assert.equal(end.type, 'run.failed');
  assert.match(end.data.error, /Limite de 3 sandbox/, end.data.error);
});

test('appels LLM concurrents : plafond jamais dépassé, une seule facturation par appel, aucune réservation orpheline', async () => {
  const user = await newUser();
  const ws = [];
  for (let i = 0; i < 3; i++) ws.push(await workspace(user, `Concurrence ${i}`));
  // Plafond faible : une partie des appels sera refusée faute de crédits réservables.
  // Une réservation ≈ 11 crédits (coût maximal estimé), un appel réel ≈ 1 : deux réservations simultanées dépassent 20.
  const limit = 20;
  assert.equal((await ctx.admin.put('/admin/quotas/policies', { scope: 'user', subjectId: user.id, limit5h: String(limit), limit7d: null, exempt: false })).status, 200);
  try {
    const steps = [1, 2, 3, 4, 5].map((i) => `[[tool:bash {"command":"echo ${i}"}]]`).join(' ');
    const starts = await Promise.all(ws.map(async (w) => {
      const conv = await user.get(`/workspaces/${w.id}/conversation`);
      const sent = await user.post(`/workspaces/${w.id}/messages`, { text: `Concurrence. ${steps}` }, { 'Idempotency-Key': `f-${uid()}` });
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
      return { w, runId: sent.body.runId, from: conv.body.lastEventId };
    }));
    // Chaque run se termine ou est suspendu faute de quota.
    await Promise.all(starts.map(({ w, runId, from }) => user.events(w.id, from, (e) => e.runId === runId && ['run.completed', 'run.failed', 'quota.paused'].includes(e.type), 420_000)));
    for (const { w, runId } of starts) await user.post(`/workspaces/${w.id}/runs/${runId}/interrupt`).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 3000));

    const q = (s) => sql(s);
    const used = Number(q(`select coalesce(sum(amount), 0) from credit_ledger where user_id = '${user.id}' and kind = 'usage'`));
    const settled = Number(q(`select count(*) from llm_requests where user_id = '${user.id}' and status = 'settled'`));
    const rejected = Number(q(`select count(*) from llm_requests where user_id = '${user.id}' and status = 'rejected'`));
    assert.ok(settled > 0, 'des appels ont abouti');
    assert.ok(rejected > 0, 'le plafond a bien limité des appels concurrents');
    assert.ok(used <= limit, `consommation ${used} ≤ plafond ${limit}`);
    // Exactement une écriture de facturation par appel abouti, aucune pour un appel refusé.
    assert.equal(q(`select count(*) from credit_ledger l join llm_requests r on r.id = l.llm_request_id where r.user_id = '${user.id}' and l.kind = 'usage'`), String(settled));
    assert.equal(q(`select count(*) from (select llm_request_id from credit_ledger where user_id = '${user.id}' and kind = 'usage' group by 1 having count(*) > 1) d`), '0');
    assert.equal(q(`select count(*) from credit_ledger l join llm_requests r on r.id = l.llm_request_id where r.user_id = '${user.id}' and r.status = 'rejected'`), '0');
    // Montant facturé = somme des coûts des appels aboutis ; plus aucune réservation ouverte.
    assert.equal(Number(q(`select coalesce(sum(credits), 0) from llm_requests where user_id = '${user.id}' and status = 'settled'`)), used);
    assert.equal(q(`select count(*) from credit_reservations where user_id = '${user.id}' and status = 'open'`), '0');
  } finally {
    await ctx.admin.put('/admin/quotas/policies', { scope: 'user', subjectId: user.id, limit5h: null, limit7d: null, exempt: true });
  }
});

test('quota strictement personnel : un compteur par personne, partagé par toutes ses conversations (avec ou sans dépôt), aucun plafond collectif', async () => {
  const user = await newUser();
  const other = await newUser();
  const a = { ws: await workspace(user, 'Quota A') };
  const b = { ws: await repoWorkspace(user, 'Quota B', fakeRepository('quota')) };
  assert.ok(b.ws.repository, 'conversation rattachée au dépôt de test');

  // Aucun plafond d'équipe : refusé par l'API.
  assert.equal((await ctx.admin.put('/admin/quotas/policies', { scope: 'team', subjectId: other.id, limit5h: '1', limit7d: null, exempt: false })).status, 400);
  assert.ok(!('teams' in (await user.get('/usage')).body), 'aucun quota d’équipe exposé');

  // Quota personnel épuisé : suspendu dans ses deux conversations (un seul compteur personnel)…
  assert.equal((await ctx.admin.put('/admin/quotas/policies', { scope: 'user', subjectId: user.id, limit5h: '0.001', limit7d: null, exempt: false })).status, 200);
  try {
    for (const target of [a, b]) {
      const conv = await user.get(`/workspaces/${target.ws.id}/conversation`);
      const sent = await user.post(`/workspaces/${target.ws.id}/messages`, { text: 'Bonjour' }, { 'Idempotency-Key': `f-${uid()}` });
      if (sent.status === 201) {
        const ev = await user.events(target.ws.id, conv.body.lastEventId, (e) => e.runId === sent.body.runId && ['quota.paused', 'run.completed', 'run.failed'].includes(e.type), 300_000);
        assert.equal(ev.at(-1).type, 'quota.paused', JSON.stringify(ev.at(-1)));
        assert.equal(ev.at(-1).data.window, '5h');
        await user.post(`/workspaces/${target.ws.id}/runs/${sent.body.runId}/interrupt`);
      } else {
        assert.equal(sent.body.error.code, 'quota_exceeded', JSON.stringify(sent.body));
      }
    }
    // … sans toucher aux autres utilisateurs, même sur le même dépôt : leur quota est le leur.
    const w = await repoWorkspace(other, 'Même dépôt', b.ws.repository.id);
    await run(other, w.id, 'Même dépôt, autre utilisateur');
  } finally {
    await ctx.admin.put('/admin/quotas/policies', { scope: 'user', subjectId: user.id, limit5h: null, limit7d: null, exempt: false });
  }
});

test('retour en arrière : fichiers d’avant un run restaurés, exclusions intactes, Pi informé, annulable', async () => {
  const user = await newUser();
  const ws = await workspace(user, 'Retour en arrière');
  assert.equal((await ctx.admin.req('PATCH', '/admin/settings', { section: 'sandbox', values: { checkpointExcludes: ['node_modules'] } })).status, 200);
  try {
    const read = async (p) => (await user.get(`/workspaces/${ws.id}/files/content?path=${p}`));
    await run(user, ws.id, `Init. [[tool:bash {"command":"printf 'v1\\\\n' > a.txt && printf 'garde\\\\n' > b.txt"}]]`);
    const run2 = await run(user, ws.id, `Change. [[tool:bash {"command":"printf 'v2\\\\n' > a.txt && rm b.txt && printf 'neuf\\\\n' > c.txt && mkdir -p node_modules/dep && echo exclu > node_modules/dep/x"}]]`);
    assert.equal((await read('a.txt')).body.content, 'v2\n');

    // Un autre utilisateur ne peut pas revenir en arrière dans ce workspace.
    const other = await newUser();
    assert.ok([403, 404].includes((await other.post(`/workspaces/${ws.id}/rewind`, { runId: run2 })).status));

    const conv = await user.get(`/workspaces/${ws.id}/conversation`);
    const r = await user.post(`/workspaces/${ws.id}/rewind`, { runId: run2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await read('a.txt')).body.content, 'v1\n');
    assert.equal((await read('b.txt')).body.content, 'garde\n');
    assert.equal((await read('c.txt')).status, 404);
    // Message système dans la conversation, diffusé en temps réel.
    const ev = await user.events(ws.id, conv.body.lastEventId, (e) => e.type === 'message.created' && e.data.role === 'system', 30_000);
    assert.equal(ev.at(-1).data.meta.kind, 'rewind');
    assert.match(ev.at(-1).data.text, /Fichiers restaurés à l’état d’avant « Change/);

    // Pi est informé au run suivant (le modèle factice répète le texte reçu, sans directive).
    const conv2 = await user.get(`/workspaces/${ws.id}/conversation`);
    const hello = await user.post(`/workspaces/${ws.id}/messages`, { text: 'Où en est-on ?' }, { 'Idempotency-Key': `f-${uid()}` });
    const evs = await user.events(ws.id, conv2.body.lastEventId, (e) => e.type === 'run.completed' && e.runId === hello.body.runId, 300_000);
    assert.ok(evs.some((e) => e.type === 'message.completed' && /Note de la plateforme/.test(e.data.text)), 'note de la plateforme transmise à Pi');
    // Les chemins exclus des checkpoints n'ont pas été touchés.
    const conv3b = await user.get(`/workspaces/${ws.id}/conversation`);
    const sent = await user.post(`/workspaces/${ws.id}/messages`, { text: 'Vérifie. [[tool:bash {"command":"cat node_modules/dep/x; ls"}]]' }, { 'Idempotency-Key': `f-${uid()}` });
    const evs2 = await user.events(ws.id, conv3b.body.lastEventId, (e) => e.type === 'run.completed' && e.runId === sent.body.runId, 300_000);
    const out = evs2.find((e) => e.type === 'tool.completed').data.output;
    assert.match(out, /exclu/, 'chemin exclu conservé');
    assert.doesNotMatch(out, /c\.txt/);
    // La note n'est donnée qu'une fois.
    assert.ok(!evs2.some((e) => e.type === 'message.completed' && /Note de la plateforme/.test(e.data.text)));

    // Annulation du retour en arrière.
    const undo = await user.post(`/workspaces/${ws.id}/rewind`, { generation: r.body.fromGeneration });
    assert.equal(undo.status, 200, JSON.stringify(undo.body));
    assert.equal((await read('a.txt')).body.content, 'v2\n');
    assert.equal((await read('c.txt')).body.content, 'neuf\n');
    assert.equal((await read('b.txt')).status, 404);

    // Refusé pendant un run.
    const conv3 = await user.get(`/workspaces/${ws.id}/conversation`);
    const long = await user.post(`/workspaces/${ws.id}/messages`, { text: 'Attends. [[sleep:8000]]' }, { 'Idempotency-Key': `f-${uid()}` });
    await user.events(ws.id, conv3.body.lastEventId, (e) => e.type === 'run.started' && e.runId === long.body.runId, 240_000);
    const busy = await user.post(`/workspaces/${ws.id}/rewind`, { runId: run2 });
    assert.equal(busy.status, 409, JSON.stringify(busy.body));
    await user.events(ws.id, conv3.body.lastEventId, (e) => e.type === 'run.completed' && e.runId === long.body.runId, 240_000);
  } finally {
    await ctx.admin.req('PATCH', '/admin/settings', { section: 'sandbox', values: { checkpointExcludes: [] } });
  }
});

test('script de démarrage des sandboxes : réglage global (administrateur), une fois par sandbox, avec ou sans dépôt, rejoué si modifié, échec signalé', async () => {
  const dev = await newUser();
  const setScript = (startupScript) => ctx.admin.req('PATCH', '/admin/settings', { section: 'sandbox', values: { startupScript } });
  // Réglage réservé à l'administrateur.
  assert.equal((await dev.req('PATCH', '/admin/settings', { section: 'sandbox', values: { startupScript: 'id' } })).status, 403);
  const script = 'echo "démarrage $HOME"\nmkdir -p .deps && date +%s%N > .deps/stamp\necho present > /home/agent/outil-global';
  assert.equal((await setScript(script)).status, 200);
  try {
    const wsId = (await workspace(dev, 'Démarrage')).id;
    const runCollect = async (text) => {
      const conv = await dev.get(`/workspaces/${wsId}/conversation`);
      const sent = await dev.post(`/workspaces/${wsId}/messages`, { text }, { 'Idempotency-Key': `f-${uid()}` });
      const evs = await dev.events(wsId, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 600_000);
      assert.equal(evs.at(-1).type, 'run.completed', JSON.stringify(evs.at(-1)));
      return evs;
    };
    const setupMessages = (evs) => evs.filter((e) => e.type === 'message.created' && e.data.role === 'system' && e.data.meta?.kind === 'setup');

    // 1er run (conversation sans dépôt) : script exécuté, sortie visible, résultat conservé.
    let evs = await runCollect('Premier [[tool:bash {"command":"cat /home/agent/outil-global; ls .deps"}]]');
    let setup = setupMessages(evs);
    assert.equal(setup.length, 2, 'début + fin du script');
    assert.equal(setup[1].data.meta.status, 'succeeded', JSON.stringify(setup[1].data));
    assert.match(setup[1].data.meta.output, /démarrage \/home\/agent/);
    assert.match(evs.find((e) => e.type === 'tool.completed').data.output, /present[\s\S]*stamp/);
    const stamp1 = (await dev.get(`/workspaces/${wsId}/files/content?path=.deps/stamp`)).body.content;
    assert.ok(stamp1, 'résultat du script conservé par le checkpoint');

    // 2e run, même sandbox : pas de nouvelle exécution.
    evs = await runCollect('Deuxième');
    assert.equal(setupMessages(evs).length, 0);

    // Nouvelle sandbox : script rejoué (les outils hors /workspace sont recréés).
    await dev.post(`/workspaces/${wsId}/stop`);
    await new Promise((r) => setTimeout(r, 3000));
    evs = await runCollect('Troisième [[tool:bash {"command":"cat /home/agent/outil-global"}]]');
    assert.equal(setupMessages(evs).length, 2, 'script rejoué dans la nouvelle sandbox');
    assert.match(evs.find((e) => e.type === 'tool.completed').data.output, /present/);

    // Script modifié en échec : signalé dans la conversation et à Pi, le run continue.
    await setScript('echo "étape 1"\necho "registre injoignable" >&2\nexit 3');
    evs = await runCollect('Où en est-on ?');
    setup = setupMessages(evs);
    assert.equal(setup.at(-1).data.meta.status, 'failed');
    assert.equal(setup.at(-1).data.meta.exitCode, 3);
    assert.match(setup.at(-1).data.meta.output, /registre injoignable/);
    assert.ok(evs.some((e) => e.type === 'message.completed' && /script de démarrage de la sandbox a échoué/.test(e.data.text)), 'Pi informé de l’échec');
    await dev.post(`/workspaces/${wsId}/stop`).catch(() => undefined);
  } finally {
    // Réglage global : remis à vide pour les autres tests.
    await setScript('');
  }
  // L'ancienne administration des dépôts n'existe plus.
  assert.equal((await ctx.admin.get('/admin/repositories')).status, 404);
});

test('services lancés par l’agent : rien sans demande, démarrage à la demande sur localhost, variables, limites, isolation', async () => {
  const lead = await newUser();
  const pid = fakeRepository('services');
  // Catalogue : géré par l'administrateur seulement.
  assert.equal((await lead.get('/admin/service-catalog')).status, 403);
  const catalog = (await ctx.admin.get('/admin/service-catalog')).body;
  assert.ok(['postgres', 'redis', 'rabbitmq'].every((k) => catalog.some((c) => c.key === k && c.enabled)));

  const wsId = (await repoWorkspace(lead, 'Services', pid)).id;
  const tools = async (text) => {
    const conv = await lead.get(`/workspaces/${wsId}/conversation`);
    const sent = await lead.post(`/workspaces/${wsId}/messages`, { text }, { 'Idempotency-Key': `f-${uid()}` });
    const evs = await lead.events(wsId, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 600_000);
    assert.equal(evs.at(-1).type, 'run.completed', JSON.stringify(evs.at(-1)));
    return evs.filter((e) => e.type === 'tool.completed').map((e) => e.data);
  };
  const svc = (args) => `[[tool:platform_services ${JSON.stringify(args)}]]`;
  const sandboxId = () => sql(`select external_id from sandbox_instances where workspace_id = '${wsId}' and status = 'running'`);
  const serviceContainers = (sbx) => execFileSync('docker', ['ps', '-aq', '--filter', 'label=cap.service=true', '--filter', `label=cap.sandbox=${sbx}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

  // Rien ne démarre tant que l'agent ne le demande pas.
  let out = await tools(`Statut. ${svc({ action: 'status' })}`);
  assert.match(out[0].output, /Aucun service lancé/);
  assert.match(out[0].output, /postgres/);
  assert.equal(serviceContainers(sandboxId()).length, 0);

  // Démarrage à la demande, joignable sur localhost depuis la sandbox.
  out = await tools(`Redis. ${svc({ action: 'start', service: 'redis' })} [[tool:bash {"command":"exec 3<>/dev/tcp/127.0.0.1/6379; printf 'PING\\\\r\\\\n' >&3; head -c 7 <&3"}]]`);
  assert.equal(out[0].isError, false, out[0].output);
  assert.match(out[0].output, /prêt/);
  assert.match(out[1].output, /\+PONG/);

  // PostgreSQL avec une variable du conteneur.
  out = await tools(`Postgres. ${svc({ action: 'start', service: 'postgres', env: { POSTGRES_PASSWORD: 'Mot-De-Passe-Pg-2026' } })} ${svc({ action: 'logs', name: 'postgres', lines: 50 })} [[tool:bash {"command":"exec 3<>/dev/tcp/127.0.0.1/5432 && echo port-ouvert"}]]`);
  assert.equal(out[0].isError, false, out[0].output);
  assert.match(out[1].output, /ready to accept connections/);
  assert.match(out[2].output, /port-ouvert/);
  const pgEnv = execFileSync('docker', ['inspect', '-f', '{{json .Config.Env}}', `cap-svc-${sandboxId().slice(0, 12)}-postgres`], { encoding: 'utf8' });
  assert.match(pgEnv, /POSTGRES_PASSWORD=Mot-De-Passe-Pg-2026/, 'variable transmise au conteneur');

  // Limite par sandbox, service inconnu ou désactivé.
  await ctx.admin.req('PATCH', '/admin/settings', { section: 'sandbox', values: { maxServicesPerWorkspace: 2 } });
  const redis = catalog.find((c) => c.key === 'redis');
  const { id: _id, ...redisBody } = redis;
  await ctx.admin.put(`/admin/service-catalog/${redis.id}`, { ...redisBody, enabled: false });
  try {
    out = await tools(`Encore. ${svc({ action: 'start', service: 'rabbitmq' })} ${svc({ action: 'start', service: 'mongodb' })} ${svc({ action: 'start', service: 'redis', name: 'redis-2' })}`);
    assert.equal(out[0].isError, true);
    assert.match(out[0].output, /Limite de 2 services/);
    assert.equal(out[1].isError, true);
    assert.match(out[1].output, /non disponible/);
    assert.equal(out[2].isError, true, 'service désactivé par l’administrateur');
  } finally {
    await ctx.admin.req('PATCH', '/admin/settings', { section: 'sandbox', values: { maxServicesPerWorkspace: 4 } });
    await ctx.admin.put(`/admin/service-catalog/${redis.id}`, { ...redisBody, enabled: true });
  }

  // Isolation : la sandbox d'un autre utilisateur ne voit pas ces services.
  const other = await newUser();
  const w2 = { body: await workspace(other, 'Autre') };
  const conv2 = await other.get(`/workspaces/${w2.body.id}/conversation`);
  const sent2 = await other.post(`/workspaces/${w2.body.id}/messages`, { text: 'Isolation [[tool:bash {"command":"(exec 3<>/dev/tcp/127.0.0.1/6379) 2>/dev/null && echo joignable || echo injoignable"}]]' }, { 'Idempotency-Key': `f-${uid()}` });
  const evs2 = await other.events(w2.body.id, conv2.body.lastEventId, (e) => e.type === 'run.completed' && e.runId === sent2.body.runId, 300_000);
  assert.match(evs2.find((e) => e.type === 'tool.completed').data.output, /injoignable/);

  // Arrêt d'un service, puis de la sandbox : plus aucun conteneur de service.
  out = await tools(`Stop. ${svc({ action: 'stop', name: 'redis' })} ${svc({ action: 'status' })}`);
  assert.match(out[0].output, /arrêté/);
  assert.doesNotMatch(out[1].output, /redis/);
  const sbx = sandboxId();
  assert.equal(serviceContainers(sbx).length, 1);
  await lead.post(`/workspaces/${wsId}/stop`);
  for (let i = 0; i < 30 && serviceContainers(sbx).length; i++) await new Promise((r) => setTimeout(r, 1000));
  assert.equal(serviceContainers(sbx).length, 0, 'services supprimés avec la sandbox');
});

/** Lecture binaire authentifiée (images). */
async function fetchBinary(client, path) {
  const res = await fetch(`${BASE}/api/v1${path}`, { headers: { Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  return { status: res.status, type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
}

test('captures d’écran : plugin browser de Pi (Chromium de la sandbox), scripts Playwright, miniatures dans la conversation, accès en lecture partagée', async () => {
  const owner = await newUser();
  const ws = await workspace(owner, 'Captures');
  const html = '<!doctype html><meta charset="utf-8"><title>Démo captures</title><style>body{margin:0;font:32px sans-serif;background:#fef3c7}</style><h1 id="t">Bonjour Shipcove</h1><button id="b" onclick="document.getElementById(\'t\').textContent=\'Cliqué\'">Go</button>';
  const setup = [
    'mkdir -p /tmp/site',
    `printf '%s' ${JSON.stringify(html).replace(/'/g, "'\\''")} > /tmp/site/index.html`,
    '(cd /tmp/site && nohup python3 -m http.server 8000 --bind 127.0.0.1 > /tmp/http.log 2>&1 &)',
    'for i in $(seq 30); do curl -sf -o /dev/null http://127.0.0.1:8000/ && break; sleep 0.5; done',
  ].join(' && ');
  const script = "const {chromium}=require('playwright');(async()=>{const b=await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});const p=await b.newPage({viewport:{width:640,height:480}});await p.goto('http://127.0.0.1:8000/');await p.screenshot({path:'/workspace/.cap/screenshots/script.png'});await b.close();})()";
  const conv = await owner.get(`/workspaces/${ws.id}/conversation`);
  const sent = await owner.post(
    `/workspaces/${ws.id}/messages`,
    {
      text:
        `Montre le site. [[tool:bash ${JSON.stringify({ command: setup })}]] ` +
        `[[tool:browser_screenshot ${JSON.stringify({ url: 'http://127.0.0.1:8000/', name: 'Accueil' })}]] ` +
        `[[tool:browser_screenshot ${JSON.stringify({ url: 'http://127.0.0.1:8000/', name: 'mobile après clic', mobile: true, actions: [{ type: 'click', selector: '#b' }] })}]] ` +
        `[[tool:bash ${JSON.stringify({ command: `mkdir -p /workspace/.cap/screenshots && node -e ${JSON.stringify(script)}` })}]]`,
    },
    { 'Idempotency-Key': `f-${uid()}` },
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const events = await owner.events(ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 420_000);
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  const done = events.filter((e) => e.type === 'tool.completed');
  assert.equal(done.length, 4, JSON.stringify(done.map((e) => e.data.output)));
  const [, desktop, mobile, scripted] = done;
  assert.ok(!desktop.data.isError, desktop.data.output);
  assert.match(desktop.data.output, /Capture enregistrée/);
  assert.match(desktop.data.output, /Démo captures/);
  assert.match(desktop.data.output, /HTTP 200/);
  assert.equal(desktop.data.images.length, 1);
  assert.deepEqual([desktop.data.images[0].width, desktop.data.images[0].height], [1280, 800]);
  assert.match(desktop.data.images[0].fileName, /-accueil\.png$/);
  assert.equal(mobile.data.images[0].width, 780, 'mobile, densité 2');
  assert.ok(Math.abs(mobile.data.images[0].height - 1688) <= 2, String(mobile.data.images[0].height));
  assert.deepEqual([scripted.data.images[0].width, scripted.data.images[0].height], [640, 480], 'capture d’un script Playwright');
  assert.equal(done[0].data.images.length, 0);

  // Persistées dans la conversation et servies en PNG.
  const reloaded = await owner.get(`/workspaces/${ws.id}/conversation`);
  const calls = reloaded.body.messages.flatMap((m) => m.toolCalls);
  assert.equal(calls.filter((c) => c.images.length).length, 3);
  const img = await fetchBinary(owner, `/workspaces/${ws.id}/screenshots/${desktop.data.images[0].attachmentId}`);
  assert.equal(img.status, 200);
  assert.equal(img.type, 'image/png');
  assert.equal(img.body.subarray(1, 4).toString(), 'PNG');

  // Lecture : membre non autorisé refusé, puis autorisé une fois la conversation partagée.
  const peer = await newUser();
  const path = `/workspaces/${ws.id}/screenshots/${mobile.data.images[0].attachmentId}`;
  assert.equal((await fetchBinary(peer, path)).status, 404);
  assert.equal((await owner.post(`/conversations/${ws.conversationId}/shares`, { userId: peer.id })).status, 201);
  assert.equal((await fetchBinary(peer, path)).status, 200);

  // Une capture n'est pas une pièce jointe utilisateur : ni envoyable, ni supprimable par cette voie.
  assert.equal((await owner.del(`/workspaces/${ws.id}/attachments/${desktop.data.images[0].attachmentId}`)).status, 404);
  // Hors checkpoints : le dossier des captures n'apparaît pas dans les fichiers du workspace.
  const files = await owner.get(`/workspaces/${ws.id}/files/all`);
  assert.ok(!JSON.stringify(files.body ?? {}).includes('screenshots'), 'captures exclues des fichiers persistés');
});

test('onglet Git : branches, changement de branche (refusé pendant un run, signalé à Pi), co-auteur Shipcove sur chaque commit', async () => {
  const owner = await newUser();
  const ws = await workspace(owner, 'Branches');
  const run = async (text) => {
    const conv = await owner.get(`/workspaces/${ws.id}/conversation`);
    const sent = await owner.post(`/workspaces/${ws.id}/messages`, { text }, { 'Idempotency-Key': `f-${uid()}` });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const events = await owner.events(ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 300_000);
    assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
    return events.filter((e) => e.type === 'tool.completed');
  };
  const setup = 'git init -q && echo a > a.txt && git add . && git commit -q -m "feat: a" && git switch -q -c feature && echo b > b.txt && git add . && git commit -q -m "feat: b" && git log -2 --format=%B';
  const [done] = await run(`Prépare. [[tool:bash ${JSON.stringify({ command: setup })}]]`);
  assert.equal((done.data.output.match(/Co-Authored-By: Shipcove <noreply@shipcove\.dev>/g) ?? []).length, 2, done.data.output);

  // Branche suivie après un `git switch` de Pi.
  const branches = await owner.get(`/workspaces/${ws.id}/git/branches`);
  assert.equal(branches.status, 200);
  assert.equal(branches.body.current, 'feature');
  // En-tête : branche enregistrée et diffusée après le `git switch` de Pi.
  assert.equal((await owner.get(`/workspaces/${ws.id}`)).body.branch, 'feature');
  assert.deepEqual(branches.body.local.map((b) => b.name).sort(), ['feature', 'main']);

  // Changement par l'utilisateur : nom invalide refusé, puis note dans le fil.
  assert.equal((await owner.post(`/workspaces/${ws.id}/git/checkout`, { branch: '--orphan' })).status, 400);
  assert.equal((await owner.post(`/workspaces/${ws.id}/git/checkout`, { branch: 'main' })).status, 200);
  assert.equal((await owner.get(`/workspaces/${ws.id}/git/branches`)).body.current, 'main');
  assert.equal((await owner.get(`/workspaces/${ws.id}`)).body.branch, 'main');
  const conv = await owner.get(`/workspaces/${ws.id}/conversation`);
  assert.ok(conv.body.messages.some((m) => m.role === 'system' && m.meta?.kind === 'branch_switched' && m.text === 'Branche de travail : feature → main'));
  // Réservé au propriétaire.
  const peer = await newUser();
  assert.equal((await peer.post(`/workspaces/${ws.id}/git/checkout`, { branch: 'feature' })).status, 404);

  // Le tour suivant de Pi part bien de main (b.txt absent).
  const [ls] = await run(`Vérifie. [[tool:bash ${JSON.stringify({ command: 'git branch --show-current && ls' })}]]`);
  assert.match(ls.data.output, /^main\n/);
  assert.ok(!ls.data.output.includes('b.txt'));
});

test('fichiers à télécharger : share_files copie les livrables de Pi, servis en téléchargement, lisibles en partage, confinés à /workspace et /tmp', async () => {
  const owner = await newUser();
  const ws = await workspace(owner, 'Livrables');
  const conv = await owner.get(`/workspaces/${ws.id}/conversation`);
  const setup = "printf '# Mon projet\\n\\nBonjour.\\n' > README.md && mkdir -p /tmp/out && printf 'a,b\\n1,2\\n' > /tmp/out/export.csv && mkdir -p docs";
  const sent = await owner.post(
    `/workspaces/${ws.id}/messages`,
    {
      text:
        `Écris un README. [[tool:bash ${JSON.stringify({ command: setup })}]] ` +
        `[[tool:share_files ${JSON.stringify({ paths: ['README.md', '/tmp/out/export.csv', '/etc/hostname', 'docs', 'absent.txt'] })}]] ` +
        `[[tool:share_files ${JSON.stringify({ paths: ['/etc/passwd'] })}]]`,
    },
    { 'Idempotency-Key': `f-${uid()}` },
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const events = await owner.events(ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 300_000);
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  const done = events.filter((e) => e.type === 'tool.completed');
  assert.equal(done.length, 3, JSON.stringify(done.map((e) => e.data.output)));
  const [, shared, refused] = done;
  assert.ok(!shared.data.isError, shared.data.output);
  assert.deepEqual(shared.data.files.map((f) => [f.fileName, f.path, f.kind]), [
    ['README.md', '/workspace/README.md', 'text'],
    ['export.csv', '/tmp/out/export.csv', 'text'],
  ]);
  assert.match(shared.data.output, /\/etc\/hostname : seuls les fichiers/);
  assert.match(shared.data.output, /docs : ce n’est pas un fichier/);
  assert.match(shared.data.output, /absent\.txt : fichier introuvable/);
  assert.ok(refused.data.isError, 'aucun fichier partageable : appel en échec');
  assert.equal((refused.data.files ?? []).length, 0);

  // Persistés dans la conversation et servis en téléchargement (jamais interprétés par le navigateur).
  const reloaded = await owner.get(`/workspaces/${ws.id}/conversation`);
  const call = reloaded.body.messages.flatMap((m) => m.toolCalls).find((c) => c.toolName === 'share_files' && c.files.length);
  assert.equal(call.files.length, 2);
  const path = `/workspaces/${ws.id}/agent-files/${call.files[0].attachmentId}`;
  const res = await fetch(`${BASE}/api/v1${path}`, { headers: { Cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''README\.md$/);
  assert.equal(await res.text(), '# Mon projet\n\nBonjour.\n');

  // Lecture partagée : refusé à un tiers, autorisé une fois la conversation partagée.
  const peer = await newUser();
  assert.equal((await fetchBinary(peer, path)).status, 404);
  assert.equal((await owner.post(`/conversations/${ws.conversationId}/shares`, { userId: peer.id })).status, 201);
  assert.equal((await fetchBinary(peer, path)).status, 200);
  // Pas une pièce jointe utilisateur : non supprimable par cette voie.
  assert.equal((await owner.del(`/workspaces/${ws.id}/attachments/${call.files[0].attachmentId}`)).status, 404);
});

test('questions de Pi (plugin ask) : formulaire dans la conversation, réponse rattachée, Pi reprend ; disponible en mode Plan', async () => {
  const owner = await newUser();
  const ws = await workspace(owner, 'Questions');
  // Mode Plan : lecture seule, mais les questions restent permises.
  assert.equal((await owner.req('PATCH', `/workspaces/${ws.id}`, { agentMode: 'plan' })).status, 200);
  const ask = {
    title: 'Cadrage',
    questions: [
      { question: 'À qui est destinée la plateforme ?', options: [{ label: 'Usage personnel' }, { label: 'Équipes internes' }], recommended: 1 },
      { question: 'Quels langages ?', options: [{ label: 'TypeScript' }, { label: 'Python' }, { label: 'Go' }], multi_select: true },
    ],
  };
  const conv = await owner.get(`/workspaces/${ws.id}/conversation`);
  const sent = await owner.post(`/workspaces/${ws.id}/messages`, { text: `Cadrons. [[tool:ask_user ${JSON.stringify(ask)}]]` }, { 'Idempotency-Key': `f-${uid()}` });
  const events = await owner.events(ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 420_000);
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  const done = events.find((e) => e.type === 'tool.completed');
  assert.ok(done && !done.data.isError, JSON.stringify(done));
  assert.match(done.data.output, /2 questions affichées/);
  assert.match(done.data.output, /Arrête-toi/);
  const started = events.find((e) => e.type === 'tool.started');
  assert.equal(started.data.toolName, 'ask_user');
  assert.deepEqual(started.data.args.questions.map((q) => q.question), ask.questions.map((q) => q.question), 'questions transmises à l’interface');

  // Réponse rattachée à l'appel : métadonnée persistée et nouveau run avec le texte des réponses.
  const conv2 = await owner.get(`/workspaces/${ws.id}/conversation`);
  const answer = await owner.post(`/workspaces/${ws.id}/messages`, { text: 'Réponses :\n1. → Équipes internes\n2. → TypeScript ; Go', answersTo: done.data.toolCallId }, { 'Idempotency-Key': `f-${uid()}` });
  assert.equal(answer.status, 201, JSON.stringify(answer.body));
  const ev2 = await owner.events(ws.id, conv2.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === answer.body.runId, 420_000);
  assert.equal(ev2.at(-1).type, 'run.completed');
  assert.deepEqual(ev2.find((e) => e.type === 'message.created' && e.data.role === 'user').data.meta, { kind: 'answers', toolCallId: done.data.toolCallId });
  const reloaded = await owner.get(`/workspaces/${ws.id}/conversation`);
  const msg = reloaded.body.messages.find((m) => m.meta?.kind === 'answers');
  assert.equal(msg.meta.toolCallId, done.data.toolCallId);
  assert.match(msg.text, /Équipes internes/);
});

/** Objets S3 restants sous un préfixe (identifiants lus dans Vault, environnement de développement). */
async function s3Count(bucket, prefix) {
  const { S3Client, ListObjectsV2Command } = createRequire(new URL('../../packages/storage/package.json', import.meta.url))('@aws-sdk/client-s3');
  const init = JSON.parse(readFileSync(new URL('../../infrastructure/docker/.secrets/vault-init.json', import.meta.url), 'utf8'));
  const creds = JSON.parse(execFileSync('docker', ['exec', '-e', `VAULT_TOKEN=${init.root_token}`, '-e', 'VAULT_ADDR=http://127.0.0.1:8200', 'cap-vault-1', 'vault', 'kv', 'get', '-format=json', 'cap/infra/s3'], { encoding: 'utf8' })).data.data;
  const s3 = new S3Client({ endpoint: process.env.CAP_E2E_S3_URL ?? 'http://127.0.0.1:3900', region: 'garage', forcePathStyle: true, credentials: creds });
  const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return r.KeyCount ?? 0;
}

test('suppression d’une conversation pendant un run : tout est effacé (sandbox, volumes, sauvegardes S3, pièces jointes, historique)', async () => {
  const user = await newUser();
  const ws = await workspace(user, 'À supprimer');
  await run(user, ws.id, 'Écris. [[tool:bash {"command":"echo contenu > a.txt && mkdir -p d && echo b > d/b.txt"}]]');
  const up = await upload(user, ws.id, [{ name: 'image.png', type: 'image/png', data: PNG_1PX }]);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const attKey = sql(`select storage_key from attachments where workspace_id = '${ws.id}' limit 1`);
  assert.ok(attKey);
  assert.ok((await s3Count('cap-workspaces', `workspaces/${ws.id}/`)) > 0, 'sauvegardes présentes avant');
  const sandbox = sql(`select external_id from sandbox_instances where workspace_id = '${ws.id}' and status = 'running'`);
  assert.ok(sandbox, 'sandbox active');
  const volumes = () => execFileSync('docker', ['inspect', '-f', '{{range .Mounts}}{{.Name}} {{end}}', sandbox], { encoding: 'utf8' }).trim().split(' ').filter(Boolean);
  const vols = volumes();
  assert.equal(vols.length, 3);

  // Pi travaille, un message attend dans la file : la suppression interrompt et annule tout.
  const conv = await user.get(`/workspaces/${ws.id}/conversation`);
  const long = await user.post(`/workspaces/${ws.id}/messages`, { text: 'Longue tâche. [[sleep:30000]]' }, { 'Idempotency-Key': `f-${uid()}` });
  await user.events(ws.id, conv.body.lastEventId, (e) => e.type === 'run.started' && e.runId === long.body.runId, 120_000);
  await user.post(`/workspaces/${ws.id}/messages`, { text: 'En attente', delivery: 'follow_up' }, { 'Idempotency-Key': `f-${uid()}` });
  const other = await newUser();
  assert.equal((await other.del(`/workspaces/${ws.id}`)).status, 404, 'seul le propriétaire supprime');
  assert.equal((await user.del(`/workspaces/${ws.id}`)).status, 204);
  // Effet immédiat pour l'utilisateur.
  assert.ok(!(await user.get('/workspaces')).body.some((w) => w.id === ws.id));
  assert.equal((await user.get(`/workspaces/${ws.id}`)).status, 404);
  assert.equal((await user.del(`/workspaces/${ws.id}`)).status, 404);

  // Purge définitive par le worker.
  let gone = false;
  for (let i = 0; i < 90 && !gone; i++) {
    gone = sql(`select count(*) from workspaces where id = '${ws.id}'`) === '0';
    if (!gone) await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(gone, 'conversation effacée de la base');
  for (const table of ['conversations', 'agent_runs', 'agent_events', 'attachments', 'sandbox_instances', 'workspace_snapshots', 'preview_ports']) {
    assert.equal(sql(`select count(*) from ${table} where workspace_id = '${ws.id}'`), '0', `${table} vidée`);
  }
  assert.equal(execFileSync('docker', ['ps', '-aq', '--filter', `label=cap.workspace=${ws.id}`], { encoding: 'utf8' }).trim(), '', 'conteneur de sandbox détruit');
  const leftVols = execFileSync('docker', ['volume', 'ls', '-q'], { encoding: 'utf8' }).split('\n');
  assert.ok(!vols.some((v) => leftVols.includes(v)), 'volumes de la sandbox détruits');
  assert.equal(await s3Count('cap-workspaces', `workspaces/${ws.id}/`), 0, 'sauvegardes S3 effacées');
  assert.equal(await s3Count('cap-attachments', attKey), 0, 'pièce jointe effacée');
  // La consommation reste comptée (quota personnel), sans référence à un contenu.
  assert.ok(Number(sql(`select count(*) from llm_requests where workspace_id = '${ws.id}'`)) > 0);
});

test('miroir de registre : images des services réécrites vers le miroir, identifiants (Vault) requis, repli sur l’origine', async () => {
  // Miroir authentifié de Docker Hub (cache « pull-through »), joignable par le moteur Docker de l'hôte.
  const MIRROR = 'localhost:5055';
  const htpasswd = new URL('./registry/htpasswd', import.meta.url).pathname;
  execFileSync('docker', ['rm', '-f', 'cap-e2e-registry'], { stdio: 'ignore' });
  execFileSync('docker', [
    'run', '-d', '--name', 'cap-e2e-registry', '-p', '127.0.0.1:5055:5000',
    '-v', `${htpasswd}:/auth/htpasswd:ro`,
    '-e', 'REGISTRY_AUTH=htpasswd', '-e', 'REGISTRY_AUTH_HTPASSWD_REALM=e2e', '-e', 'REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd',
    '-e', 'REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io',
    'registry:2.8.3',
  ]);
  const redis = (await ctx.admin.get('/admin/service-catalog')).body.find((c) => c.key === 'redis');
  const mirrored = `${MIRROR}/library/${redis.image.includes('/') ? redis.image.split('/').pop() : redis.image}`;
  const user = await newUser();
  const ws = await workspace(user, 'Miroir');
  const svc = async (args) => {
    const conv = await user.get(`/workspaces/${ws.id}/conversation`);
    const sent = await user.post(`/workspaces/${ws.id}/messages`, { text: `Service. [[tool:platform_services ${JSON.stringify(args)}]]` }, { 'Idempotency-Key': `f-${uid()}` });
    const evs = await user.events(ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 600_000);
    return evs.find((e) => e.type === 'tool.completed').data;
  };
  const serviceImage = (name) => {
    const sbx = sql(`select external_id from sandbox_instances where workspace_id = '${ws.id}' and status = 'running'`);
    return execFileSync('docker', ['inspect', '-f', '{{.Config.Image}}', `cap-svc-${sbx.slice(0, 12)}-${name}`], { encoding: 'utf8' }).trim();
  };
  const mirrors = (body) => ctx.admin.put('/admin/registry-mirrors', body);
  try {
    // Réservé à l'administrateur ; préfixe invalide refusé.
    assert.equal((await user.put('/admin/registry-mirrors', { mirrors: [], fallbackToUpstream: false })).status, 403);
    assert.equal((await mirrors({ mirrors: [{ registry: 'docker.io', prefix: 'pas un préfixe' }], fallbackToUpstream: false })).status, 400);

    // Miroir sans identifiants : refusé par le registre, pas de repli → échec explicite.
    assert.equal((await mirrors({ mirrors: [{ registry: 'docker.io', prefix: MIRROR }], fallbackToUpstream: false })).status, 200);
    const preview = (await ctx.admin.post('/admin/registry-mirrors/preview', { images: [redis.image, 'ghcr.io/x/y:1'] })).body;
    assert.deepEqual(preview.map((p) => p.pulled), [mirrored, 'ghcr.io/x/y:1']);
    let out = await svc({ action: 'start', service: 'redis', name: 'cache-a' });
    assert.equal(out.isError, true, out.output);
    assert.match(out.output, new RegExp(MIRROR));

    // Identifiants enregistrés (jamais renvoyés) : téléchargement via le miroir.
    const saved = await mirrors({ mirrors: [{ registry: 'docker.io', prefix: MIRROR, username: 'e2e', password: 'Miroir-E2e-2026' }], fallbackToUpstream: false });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.mirrors[0].passwordSet, true);
    assert.ok(!JSON.stringify((await ctx.admin.get('/admin/registry-mirrors')).body).includes('Miroir-E2e-2026'), 'mot de passe jamais renvoyé');
    // Réenregistrement sans mot de passe : le mot de passe est conservé.
    await mirrors({ mirrors: [{ registry: 'docker.io', prefix: MIRROR, username: 'e2e' }], fallbackToUpstream: false });
    out = await svc({ action: 'start', service: 'redis', name: 'cache-b' });
    assert.equal(out.isError, false, out.output);
    assert.equal(serviceImage('cache-b'), mirrored, 'image du miroir utilisée');
    assert.ok(!JSON.stringify(out).includes('Miroir-E2e-2026'));
    await svc({ action: 'stop', name: 'cache-b' });

    // Miroir injoignable avec repli autorisé : image d'origine.
    await mirrors({ mirrors: [{ registry: 'docker.io', prefix: 'localhost:5999/hub' }], fallbackToUpstream: true });
    out = await svc({ action: 'start', service: 'redis', name: 'cache-c' });
    assert.equal(out.isError, false, out.output);
    assert.equal(serviceImage('cache-c'), redis.image, 'repli sur le registre d’origine');
  } finally {
    await mirrors({ mirrors: [], fallbackToUpstream: false });
    execFileSync('docker', ['rm', '-f', 'cap-e2e-registry'], { stdio: 'ignore' });
    try {
      execFileSync('docker', ['rmi', '-f', mirrored], { stdio: 'ignore' });
    } catch {
      /* image jamais téléchargée */
    }
  }
});

test('outils Node dans la sandbox : npm install -g utilisable par l’agent, npm install d’un projet via le proxy', async () => {
  const user = await newUser();
  const ws = await workspace(user, 'Node');
  const out = await bashViaPi(
    user,
    ws.id,
    'npm config get prefix && npm install -g cowsay@1.6.0 2>&1 | grep -E "added|ERR" ; cowsay -T U global-ok | grep -c global-ok ; ' +
      'mkdir -p /workspace/p && cd /workspace/p && npm init -y >/dev/null && npm install is-number@7.0.0 2>&1 | grep -E "added|ERR" ; node -e "console.log(require(\'is-number\')(5) ? \'projet-ok\' : \'ko\')" ; ' +
      'node -e "require(\'playwright\'); console.log(\'playwright-ok\')"',
  );
  assert.match(out, /\/home\/agent\/\.local/, out);
  assert.doesNotMatch(out, /ERR/, out);
  assert.match(out, /^1$/m, 'commande globale disponible dans le PATH');
  assert.match(out, /projet-ok/);
  assert.match(out, /playwright-ok/, 'outils de l’image toujours résolus');
});

test('plusieurs skills choisis en tête du message : tous développés pour Pi (qui n’en traite qu’un seul)', async () => {
  const user = await newUser();
  const id = uid().toLowerCase().replace(/[^a-z0-9]/g, '');
  const mk = async (name, marker) => {
    const content = `---\nname: ${name}\ndescription: Skill ${marker}\n---\n\nApplique ceci. [[tool:bash {"command":"echo ${marker}"}]]\n`;
    const r = await user.post('/skills', { name, description: `Skill ${marker}`, files: [{ path: 'SKILL.md', content }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  };
  await mk(`ska-${id}`, 'SKILL_A_OK');
  await mk(`skb-${id}`, 'SKILL_B_OK');
  const ws = await workspace(user, 'Skills multiples');
  const conv = await user.get(`/workspaces/${ws.id}/conversation`);
  const sent = await user.post(`/workspaces/${ws.id}/messages`, { text: `/skill:ska-${id} /skill:skb-${id} Fais-le` }, { 'Idempotency-Key': `f-${uid()}` });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const evs = await user.events(ws.id, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 300_000);
  assert.equal(evs.at(-1).type, 'run.completed', JSON.stringify(evs.at(-1)));
  const outputs = evs.filter((e) => e.type === 'tool.completed').map((e) => e.data.output).join('\n');
  assert.match(outputs, /SKILL_A_OK/, 'premier skill développé');
  assert.match(outputs, /SKILL_B_OK/, 'second skill développé');
  // Le message affiché reste celui de l'utilisateur (les blocs ne sont pas recopiés dans le fil).
  const saved = (await user.get(`/workspaces/${ws.id}/conversation`)).body.messages.find((m) => m.role === 'user');
  assert.equal(saved.text, `/skill:ska-${id} /skill:skb-${id} Fais-le`);
});

/** Archive ZIP « stored » avec CRC, droits Unix et noms quelconques (y compris piégés). */
async function skillZip(entries) {
  const { crc32 } = await import('node:zlib');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

async function importSkill(client, zipBuf, fields = {}) {
  const form = new FormData();
  form.append('file', new Blob([zipBuf], { type: 'application/zip' }), 'skill.zip');
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${BASE}/api/v1/skills/import`, {
    method: 'POST',
    headers: { 'X-CSRF-Token': client.csrf, Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: form,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test('skills markdown avec dossiers : import .zip (non-markdown ignoré), arborescence dans la sandbox, édition, export, archives piégées refusées', async () => {
  const user = await newUser();
  const id = uid().toLowerCase().replace(/[^a-z0-9]/g, '');
  const name = `arbo-${id}`;
  const zipBuf = await skillZip([
    { name: `${name}/SKILL.md`, data: `---\nname: ${name}\ndescription: >\n  Skill de test avec dossiers\n  et sous-dossiers.\n---\n\nVoir [le guide](references/api/guide.md).\n` },
    { name: `${name}/references/api/guide.md`, data: '# Guide\n' },
    { name: `${name}/references/faq.markdown`, data: '# FAQ\n' },
    { name: `${name}/scripts/run.sh`, data: '#!/bin/sh\necho script\n', mode: 0o100755 },
    { name: `${name}/assets/logo.png`, data: Buffer.from(PNG_1PX) },
    { name: '__MACOSX/._SKILL.md', data: 'x' },
  ]);
  const imp = await importSkill(user, zipBuf, { scope: 'personal' });
  assert.equal(imp.status, 201, JSON.stringify(imp.body));
  assert.deepEqual(imp.body.ignored.sort(), ['assets/logo.png', 'scripts/run.sh'], 'fichiers non markdown ignorés et signalés');
  const skillId = imp.body.id;
  let detail = (await user.get(`/skills/${skillId}`)).body;
  assert.equal(detail.skill.name, name, 'nom lu dans le frontmatter');
  assert.equal(detail.skill.description, 'Skill de test avec dossiers et sous-dossiers.', 'description lue dans le frontmatter (bloc replié)');
  assert.deepEqual(detail.files.map((f) => f.path), ['SKILL.md', 'references/api/guide.md', 'references/faq.markdown']);
  assert.ok(detail.files.every((f) => !('encoding' in f) && !('executable' in f)));

  // Arborescence fidèle dans la sandbox, markdown uniquement.
  const ws = await workspace(user, 'Skills arborescence');
  const dir = `/home/agent/.pi/agent/skills/${name}`;
  let out = await bashViaPi(user, ws.id, `cd ${dir} && find . -type f | sort`);
  assert.equal(out.trim(), ['./SKILL.md', './references/api/guide.md', './references/faq.markdown'].join('\n'), out);

  // Édition : fichier repris sans être renvoyé (et déplacé), nouveau fichier en sous-dossier, fichier supprimé.
  const v2 = await user.put(`/skills/${skillId}/files`, {
    files: [
      { path: 'SKILL.md', content: detail.files[0].content.replace('Voir', 'Lire') },
      { path: 'docs/api/guide.md', sourcePath: 'references/api/guide.md' },
      { path: 'docs/fr/notes.md', content: 'Notes' },
    ],
  });
  assert.equal(v2.status, 200, JSON.stringify(v2.body));
  detail = (await user.get(`/skills/${skillId}`)).body;
  assert.ok(!('versions' in detail), 'pas d’historique de versions');
  assert.deepEqual(detail.files.map((f) => f.path), ['SKILL.md', 'docs/api/guide.md', 'docs/fr/notes.md']);
  assert.equal(detail.files.find((f) => f.path === 'docs/api/guide.md').content, '# Guide\n');
  out = await bashViaPi(user, ws.id, `cd ${dir} && find . -type f | sort`);
  assert.equal(out.trim(), ['./SKILL.md', './docs/api/guide.md', './docs/fr/notes.md'].join('\n'), 'fichiers retirés absents au run suivant');

  // Pas de script, de binaire ni de fichier non markdown par l'API.
  for (const files of [
    [{ path: 'SKILL.md', content: 'x' }, { path: 'run.sh', content: 'echo' }],
    [{ path: 'SKILL.md', content: 'x' }, { path: 'img.png', content: 'iVBORw0KGgo=' }],
    [{ path: 'SKILL.md', content: 'a\u0000b' }],
  ]) assert.equal((await user.put(`/skills/${skillId}/files`, { files })).status, 400, JSON.stringify(files.map((f) => f.path)));

  // Export : archive relue à l'identique (aller-retour par un import qui remplace le contenu).
  const exp = await fetch(`${BASE}/api/v1/skills/${skillId}/export`, { headers: { Cookie: [...user.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(exp.status, 200);
  assert.equal(exp.headers.get('content-type'), 'application/zip');
  const back = await importSkill(user, Buffer.from(await exp.arrayBuffer()), { skillId });
  assert.equal(back.status, 201, JSON.stringify(back.body));
  assert.deepEqual(back.body.ignored, []);
  const v3 = (await user.get(`/skills/${skillId}`)).body;
  assert.deepEqual(v3.files.map((f) => [f.path, f.content]), detail.files.map((f) => [f.path, f.content]));

  // Archives et chemins piégés refusés ; autorité respectée.
  for (const [label, entries] of [
    ['remontée de dossier', [{ name: 'SKILL.md', data: '---\nname: x\ndescription: x\n---' }, { name: '../../evil.md', data: 'x' }]],
    ['lien symbolique', [{ name: 'SKILL.md', data: '---\nname: x\ndescription: x\n---' }, { name: 'lien.md', data: '/etc/passwd', mode: 0o120777 }]],
    ['SKILL.md absent', [{ name: 'docs/a.md', data: 'x' }]],
  ]) {
    const r = await importSkill(user, await skillZip(entries), { scope: 'personal', name: `piege-${id}` });
    assert.equal(r.status, 400, `${label} : ${JSON.stringify(r.body)}`);
  }
  assert.equal((await importSkill(user, Buffer.from('pas une archive'), { scope: 'personal' })).status, 400);
  const other = await newUser();
  assert.equal((await importSkill(other, zipBuf, { skillId })).status, 404, 'skill d’un autre utilisateur');
  assert.equal((await other.get(`/skills/${skillId}/export`)).status, 404);
});

test('catégories de skills : gérées par les administrateurs, choisies par les auteurs, ordre et suppression', async () => {
  const user = await newUser();
  const id = uid().toLowerCase().replace(/[^a-z0-9]/g, '');
  // Réservé aux administrateurs.
  assert.equal((await user.post('/admin/skill-categories', { name: `Interdit ${id}` })).status, 403);
  const a = await ctx.admin.post('/admin/skill-categories', { name: `Front ${id}`, description: 'Interfaces web' });
  const b = await ctx.admin.post('/admin/skill-categories', { name: `Data ${id}` });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal((await ctx.admin.post('/admin/skill-categories', { name: `front ${id}` })).status, 409, 'nom unique (sans tenir compte de la casse)');
  // Ordre : B avant A.
  const all = (await ctx.admin.get('/admin/skill-categories')).body.map((c) => c.id);
  const ids = [b.body.id, a.body.id, ...all.filter((x) => x !== a.body.id && x !== b.body.id)];
  assert.equal((await ctx.admin.put('/admin/skill-categories', { ids })).status, 200);
  const seen = (await user.get('/skill-categories')).body;
  assert.ok(seen.findIndex((c) => c.id === b.body.id) < seen.findIndex((c) => c.id === a.body.id), 'ordre visible par les utilisateurs');

  // Un auteur range son skill (création, puis changement) ; catégorie inconnue refusée.
  const md = (n) => [{ path: 'SKILL.md', content: `---\nname: ${n}\ndescription: Test\n---\n` }];
  const s = await user.post('/skills', { name: `cat-${id}`, categoryId: a.body.id, files: md(`cat-${id}`) });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  let mine = (await user.get('/skills')).body.find((x) => x.id === s.body.id);
  assert.equal(mine.categoryId, a.body.id);
  assert.equal((await user.patch(`/skills/${s.body.id}`, { categoryId: b.body.id })).status, 200);
  assert.equal((await user.patch(`/skills/${s.body.id}`, { categoryId: '00000000-0000-4000-8000-000000000000' })).status, 400);
  const other = await newUser();
  assert.equal((await other.patch(`/skills/${s.body.id}`, { categoryId: null })).status, 404, 'skill d’un autre utilisateur');
  assert.equal((await user.get('/skill-categories')).body.find((c) => c.id === b.body.id).skillCount, 1);

  // Suppression : le skill passe « sans catégorie ».
  assert.equal((await ctx.admin.del(`/admin/skill-categories/${b.body.id}`)).status, 204);
  mine = (await user.get('/skills')).body.find((x) => x.id === s.body.id);
  assert.equal(mine.categoryId, null);
  await ctx.admin.del(`/admin/skill-categories/${a.body.id}`);
});
