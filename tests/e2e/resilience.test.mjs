// Résilience (SPEC §25 n°6 et n°16) sur la pile Compose réelle : pannes d'une instance API,
// du worker, du stockage S3, de LiteLLM et de Vault pendant l'activité — sans corruption,
// sans exécution en double, avec reprise automatique au retour du service.
// Les tests arrêtent puis redémarrent des conteneurs : à lancer seuls (pas en parallèle).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { BASE, Client, adminClient, uid } from './client.mjs';

const STATE_FILE = new URL('./.e2e-state.json', import.meta.url);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const ctx = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const health = (name) => docker('inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', name);
async function waitHealthy(name, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (['healthy', 'running'].includes(health(name))) return;
    await sleep(2000);
  }
  throw new Error(`${name} non rétabli`);
}
function sql(query) {
  return docker('exec', '-i', 'cap-postgres-1', 'psql', '-U', 'cap', '-d', 'cap', '-tAc', query);
}

/**
 * Lecteur SSE qui se reconnecte comme EventSource (Last-Event-ID) : renvoie tous les événements
 * reçus et le nombre de reconnexions, jusqu'à `until`.
 */
async function resilientEvents(client, wsId, fromId, until, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  const seen = [];
  let last = fromId;
  let reconnects = -1;
  while (Date.now() < end) {
    reconnects++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(1, end - Date.now()));
    try {
      const res = await fetch(`${BASE}/api/v1/workspaces/${wsId}/events`, {
        headers: { Cookie: [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; '), Accept: 'text/event-stream', 'Last-Event-ID': String(last) },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`SSE ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          if (!data) continue;
          const e = JSON.parse(data);
          seen.push(e);
          last = e.id;
          if (until(e)) return { events: seen, reconnects };
        }
      }
    } catch {
      /* coupure : reconnexion */
    } finally {
      clearTimeout(timer);
      ctrl.abort();
    }
    await sleep(1000);
  }
  throw new Error(`SSE : condition non atteinte (${seen.map((e) => e.type).join(',')})`);
}

async function newUser() {
  const username = `r${uid()}`;
  const password = 'Resilience-Password-123456';
  const r = await ctx.admin.post('/admin/users', { email: `${username}@example.test`, username, displayName: `R ${username}`, platformRole: 'user', password });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = new Client();
  assert.equal((await c.post('/auth/login', { login: username, password })).body.status, 'authenticated');
  c.id = r.body.id;
  return c;
}

async function workspace(client, name) {
  const w = await client.post('/workspaces', { name });
  assert.equal(w.status, 201, JSON.stringify(w.body));
  return w.body;
}

async function send(client, wsId, text) {
  const conv = await client.get(`/workspaces/${wsId}/conversation`);
  const sent = await client.post(`/workspaces/${wsId}/messages`, { text }, { 'Idempotency-Key': `r-${uid()}` });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  return { runId: sent.body.runId, from: conv.body.lastEventId };
}

const terminal = (runId) => (e) => ['run.completed', 'run.failed', 'run.interrupted'].includes(e.type) && e.runId === runId;
const tool = (name, args) => `[[tool:${name} ${JSON.stringify(args)}]]`;

before(async () => {
  ctx.admin = await adminClient(state);
});

after(async () => {
  // Filet de sécurité : tous les services redémarrés.
  for (const c of ['cap-api-1', 'cap-api-2', 'cap-worker-1', 'cap-garage-1', 'cap-litellm-1', 'cap-vault-1']) {
    if (health(c) === 'exited') docker('start', c);
  }
});

test('deux instances API : arrêt brutal de chacune pendant un run, SSE repris sans trou ni doublon, run unique', async () => {
  const user = await newUser();
  const ws = await workspace(user, 'Deux API');
  // Run d'environ 2 min (6 outils, 7 réponses du modèle factice à 15 s) : il doit couvrir les deux
  // arrêts et le redémarrage de la première instance (~1 min), quelle que soit l'instance du flux SSE.
  const steps = [1, 2, 3, 4, 5, 6].map((i) => tool('bash', { command: `echo etape-${i} >> journal.txt` })).join(' ');
  const { runId, from } = await send(user, ws.id, `Travail long. [[sleep:15000]] ${steps}`);
  const reading = resilientEvents(user, ws.id, from, terminal(runId), 300_000);

  for (const victim of ['cap-api-1', 'cap-api-2']) {
    await sleep(4000);
    docker('kill', victim);
    // L'autre instance sert toutes les requêtes (même session, sans affinité).
    for (let i = 0; i < 10; i++) {
      const r = await user.get(`/workspaces/${ws.id}/conversation`);
      assert.equal(r.status, 200, `requête ${i} pendant l'arrêt de ${victim} : ${r.status}`);
    }
    docker('start', victim);
    await waitHealthy(victim);
  }

  const { events, reconnects } = await reading;
  assert.ok(reconnects >= 1, 'le flux SSE a bien été coupé au moins une fois');
  const ids = events.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'aucun événement en double');
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], 'ordre strictement croissant');
  // Aucun trou : identique à une relecture complète depuis la base.
  const replay = await user.events(ws.id, from, terminal(runId), 60_000);
  assert.deepEqual(ids, replay.map((e) => e.id), 'flux reconnecté = relecture complète');
  assert.equal(events.filter((e) => e.type === 'run.started' && e.runId === runId).length, 1, 'un seul démarrage du run');
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  assert.equal(events.filter((e) => e.type === 'tool.completed').length, 6, 'chaque outil exécuté une seule fois');
  assert.equal(sql(`select count(*) from agent_runs where workspace_id = '${ws.id}'`), '1');
  await user.post(`/workspaces/${ws.id}/stop`);
});

test('perte du worker pendant un run : run interrompu proprement, pas de double exécution, workspace réutilisable', async () => {
  const user = await newUser();
  const ws = await workspace(user, 'Panne worker');
  const { runId, from } = await send(user, ws.id, `Écris puis attends. [[sleep:6000]] ${tool('bash', { command: 'echo avant > avant.txt' })} ${tool('bash', { command: 'echo apres > apres.txt' })}`);
  // Arrêt brutal juste après le checkpoint de la première écriture.
  await user.events(ws.id, from, (e) => e.type === 'checkpoint.completed' && e.runId === runId, 240_000);
  docker('kill', 'cap-worker-1');
  await sleep(3000);
  docker('start', 'cap-worker-1');
  // Bail du run (60 s) expiré → reprise par le worker redémarré.
  const { events } = await resilientEvents(user, ws.id, from, terminal(runId), 240_000);
  const end = events.at(-1);
  assert.equal(end.type, 'run.interrupted', JSON.stringify(end));
  assert.match(end.data.reason, /worker/);
  assert.equal(events.filter((e) => terminal(runId)(e)).length, 1, 'un seul état final');
  // Pas de réexécution de l'outil déjà fait ; l'écriture confirmée est conservée.
  assert.equal(sql(`select count(*) from tool_calls where run_id = '${runId}' and args::text like '%avant.txt%'`), '1');
  const file = await user.get(`/workspaces/${ws.id}/files/content?path=avant.txt`);
  assert.equal(file.body.content, 'avant\n');
  // Le workspace reste utilisable (sandbox adoptée ou relancée, Pi orphelin arrêté).
  const next = await send(user, ws.id, `Reprends. ${tool('bash', { command: 'cat avant.txt; ls' })}`);
  const after = await user.events(ws.id, next.from, terminal(next.runId), 300_000);
  assert.equal(after.at(-1).type, 'run.completed', JSON.stringify(after.at(-1)));
  assert.match(after.find((e) => e.type === 'tool.completed').data.output, /avant/);
  await user.post(`/workspaces/${ws.id}/stop`);
});

test('panne du stockage S3 : checkpoint jamais annoncé réussi, workspace « non synchronisé », reprise automatique', async () => {
  const user = await newUser();
  const ws = await workspace(user, 'Panne S3');
  // Sandbox démarrée et premier checkpoint confirmé avant la panne.
  const first = await send(user, ws.id, `Init. ${tool('bash', { command: 'echo init > init.txt' })}`);
  await user.events(ws.id, first.from, terminal(first.runId), 300_000);
  docker('stop', 'cap-garage-1');
  try {
    const { runId, from } = await send(user, ws.id, `Écris pendant la panne. ${tool('bash', { command: 'echo pendant-panne > panne.txt' })}`);
    const events = await user.events(ws.id, from, (e) => e.type === 'checkpoint.failed' || (e.type === 'checkpoint.completed' && e.runId === runId), 240_000);
    assert.equal(events.at(-1).type, 'checkpoint.failed', 'aucun checkpoint réussi annoncé pendant la panne');
    await user.events(ws.id, from, terminal(runId), 240_000);
    const w = await user.get(`/workspaces/${ws.id}`);
    assert.equal(w.body.syncState, 'unsynced', JSON.stringify(w.body));
    // Lecture impossible pendant la panne : erreur explicite, jamais de contenu erroné.
    const read = await user.get(`/workspaces/${ws.id}/files/content?path=panne.txt`);
    assert.equal(read.status, 503, JSON.stringify(read.body));
    assert.equal(read.body.error.code, 'storage_unavailable');
  } finally {
    docker('start', 'cap-garage-1');
  }
  // Reprise automatique (tâche « unsynced », toutes les minutes) : synchronisé, fichier confirmé.
  const end = Date.now() + 180_000;
  let synced = false;
  while (Date.now() < end && !synced) {
    await sleep(5000);
    synced = (await user.get(`/workspaces/${ws.id}`)).body.syncState === 'synced';
  }
  assert.ok(synced, 'workspace resynchronisé après le retour de S3');
  assert.equal((await user.get(`/workspaces/${ws.id}/files/content?path=panne.txt`)).body.content, 'pendant-panne\n');
  await user.post(`/workspaces/${ws.id}/stop`);
});

test('panne de LiteLLM : run en échec explicite, aucune réservation de crédits laissée ouverte, reprise au retour', async () => {
  const user = await newUser();
  const ws = await workspace(user, 'Panne LiteLLM');
  docker('stop', 'cap-litellm-1');
  try {
    const { runId, from } = await send(user, ws.id, 'Bonjour pendant la panne');
    const events = await user.events(ws.id, from, terminal(runId), 420_000);
    const end = events.at(-1);
    assert.equal(end.type, 'run.failed', JSON.stringify(end));
    assert.ok(end.data.error && !/App Error|undefined/.test(end.data.error), `message explicite : ${end.data.error}`);
    // Aucune facturation, aucune réservation ouverte.
    assert.equal(sql(`select count(*) from credit_reservations where user_id = '${user.id}' and status = 'open'`), '0');
    assert.equal(sql(`select coalesce(sum(amount), 0)::text from credit_ledger where user_id = '${user.id}' and kind = 'usage'`).replace(/\.0+$/, ''), '0');
  } finally {
    docker('start', 'cap-litellm-1');
  }
  await waitHealthy('cap-litellm-1');
  const ok = await send(user, ws.id, 'Bonjour après la panne');
  const events = await user.events(ws.id, ok.from, terminal(ok.runId), 300_000);
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  await user.post(`/workspaces/${ws.id}/stop`);
});

test('panne de Vault : sessions et lecture préservées, écritures de secrets refusées en 503, déverrouillage et reprise automatiques', async () => {
  const user = await newUser();
  docker('stop', 'cap-vault-1');
  try {
    // Les sessions sont en base : la navigation continue.
    assert.equal((await user.get('/auth/session')).body.authenticated, true);
    assert.equal((await user.get('/workspaces')).status, 200);
    // Santé : Vault signalé indisponible.
    const ready = await fetch(`${BASE}/api/v1/health/ready`);
    assert.equal(ready.status, 503);
    // Écriture d'un secret (SMTP) : refus propre, aucune modification partielle.
    const smtp = await ctx.admin.put('/admin/smtp', { host: 'mailpit', port: 1025, secure: false, fromAddress: 'noreply@example.test', fromName: 'CAP' });
    assert.equal(smtp.status, 503, JSON.stringify(smtp.body));
    assert.equal(smtp.body.error.code, 'secret_backend_unavailable');
  } finally {
    docker('start', 'cap-vault-1');
  }
  // Vault redémarre scellé ; le service de déverrouillage le rouvre, puis tout reprend.
  const end = Date.now() + 180_000;
  let ok = false;
  while (Date.now() < end && !ok) {
    await sleep(3000);
    ok = (await fetch(`${BASE}/api/v1/health/ready`)).status === 200;
  }
  assert.ok(ok, 'plateforme de nouveau prête');
  const smtp = await ctx.admin.put('/admin/smtp', { host: 'mailpit', port: 1025, secure: false, fromAddress: 'noreply@example.test', fromName: 'CAP' });
  assert.equal(smtp.status, 200, JSON.stringify(smtp.body));
  const ws = await workspace(user, 'Après Vault');
  const r = await send(user, ws.id, 'Bonjour après Vault');
  const events = await user.events(ws.id, r.from, terminal(r.runId), 300_000);
  assert.equal(events.at(-1).type, 'run.completed', JSON.stringify(events.at(-1)));
  await user.post(`/workspaces/${ws.id}/stop`);
});
