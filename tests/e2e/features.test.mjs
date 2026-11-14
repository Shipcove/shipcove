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
