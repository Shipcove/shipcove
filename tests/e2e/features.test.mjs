// Parcours fonctionnels complémentaires (SPEC §25) sur la pile Compose réelle :
// édition manuelle et conflits (n°9), skills/MCP (n°13), pièces jointes, notifications, rétention (n°15).
// Prérequis : pile démarrée, modèle par défaut créé (stack.test.mjs).
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BASE, Client, adminClient, uid } from './client.mjs';

const STATE_FILE = new URL('./.e2e-state.json', import.meta.url);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const ctx = {};

/** Utilisateur connecté, membre de l'équipe de test. */
async function newUser(role = 'member') {
  const username = `f${uid()}`;
  const password = 'Feature-Password-123456';
  const r = await ctx.admin.post('/admin/users', { email: `${username}@example.test`, username, displayName: `F ${username}`, platformRole: 'user', password });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  await ctx.admin.post(`/teams/${ctx.teamId}/members`, { userId: r.body.id, role });
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
  const p = await client.post('/projects', { teamId: ctx.teamId, name: `${name} ${uid()}` });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const w = await client.post('/workspaces', { projectId: p.body.id, name });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  opened.push({ client, id: w.body.id });
  return w.body;
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
  const slug = `feat-${uid()}`;
  const team = await ctx.admin.post('/teams', { name: `Fonctionnel ${slug}`, slug });
  assert.equal(team.status, 201);
  ctx.teamId = team.body.id;
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

test('skills : portées (global / équipe / personnel), désactivation et révocation appliquées au run suivant', async () => {
  const ws = await workspace(ctx.dev, 'Skills');
  const id = uid().toLowerCase().replace(/[^a-z0-9]/g, '');
  const names = { global: `glob-${id}`, team: `team-${id}`, personal: `perso-${id}`, otherTeam: `autre-${id}`, otherUser: `voisin-${id}` };

  // Global : brouillon puis publication par l'administrateur.
  const g = await ctx.admin.post('/skills', { name: names.global, description: 'global', scope: 'global', files: skillFiles(names.global) });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal(g.body.status, 'draft');
  assert.equal((await ctx.admin.post(`/skills/${g.body.id}/status`, { status: 'published' })).status, 200);
  // Équipe du workspace (publié par l'admin, administrateur d'équipe implicite).
  const t = await ctx.admin.post('/skills', { name: names.team, description: 'équipe', scope: 'team', teamId: ctx.teamId, files: skillFiles(names.team) });
  await ctx.admin.post(`/skills/${t.body.id}/status`, { status: 'published' });
  // Personnel (publié directement).
  const p = await ctx.dev.post('/skills', { name: names.personal, description: 'perso', scope: 'personal', files: skillFiles(names.personal) });
  assert.equal(p.body.status, 'published', JSON.stringify(p.body));
  // Hors périmètre : autre équipe, autre utilisateur.
  const slug = `autre-${uid()}`;
  const otherTeam = await ctx.admin.post('/teams', { name: `Autre ${slug}`, slug });
  const ot = await ctx.admin.post('/skills', { name: names.otherTeam, description: 'x', scope: 'team', teamId: otherTeam.body.id, files: skillFiles(names.otherTeam) });
  await ctx.admin.post(`/skills/${ot.body.id}/status`, { status: 'published' });
  const neighbour = await newUser();
  const nb = await neighbour.post('/skills', { name: names.otherUser, description: 'x', scope: 'personal', files: skillFiles(names.otherUser) });
  assert.equal(nb.status, 201);

  // Le voisin ne voit ni ne pilote le skill personnel de dev.
  assert.equal((await neighbour.get(`/skills/${p.body.id}`)).status, 404);
  assert.equal((await neighbour.put(`/skills/${p.body.id}/installation`, { scope: 'personal', enabled: false })).status, 404);

  const ls = () => bashViaPi(ctx.dev, ws.id, 'ls -1 /home/agent/.pi/agent/skills');
  let out = await ls();
  for (const n of [names.global, names.team, names.personal]) assert.ok(out.includes(n), `${n} présent :\n${out}`);
  for (const n of [names.otherTeam, names.otherUser]) assert.ok(!out.includes(n), `${n} absent :\n${out}`);

  // Désactivation personnelle + révocation globale : effectives au run suivant, sandbox toujours active.
  assert.equal((await ctx.dev.put(`/skills/${p.body.id}/installation`, { scope: 'personal', enabled: false })).status, 200);
  assert.equal((await ctx.admin.post(`/skills/${g.body.id}/status`, { status: 'revoked' })).status, 200);
  // Une fois révoqué, un skill ne peut pas être republié.
  assert.equal((await ctx.admin.post(`/skills/${g.body.id}/status`, { status: 'published' })).status, 409);
  out = await ls();
  assert.ok(out.includes(names.team), out);
  assert.ok(!out.includes(names.personal), `skill désactivé encore présent :\n${out}`);
  assert.ok(!out.includes(names.global), `skill révoqué encore présent :\n${out}`);
  // Un membre ne publie pas de skill global.
  assert.equal((await ctx.dev.post('/skills', { name: `x-${id}`, description: 'x', scope: 'global', files: skillFiles(`x-${id}`) })).status, 403);
});

// Serveur MCP stdio minimal (JSON-RPC ligne à ligne), exécuté dans la sandbox.
const ECHO_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Écho', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } });
  if (m.method === 'tools/call') return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + m.params.arguments.text + ':' + (process.env.ECHO_SECRET === 'valeur-secrete-mcp' ? 'secret-ok' : 'secret-absent') }] } });
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'inconnu' } });
});`;

test('MCP : outil stdio exécuté dans la sandbox, secret injecté depuis Vault, permission d’équipe, cloisonnement', async () => {
  const ws = await workspace(ctx.dev, 'MCP');
  // Script du serveur déposé dans le workspace (les arguments sont limités à 500 caractères).
  const b64 = Buffer.from(ECHO_SERVER).toString('base64');
  await bashViaPi(ctx.dev, ws.id, `echo ${b64} | base64 -d > /workspace/mcp-echo.cjs && node --check /workspace/mcp-echo.cjs && echo pret`);
  const name = `echo_${uid().toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const created = await ctx.admin.post('/mcp-servers', { name, description: 'écho de test', scope: 'global', transport: 'stdio', command: 'node', args: ['/workspace/mcp-echo.cjs'], secretEnv: { ECHO_SECRET: 'valeur-secrete-mcp' } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const srv = created.body.id;
  assert.equal((await ctx.admin.put(`/mcp-servers/${srv}/tools`, { tools: [{ name: 'echo', description: 'Écho', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] })).status, 200);
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
  assert.match(done.data.output, /echo:bonjour:secret-ok/);

  // Interdiction pour l'équipe : l'outil n'est plus proposé à Pi et l'appel est refusé.
  assert.equal((await ctx.admin.put(`/mcp-servers/${srv}/permissions`, { toolName: 'echo', scope: 'team', teamId: ctx.teamId, effect: 'deny' })).status, 200);
  done = await callEcho();
  assert.equal(done.data.isError, true, JSON.stringify(done.data));
  assert.doesNotMatch(done.data.output, /echo:bonjour/);
  const effective = (await ctx.dev.get(`/mcp-servers?teamId=${ctx.teamId}`)).body.find((s) => s.id === srv).tools[0].effective;
  assert.equal(effective, 'denied');
  // Un membre ne peut pas lever l'interdiction d'équipe ni poser une règle globale.
  assert.equal((await ctx.dev.put(`/mcp-servers/${srv}/permissions`, { toolName: 'echo', scope: 'team', teamId: ctx.teamId, effect: 'allow' })).status, 403);
  assert.equal((await ctx.dev.put(`/mcp-servers/${srv}/permissions`, { toolName: 'echo', scope: 'global', effect: 'allow' })).status, 403);

  // Serveur d'une autre équipe : invisible (liste, règles, permissions).
  const slug = `mcp-${uid()}`;
  const otherTeam = await ctx.admin.post('/teams', { name: `MCP ${slug}`, slug });
  const hidden = await ctx.admin.post('/mcp-servers', { name: `${name}_x`, scope: 'team', teamId: otherTeam.body.id, transport: 'stdio', command: 'node', args: ['/workspace/mcp-echo.cjs'] });
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

test('utilisateur de plusieurs équipes : quota de l’équipe propriétaire du projet, rôles distincts par équipe', async () => {
  const mk = async (label) => {
    const slug = `${label}-${uid()}`;
    const t = await ctx.admin.post('/teams', { name: `${label} ${slug}`, slug });
    assert.equal(t.status, 201);
    return t.body.id;
  };
  const teamA = await mk('equipe-a');
  const teamB = await mk('equipe-b');
  const teamC = await mk('equipe-c');
  const user = await newUser(); // membre de l'équipe de test
  assert.equal((await ctx.admin.post(`/teams/${teamA}/members`, { userId: user.id, role: 'member' })).status, 204);
  assert.equal((await ctx.admin.post(`/teams/${teamB}/members`, { userId: user.id, role: 'team_admin' })).status, 204);
  const project = async (teamId) => {
    const p = await user.post('/projects', { teamId, name: `P ${uid()}` });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    const w = await user.post('/workspaces', { projectId: p.body.id, name: 'Multi-équipes' });
    opened.push({ client: user, id: w.body.id });
    return { project: p.body, ws: w.body };
  };
  const a = await project(teamA);
  const b = await project(teamB);
  // Équipe hors appartenance : ni création ni lecture.
  // 404 : l'existence d'une équipe dont on n'est pas membre n'est pas révélée.
  assert.ok([403, 404].includes((await user.post('/projects', { teamId: teamC, name: 'Interdit' })).status));
  assert.ok(!(await user.get('/projects')).body.some((p) => p.teamId === teamC));
  // Rôles par équipe : administrateur de B (gère les membres), simple membre de A.
  const other = await newUser();
  assert.equal((await user.post(`/teams/${teamB}/members`, { userId: other.id, role: 'member' })).status, 204);
  assert.equal((await user.post(`/teams/${teamA}/members`, { userId: other.id, role: 'member' })).status, 403);

  // Plafond de l'équipe A épuisé : le run du projet A est suspendu, celui du projet B passe.
  assert.equal((await ctx.admin.put('/admin/quotas/policies', { scope: 'team', subjectId: teamA, limit5h: '0.001', limit7d: null, exempt: false })).status, 200);
  try {
    const conv = await user.get(`/workspaces/${a.ws.id}/conversation`);
    const sentA = await user.post(`/workspaces/${a.ws.id}/messages`, { text: 'Projet A' }, { 'Idempotency-Key': `f-${uid()}` });
    if (sentA.status === 201) {
      const ev = await user.events(a.ws.id, conv.body.lastEventId, (e) => e.runId === sentA.body.runId && ['quota.paused', 'run.completed', 'run.failed'].includes(e.type), 300_000);
      assert.equal(ev.at(-1).type, 'quota.paused', JSON.stringify(ev.at(-1)));
      assert.match(ev.at(-1).data.window, /team/);
      await user.post(`/workspaces/${a.ws.id}/runs/${sentA.body.runId}/interrupt`);
    } else {
      assert.equal(sentA.body.error.code, 'quota_exceeded', JSON.stringify(sentA.body));
    }
    await run(user, b.ws.id, 'Projet B');
  } finally {
    await ctx.admin.put('/admin/quotas/policies', { scope: 'team', subjectId: teamA, limit5h: null, limit7d: null, exempt: false });
  }
});
