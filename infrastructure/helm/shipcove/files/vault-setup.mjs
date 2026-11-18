// Configuration de Vault pour Shipcove sur Kubernetes (Job du chart, idempotent) :
//  1. montage KV v2 de la plateforme ;
//  2. politiques de chaque composant (mêmes droits que l'amorçage Docker Compose) ;
//  3. méthode d'authentification `kubernetes` et un rôle par composant, lié à son ServiceAccount ;
//  4. secrets d'infrastructure absents : clés de signature générées, identifiants S3 / LiteLLM fournis.
// Le jeton d'administration n'est utilisé que par ce Job ; il n'est jamais transmis aux composants.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const env = process.env;
const VAULT = env.VAULT_ADDR.replace(/\/$/, '');
const TOKEN = env.VAULT_TOKEN;
const MOUNT = env.VAULT_KV_MOUNT || 'cap';
const log = (m) => console.log(`[vault-setup] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, path, body, okStatuses = []) {
  const headers = { 'X-Vault-Token': TOKEN, 'Content-Type': 'application/json' };
  if (env.VAULT_NAMESPACE) headers['X-Vault-Namespace'] = env.VAULT_NAMESPACE;
  const res = await fetch(`${VAULT}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Lecture d'un fichier monté (Secret), attendue jusqu'à ce qu'il soit renseigné. */
async function readMounted(file, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (existsSync(file)) {
      const v = readFileSync(file, 'utf8').trim();
      if (v) return v;
    }
    await sleep(2000);
  }
  throw new Error(`${file} vide ou absent`);
}

for (let i = 0; ; i++) {
  try {
    const r = await fetch(`${VAULT}/v1/sys/health?standbyok=true`);
    if (r.status === 200 || r.status === 429) break;
  } catch {
    /* nouvelle tentative */
  }
  if (i > 90) throw new Error('Vault injoignable ou scellé');
  await sleep(2000);
}

// 1. Montage KV v2.
const { json: mounts } = await http('GET', '/v1/sys/mounts');
if (!mounts[`${MOUNT}/`] && !mounts.data?.[`${MOUNT}/`]) {
  await http('POST', `/v1/sys/mounts/${MOUNT}`, { type: 'kv', options: { version: '2' } });
  log(`montage ${MOUNT}/ créé (KV v2)`);
}

// 2. Politiques (chemins écrits pour le montage « cap »).
const policies = JSON.parse(readFileSync(env.POLICIES_FILE, 'utf8'));
for (const [svc, hcl] of Object.entries(policies)) {
  const text = MOUNT === 'cap' ? hcl : hcl.replaceAll('"cap/', `"${MOUNT}/`);
  await http('PUT', `/v1/sys/policies/acl/cap-${svc}`, { policy: text });
}
log(`politiques : ${Object.keys(policies).map((s) => `cap-${s}`).join(', ')}`);

// 3. Authentification Kubernetes.
if (env.K8S_AUTH_CONFIGURE === 'true') {
  const { json: auths } = await http('GET', '/v1/sys/auth');
  if (!auths['kubernetes/'] && !auths.data?.['kubernetes/']) {
    await http('POST', '/v1/sys/auth/kubernetes', { type: 'kubernetes' });
    log('méthode kubernetes activée');
  }
  const reviewer = await readMounted(env.REVIEWER_TOKEN_FILE);
  const ca = await readMounted(env.REVIEWER_CA_FILE);
  await http('POST', '/v1/auth/kubernetes/config', { kubernetes_host: env.K8S_HOST, kubernetes_ca_cert: ca, token_reviewer_jwt: reviewer, disable_local_ca_jwt: true });
  const roles = JSON.parse(env.ROLES);
  for (const [svc, r] of Object.entries(roles)) {
    await http('POST', `/v1/auth/kubernetes/role/${r.role}`, {
      bound_service_account_names: [r.serviceAccount],
      bound_service_account_namespaces: [env.RELEASE_NAMESPACE],
      token_policies: [`cap-${svc}`],
      token_ttl: env.TOKEN_TTL || '1h',
      token_max_ttl: '24h',
    });
  }
  log(`rôles kubernetes : ${Object.values(roles).map((r) => r.role).join(', ')}`);
}

// 4. Secrets d'infrastructure manquants.
async function putIfAbsent(path, data) {
  const { status } = await http('GET', `/v1/${MOUNT}/data/${path}`, undefined, [404]);
  if (status === 404) {
    await http('POST', `/v1/${MOUNT}/data/${path}`, { data });
    log(`secret ${path} écrit`);
  }
}
await putIfAbsent('infra/preview', { key: randomBytes(32).toString('base64url') });
await putIfAbsent('infra/session', { key: randomBytes(32).toString('base64url') });
const infra = env.INFRA_DIR;
if (infra && existsSync(`${infra}/s3-access-key-id`)) {
  await putIfAbsent('infra/s3', { accessKeyId: readFileSync(`${infra}/s3-access-key-id`, 'utf8').trim(), secretAccessKey: readFileSync(`${infra}/s3-secret-access-key`, 'utf8').trim() });
}
if (infra && existsSync(`${infra}/litellm-master-key`)) {
  await putIfAbsent('infra/litellm', { masterKey: readFileSync(`${infra}/litellm-master-key`, 'utf8').trim() });
}
log('terminé');
