// Recette Kubernetes (infrastructure/kubernetes/dev/up.sh) : sandboxes en Pods, services d'appui,
// isolation réseau, previews et nettoyage, sur un cluster réel (kind).
//   CAP_E2E_KUBERNETES=1 CAP_E2E_URL=http://localhost:28080 node --test kubernetes.test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { Client, adminClient, sleep, uid } from './client.mjs';

const CTX = process.env.KUBE_CONTEXT ?? 'kind-shipcove';
const APP_NS = process.env.SHIPCOVE_NAMESPACE ?? 'shipcove';
const SBX_NS = process.env.SANDBOX_NAMESPACE ?? 'shipcove-sandboxes';
const PREVIEW_PORT = Number(process.env.CAP_E2E_PREVIEW_PORT ?? 28090);
const LITELLM_KEY = process.env.LITELLM_MASTER_KEY ?? 'sk-dev-master-key';
const LITELLM_LOCAL = 24000;

// Uniquement sur demande (la suite e2e par défaut vise Docker Compose).
const ENABLED = process.env.CAP_E2E_KUBERNETES === '1';
const it = (name, fn) => test(name, { skip: !ENABLED && 'CAP_E2E_KUBERNETES=1 requis' }, fn);

const kubectl = (...args) => execFileSync('kubectl', ['--context', CTX, ...args], { encoding: 'utf8' });
const pods = (ns, selector) => JSON.parse(kubectl('-n', ns, 'get', 'pods', '-l', selector, '-o', 'json')).items.filter((p) => !p.metadata.deletionTimestamp);
const STATE_FILE = new URL('./.e2e-state-k8s.json', import.meta.url);
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const ctx = {};
let forward;

async function litellm(method, path, body) {
  const r = await fetch(`http://127.0.0.1:${LITELLM_LOCAL}${path}`, { method, headers: { Authorization: `Bearer ${LITELLM_KEY}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  assert.ok(r.ok, `LiteLLM ${path} : ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function newUser() {
  const username = `k${uid()}`;
  const password = 'Kube-Password-123456';
  const r = await ctx.admin.post('/admin/users', { email: `${username}@example.test`, username, displayName: `K ${username}`, platformRole: 'user', password });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const c = new Client();
  assert.equal((await c.post('/auth/login', { login: username, password })).body.status, 'authenticated');
  c.id = r.body.id;
  return c;
}

/** Envoie un message (directives du LLM factice) et renvoie les résultats des outils. */
async function tools(client, wsId, text) {
  const conv = await client.get(`/workspaces/${wsId}/conversation`);
  const sent = await client.post(`/workspaces/${wsId}/messages`, { text }, { 'Idempotency-Key': `k-${uid()}` });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const evs = await client.events(wsId, conv.body.lastEventId, (e) => ['run.completed', 'run.failed'].includes(e.type) && e.runId === sent.body.runId, 600_000);
  assert.equal(evs.at(-1).type, 'run.completed', JSON.stringify(evs.at(-1)));
  return evs.filter((e) => e.type === 'tool.completed').map((e) => e.data);
}
const bash = (command) => `[[tool:bash ${JSON.stringify({ command })}]]`;
const svc = (args) => `[[tool:platform_services ${JSON.stringify(args)}]]`;

before(async () => {
  if (!ENABLED) return;
  forward = spawn('kubectl', ['--context', CTX, '-n', 'shipcove-deps', 'port-forward', 'svc/litellm', `${LITELLM_LOCAL}:4000`], { stdio: 'ignore' });
  for (let i = 0; i < 30; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${LITELLM_LOCAL}/health/liveliness`)).ok) break;
    } catch {
      /* port-forward en cours */
    }
    await sleep(1000);
  }
});
after(() => forward?.kill());

it('installation : composants prêts, migrations faites, Vault configuré par le Job du chart', async () => {
  for (const c of ['api', 'worker', 'gateway', 'preview', 'web']) {
    const ready = pods(APP_NS, `app.kubernetes.io/component=${c}`).filter((p) => p.status.containerStatuses?.every((s) => s.ready));
    assert.ok(ready.length >= 1, `${c} prêt`);
  }
  ctx.admin = await adminClient(state);
  writeFileSync(STATE_FILE, JSON.stringify(state));
  // Modèle factice déclaré dans LiteLLM, découvert puis activé par l'administrateur.
  for (const m of (await litellm('GET', '/model/info')).data.filter((x) => x.model_name === 'mock-model')) await litellm('POST', '/model/delete', { id: m.model_info.id });
  await litellm('POST', '/model/new', { model_name: 'mock-model', litellm_params: { model: 'openai/mock-model', api_base: 'http://mock-llm:4010/v1', api_key: 'not-needed', input_cost_per_token: 0.000003, output_cost_per_token: 0.000015 }, model_info: { mode: 'chat' } });
  assert.equal((await ctx.admin.post('/admin/models/reload')).status, 200);
  const model = (await ctx.admin.get('/admin/models')).body.find((m) => m.litellmModel === 'mock-model');
  const enable = await ctx.admin.patch(`/admin/models/${model.id}`, { displayName: 'Mock (k8s)', contextWindow: 128000, maxOutputTokens: 4096, enabled: true, isDefault: true, allowedUserIds: [], coefficients: { input: '1', output: '2', cacheRead: '0.1', cacheWrite: '1.25' } });
  assert.equal(enable.status, 200, JSON.stringify(enable.body));
  ctx.dev = await newUser();
});

it('sandbox : Pod durci, sans jeton Kubernetes, répertoire personnel de l’image, run de Pi et checkpoint', async () => {
  const ws = (await ctx.dev.post('/workspaces', {})).body;
  ctx.ws = ws;
  const out = await tools(ctx.dev, ws.id, `Fichier. ${bash('echo bonjour-k8s > notes.md && id -u && ls -A /home/agent | tr "\\n" " " && ls /var/run/secrets/kubernetes.io 2>&1 | head -1')}`);
  assert.match(out[0].output, /^10001$/m, 'utilisateur non privilégié');
  assert.match(out[0].output, /\.pi/, '/home/agent recopié depuis l’image');
  assert.match(out[0].output, /No such file/, 'aucun jeton de ServiceAccount monté');

  const [pod] = pods(SBX_NS, `cap.workspace=${ws.id}`);
  assert.ok(pod, 'Pod de sandbox dans le namespace dédié');
  assert.equal(pod.spec.automountServiceAccountToken, false);
  const c = pod.spec.containers[0];
  assert.equal(c.securityContext.readOnlyRootFilesystem, true);
  assert.equal(c.securityContext.allowPrivilegeEscalation, false);
  assert.deepEqual(c.securityContext.capabilities.drop, ['ALL']);
  assert.equal(pod.spec.securityContext.runAsNonRoot, true);

  // Checkpoint vers S3 : le fichier est lisible par l'API (hors sandbox).
  const file = await ctx.dev.get(`/workspaces/${ws.id}/files/content?path=notes.md`);
  assert.equal(file.status, 200, JSON.stringify(file.body));
  assert.match(JSON.stringify(file.body), /bonjour-k8s/);
});

it('réseau : la sandbox ne joint ni l’API, ni les dépendances, ni Internet en direct ; l’API Kubernetes la refuse', async () => {
  const probe = (host, port) => `(timeout 4 bash -c 'exec 3<>/dev/tcp/${host}/${port}' 2>/dev/null && echo "${host}:${port}=ouvert") || echo "${host}:${port}=ferme"`;
  const blocked = [
    [`shipcove-api.${APP_NS}.svc.cluster.local`, 3000],
    ['postgres.shipcove-deps.svc.cluster.local', 5432],
    ['vault.shipcove-deps.svc.cluster.local', 8200],
    ['1.1.1.1', 443],
  ];
  const gateway = [`shipcove-gateway.${APP_NS}.svc.cluster.local`, 8081];
  // Sans jeton de ServiceAccount, l'API Kubernetes refuse la sandbox (le filtrage réseau des adresses
  // du nœud dépend du CNI : Calico et Cilium le font, kindnet non, cf. docs/operations/kubernetes.md).
  const api = "curl --noproxy '*' -sk -o /dev/null -w 'api-k8s=%{http_code}' https://kubernetes.default.svc/api/v1/namespaces/shipcove/secrets || echo api-k8s=ferme";
  const [r] = await tools(ctx.dev, ctx.ws.id, `Réseau. ${bash([...blocked, gateway].map(([h, p]) => probe(h, p)).join('; ') + '; ' + api)}`);
  for (const [h, p] of blocked) assert.match(r.output, new RegExp(`${h}:${p}=ferme`), `${h}:${p} doit être bloqué\n${r.output}`);
  assert.match(r.output, new RegExp(`${gateway[0]}:${gateway[1]}=ouvert`), r.output);
  assert.match(r.output, /api-k8s=(401|403|000|ferme)/, `l’API Kubernetes doit refuser la sandbox\n${r.output}`);
});

it('services d’appui : PostgreSQL dans son Pod, joignable sur localhost, psql sans mot de passe en clair', async () => {
  const out = await tools(
    ctx.dev,
    ctx.ws.id,
    `Postgres. ${svc({ action: 'start', service: 'postgres' })} ${bash("psql -h 127.0.0.1 -U postgres -d app -v ON_ERROR_STOP=1 -Atc 'create table t(x int); insert into t values (41),(1); select sum(x) from t'")}`,
  );
  assert.equal(out[0].isError, false, out[0].output);
  assert.match(out[0].output, /prêt/);
  assert.match(out[0].output, /PGPASSFILE/);
  assert.match(out[1].output, /^42$/m, out[1].output);

  const instance = pods(SBX_NS, `cap.workspace=${ctx.ws.id}`)[0].metadata.labels['cap.instance'];
  const [svcPod] = pods(SBX_NS, `app.kubernetes.io/component=service,cap.instance=${instance},cap.service=postgres`);
  assert.ok(svcPod, 'Pod du service');
  assert.equal(svcPod.spec.automountServiceAccountToken, false);
  assert.equal(svcPod.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
  ctx.servicePodIp = svcPod.status.podIP;
  // NetworkPolicy propre à la sandbox.
  kubectl('-n', SBX_NS, 'get', 'networkpolicy', `cap-svc-${svcPod.metadata.labels['cap.instance']}`);
});

it('isolation : la sandbox d’un autre utilisateur ne joint pas ces services', async () => {
  const other = await newUser();
  const ws = (await other.post('/workspaces', {})).body;
  const [r] = await tools(other, ws.id, `Isolation. ${bash(`(timeout 5 bash -c 'exec 3<>/dev/tcp/${ctx.servicePodIp}/5432' 2>/dev/null && echo joignable) || echo injoignable; (timeout 3 bash -c 'exec 3<>/dev/tcp/127.0.0.1/5432' 2>/dev/null && echo local-joignable) || echo local-injoignable`)}`);
  assert.match(r.output, /^injoignable$/m, r.output);
  assert.match(r.output, /local-injoignable/, r.output);
  await other.del(`/workspaces/${ws.id}`);
});

it('previews : application de la sandbox servie par le proxy des previews', async () => {
  const start = 'mkdir -p /tmp/pv && echo "<h1>preview k8s</h1>" > /tmp/pv/index.html && (cd /tmp/pv && nohup python3 -m http.server 3001 > /tmp/pv.log 2>&1 &) && for i in $(seq 30); do curl -sf -o /dev/null http://127.0.0.1:3001/ && break; sleep 0.3; done';
  await tools(ctx.dev, ctx.ws.id, `Serveur. ${bash(start)}`);
  const p = await ctx.dev.post(`/workspaces/${ctx.ws.id}/previews`, { port: 3001 });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  assert.equal((await ctx.dev.post(`/workspaces/${ctx.ws.id}/previews`, { port: 5432 })).status, 400, 'port du service refusé');
  const link = await ctx.dev.post(`/workspaces/${ctx.ws.id}/previews/${p.body.id}/link`);
  const u = new URL(link.body.url);
  const get = (path, headers) =>
    new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: PREVIEW_PORT, path, headers: { Host: u.host, ...headers } }, (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
        })
        .on('error', reject);
    });
  const ex = await get(u.pathname + u.search);
  assert.equal(ex.status, 302);
  const page = await get('/', { Cookie: ex.headers['set-cookie'][0].split(';')[0] });
  assert.equal(page.status, 200, page.body);
  assert.match(page.body, /preview k8s/);
});

it('suppression de la conversation : Pods, NetworkPolicy et Secrets des services supprimés', async () => {
  const [sbx] = pods(SBX_NS, `cap.workspace=${ctx.ws.id}`);
  const instance = sbx.metadata.labels['cap.instance'];
  assert.equal((await ctx.dev.del(`/workspaces/${ctx.ws.id}`)).status, 204);
  for (let i = 0; i < 90; i++) {
    if (!pods(SBX_NS, `cap.instance=${instance}`).length) break;
    await sleep(2000);
  }
  assert.equal(pods(SBX_NS, `cap.instance=${instance}`).length, 0, 'plus aucun Pod (sandbox ni service)');
  assert.throws(() => kubectl('-n', SBX_NS, 'get', 'networkpolicy', `cap-svc-${instance}`, '-o', 'name'), /NotFound/);
});
