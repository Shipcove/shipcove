// Parcours fonctionnels complémentaires (SPEC §25) sur la pile Compose réelle :
// édition manuelle et conflits (n°9), skills/MCP (n°13), pièces jointes, notifications, rétention (n°15).
// Prérequis : pile démarrée, modèle par défaut créé (stack.test.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Client, adminClient, uid } from './client.mjs';

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

async function workspace(client, name) {
  const p = await client.post('/projects', { teamId: ctx.teamId, name: `${name} ${uid()}` });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  const w = await client.post('/workspaces', { projectId: p.body.id, name });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  return w.body;
}

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
