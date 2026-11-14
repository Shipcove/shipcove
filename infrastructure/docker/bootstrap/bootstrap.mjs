#!/usr/bin/env node
// Amorçage idempotent de l'infrastructure Docker Compose :
//  1. Vault : initialisation, descellement, KV v2 `cap/`, audit, politiques minimales, AppRoles.
//  2. Garage : buckets `cap-workspaces` et `cap-attachments`, clé d'accès dédiée.
//  3. Secrets d'infrastructure écrits dans Vault (S3, LiteLLM, clé de signature des previews).
// Aucun secret n'est affiché sur la sortie standard.
import { mkdir, readFile, writeFile, chmod, chown, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const VAULT = process.env.VAULT_ADDR ?? 'http://vault:8200';
const GARAGE_ADMIN = process.env.GARAGE_ADMIN_URL ?? 'http://garage:3903';
const SECRETS = process.env.SECRETS_DIR ?? '/secrets';
/**
 * Déverrouillage de Vault (docs/operations/vault.md) :
 * - `file`   : clés et jeton root dans .secrets/vault-init.json, déverrouillage automatique
 *              (développement, recette) ;
 * - `manual` : clés réparties entre opérateurs (chiffrées pour leurs clés PGP), déverrouillage
 *              humain (scripts/vault-unseal.sh), jeton root révoqué après l'amorçage ;
 * - `auto`   : déverrouillage par un service de clés (KMS, transit) configuré dans vault/seal.env ;
 *              clés de récupération chiffrées pour les opérateurs, jeton root révoqué.
 */
const MODE = process.env.VAULT_UNSEAL_MODE || 'file';
if (!['file', 'manual', 'auto'].includes(MODE)) throw new Error(`VAULT_UNSEAL_MODE inconnu : ${MODE}`);
const SHARES = Number(process.env.VAULT_KEY_SHARES ?? (MODE === 'file' ? 1 : 5));
const THRESHOLD = Number(process.env.VAULT_KEY_THRESHOLD ?? (MODE === 'file' ? 1 : 3));
const BUCKETS = (process.env.S3_BUCKETS ?? 'cap-workspaces,cap-attachments').split(',');
const SERVICES = ['api', 'worker', 'gateway', 'preview'];
// Propriétaire des fichiers d'identité (utilisateur `node` des images applicatives).
const OWNER_UID = Number(process.env.SECRETS_UID ?? 1000);
const OWNER_GID = Number(process.env.SECRETS_GID ?? 1000);

const log = (m) => console.log(`[bootstrap] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);
const readSecret = async (name) => (await readFile(`${SECRETS}/${name}`, 'utf8')).trim();
async function writeSecretFile(path, content) {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
  await chown(path, OWNER_UID, OWNER_GID).catch(() => undefined);
}

async function http(method, url, { token, body, headers = {}, okStatuses = [] } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { 'X-Vault-Token': token } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok && !okStatuses.includes(res.status)) {
    throw new Error(`${method} ${url.replace(/\/\/[^/]+/, '//…')} → HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  try {
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  } catch {
    return { status: res.status, json: {} };
  }
}

async function waitFor(name, fn, attempts = 90) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (await fn()) return;
    } catch {
      /* retry */
    }
    await sleep(2000);
  }
  throw new Error(`${name} indisponible`);
}

/* ------------------------------- Vault ------------------------------- */

const POLICIES = {
  // L'API gère la configuration (fournisseurs d'identité, connexions Git, MCP, modèles, SMTP, MFA).
  api: `
path "cap/data/auth-providers/*"   { capabilities = ["create","update","read","delete"] }
path "cap/metadata/auth-providers/*" { capabilities = ["read","delete"] }
path "cap/data/git-connections/*"  { capabilities = ["create","update","read","delete"] }
path "cap/metadata/git-connections/*" { capabilities = ["read","delete"] }
path "cap/data/oauth-apps/*"       { capabilities = ["create","update","read","delete"] }
path "cap/metadata/oauth-apps/*"   { capabilities = ["read","delete"] }
path "cap/data/mcp/*"              { capabilities = ["create","update","read","delete"] }
path "cap/metadata/mcp/*"          { capabilities = ["read","delete"] }
path "cap/data/env/*"              { capabilities = ["create","update","read","delete"] }
path "cap/metadata/env/*"          { capabilities = ["read","delete"] }
path "cap/data/models/*"           { capabilities = ["create","update","read","delete"] }
path "cap/metadata/models/*"       { capabilities = ["read","delete"] }
path "cap/data/mfa/*"              { capabilities = ["create","update","read","delete"] }
path "cap/metadata/mfa/*"          { capabilities = ["read","delete"] }
path "cap/data/infra/smtp"         { capabilities = ["create","update","read"] }
path "cap/metadata/infra/smtp"     { capabilities = ["read"] }
path "cap/data/infra/s3"           { capabilities = ["read"] }
path "cap/metadata/infra/*"        { capabilities = ["read"] }
path "cap/data/infra/litellm"      { capabilities = ["read"] }
path "cap/data/infra/preview"      { capabilities = ["read"] }
path "cap/data/infra/session"      { capabilities = ["read"] }
path "sys/health"                  { capabilities = ["read"] }
`,
  // Le worker exécute les opérations Git approuvées, envoie les emails, gère les checkpoints.
  worker: `
path "cap/data/env/*"              { capabilities = ["read"] }
path "cap/data/git-connections/*"  { capabilities = ["read","update"] }
path "cap/data/oauth-apps/*"       { capabilities = ["read"] }
path "cap/data/mcp/*"              { capabilities = ["read"] }
path "cap/data/infra/smtp"         { capabilities = ["read"] }
path "cap/data/infra/s3"           { capabilities = ["read"] }
path "cap/data/infra/litellm"      { capabilities = ["read"] }
`,
  // La gateway relaie vers LiteLLM et lit les dépôts (lecture seule) pour les sandboxes ; elle
  // renouvelle un jeton OAuth expiré (écriture du jeton, lecture du secret de l'application).
  gateway: `
path "cap/data/infra/litellm"      { capabilities = ["read"] }
path "cap/data/infra/forge-ca"     { capabilities = ["create","read","update"] }
path "cap/data/git-connections/*"  { capabilities = ["read","update"] }
path "cap/data/oauth-apps/*"       { capabilities = ["read"] }
path "cap/data/mcp/*"              { capabilities = ["read"] }
path "cap/data/env/*"              { capabilities = ["read"] }
`,
  preview: `
path "cap/data/infra/preview"      { capabilities = ["read"] }
`,
};

/** Clés publiques PGP des opérateurs (.secrets/vault-pgp/*.asc, armure ASCII) → base64 attendu par Vault. */
async function operatorPgpKeys() {
  const dir = `${SECRETS}/vault-pgp`;
  if (!(await exists(dir))) return [];
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.asc')).sort();
  const keys = [];
  for (const f of files) {
    const armored = await readFile(`${dir}/${f}`, 'utf8');
    const body = armored
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('-----') && !/^[A-Za-z-]+: /.test(l) && !l.startsWith('='))
      .join('');
    if (!body) throw new Error(`clé PGP illisible : ${f}`);
    keys.push(body);
  }
  return keys;
}

async function adminToken() {
  if (process.env.VAULT_TOKEN) return process.env.VAULT_TOKEN;
  if (process.env.VAULT_TOKEN_FILE) return (await readFile(process.env.VAULT_TOKEN_FILE, 'utf8')).trim();
  return null;
}

/** Renvoie un jeton d'administration et indique s'il faut le révoquer à la fin (jeton root éphémère). */
async function bootstrapVault() {
  await waitFor('Vault', async () => (await fetch(`${VAULT}/v1/sys/health?uninitcode=200&sealedcode=200&standbyok=true`)).ok);
  const initFile = `${SECRETS}/vault-init.json`;
  const { json: init } = await http('GET', `${VAULT}/v1/sys/init`);
  let token = null;
  let ephemeral = false;
  if (!init.initialized) {
    log(`Initialisation de Vault (mode ${MODE})…`);
    const pgp = MODE === 'file' ? [] : await operatorPgpKeys();
    const shares = pgp.length || SHARES;
    const threshold = Math.min(THRESHOLD, shares);
    const body =
      MODE === 'auto'
        ? { recovery_shares: shares, recovery_threshold: threshold, ...(pgp.length ? { recovery_pgp_keys: pgp } : {}) }
        : { secret_shares: shares, secret_threshold: threshold, ...(pgp.length ? { pgp_keys: pgp } : {}) };
    const { json } = await http('PUT', `${VAULT}/v1/sys/init`, { body });
    if (MODE === 'file') {
      await writeSecretFile(initFile, JSON.stringify({ keys_base64: json.keys_base64, root_token: json.root_token }, null, 2));
      log(`Vault initialisé (${shares} part(s), seuil ${threshold}). Clés écrites dans .secrets/vault-init.json`);
    } else {
      const keys = MODE === 'auto' ? json.recovery_keys_base64 : json.keys_base64;
      const label = MODE === 'auto' ? 'clés de récupération' : 'clés de déverrouillage';
      // Clés chiffrées pour chaque opérateur (PGP) : sans valeur pour qui détient l'hôte.
      // Sans clés PGP, elles sont écrites UNE fois en clair et doivent quitter l'hôte immédiatement.
      const out = pgp.length ? `${SECRETS}/vault-${MODE === 'auto' ? 'recovery' : 'unseal'}-keys.pgp.json` : `${SECRETS}/vault-keys-A-RETIRER-DE-L-HOTE.json`;
      await writeSecretFile(out, JSON.stringify({ [label]: keys, threshold, operators: pgp.length || null }, null, 2));
      log(`Vault initialisé : ${shares} ${label} (seuil ${threshold}) → ${out.replace(SECRETS, '.secrets')}`);
      if (!pgp.length) log('ATTENTION : clés en clair. Remettez-les à leurs détenteurs puis supprimez ce fichier de l’hôte.');
      token = json.root_token;
      ephemeral = true;
    }
  }

  const { json: seal } = await http('GET', `${VAULT}/v1/sys/seal-status`);
  if (seal.sealed) {
    if (MODE === 'file') {
      const initData = JSON.parse(await readFile(initFile, 'utf8'));
      log('Descellement de Vault…');
      for (const key of initData.keys_base64.slice(0, THRESHOLD)) await http('PUT', `${VAULT}/v1/sys/unseal`, { body: { key } });
    } else if (MODE === 'manual') {
      log('Vault est scellé : déverrouillez-le (infrastructure/docker/scripts/vault-unseal.sh, seuil de clés requis). En attente…');
    }
  }
  await waitFor('Vault actif', async () => (await fetch(`${VAULT}/v1/sys/health`)).status === 200, MODE === 'file' ? 90 : 720);

  if (!token) token = MODE === 'file' ? JSON.parse(await readFile(initFile, 'utf8')).root_token : await adminToken();
  if (!token) {
    // Mode production après l'initialisation : sans jeton d'administration, la configuration
    // existante est conservée (politiques à jour seulement si un opérateur fournit VAULT_TOKEN).
    const ready = await Promise.all(SERVICES.map((svc) => exists(`${SECRETS}/approle/${svc}/secret_id`)));
    if (ready.every(Boolean)) {
      log('Aucun jeton d’administration (VAULT_TOKEN) : politiques et secrets inchangés.');
      return { token: null, ephemeral: false };
    }
    throw new Error('Identités des services absentes et aucun jeton d’administration : fournissez VAULT_TOKEN (voir docs/operations/vault.md).');
  }

  const { json: mounts } = await http('GET', `${VAULT}/v1/sys/mounts`, { token });
  if (!mounts['cap/']) {
    await http('POST', `${VAULT}/v1/sys/mounts/cap`, { token, body: { type: 'kv', options: { version: '2' }, description: 'Shipcove' } });
    log('KV v2 monté sur cap/');
  }
  const { json: audits } = await http('GET', `${VAULT}/v1/sys/audit`, { token });
  if (!audits['file/']) {
    await http('PUT', `${VAULT}/v1/sys/audit/file`, { token, body: { type: 'file', options: { file_path: '/vault/logs/audit.log' } } });
    log('Audit Vault activé');
  }
  const { json: auths } = await http('GET', `${VAULT}/v1/sys/auth`, { token });
  if (!auths['approle/']) {
    await http('POST', `${VAULT}/v1/sys/auth/approle`, { token, body: { type: 'approle' } });
    log('AppRole activé');
  }
  for (const svc of SERVICES) {
    await http('PUT', `${VAULT}/v1/sys/policies/acl/cap-${svc}`, { token, body: { policy: POLICIES[svc] } });
    await http('POST', `${VAULT}/v1/auth/approle/role/cap-${svc}`, {
      token,
      body: { token_policies: [`cap-${svc}`], token_ttl: '1h', token_max_ttl: '24h', secret_id_ttl: '0', token_type: 'service' },
    });
    const dir = `${SECRETS}/approle/${svc}`;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chown(`${SECRETS}/approle`, OWNER_UID, OWNER_GID).catch(() => undefined);
    await chown(dir, OWNER_UID, OWNER_GID).catch(() => undefined);
    for (const f of ['role_id', 'secret_id']) await chown(`${dir}/${f}`, OWNER_UID, OWNER_GID).catch(() => undefined);
    if (!(await exists(`${dir}/secret_id`))) {
      const { json: rid } = await http('GET', `${VAULT}/v1/auth/approle/role/cap-${svc}/role-id`, { token });
      const { json: sid } = await http('POST', `${VAULT}/v1/auth/approle/role/cap-${svc}/secret-id`, { token, body: {} });
      await writeSecretFile(`${dir}/role_id`, rid.data.role_id);
      await writeSecretFile(`${dir}/secret_id`, sid.data.secret_id);
      log(`AppRole cap-${svc} créé`);
    }
  }
  return { token, ephemeral };
}

async function putIfAbsent(token, path, data) {
  const { status } = await http('GET', `${VAULT}/v1/cap/data/${path}`, { token, okStatuses: [404] });
  if (status === 404) {
    await http('POST', `${VAULT}/v1/cap/data/${path}`, { token, body: { data } });
    log(`Secret ${path} écrit dans Vault`);
  }
}

/* ------------------------------- Garage ------------------------------ */

async function bootstrapGarage() {
  const adminToken = await readSecret('garage_admin_token');
  const accessKeyId = await readSecret('s3_access_key_id');
  const secretAccessKey = await readSecret('s3_secret_access_key');
  const h = { Authorization: `Bearer ${adminToken}` };
  await waitFor('Garage', async () => (await fetch(`${GARAGE_ADMIN}/v2/GetClusterStatus`, { headers: h })).ok);

  // Disposition du cluster (nœud unique) si nécessaire.
  const { json: layout } = await http('GET', `${GARAGE_ADMIN}/v2/GetClusterLayout`, { headers: h });
  if (!layout.roles || layout.roles.length === 0) {
    const { json: status } = await http('GET', `${GARAGE_ADMIN}/v2/GetClusterStatus`, { headers: h });
    const nodeId = status.nodes[0].id;
    await http('POST', `${GARAGE_ADMIN}/v2/UpdateClusterLayout`, {
      headers: h,
      body: { roles: [{ id: nodeId, zone: 'dc1', capacity: Number(process.env.GARAGE_CAPACITY_BYTES ?? 100 * 1024 ** 3), tags: [] }] },
    });
    const { json: staged } = await http('GET', `${GARAGE_ADMIN}/v2/GetClusterLayout`, { headers: h });
    await http('POST', `${GARAGE_ADMIN}/v2/ApplyClusterLayout`, { headers: h, body: { version: staged.version + 1 } });
    log('Layout Garage appliqué');
  }

  const { status: keyStatus } = await http('GET', `${GARAGE_ADMIN}/v2/GetKeyInfo?id=${accessKeyId}`, { headers: h, okStatuses: [400, 404] });
  if (keyStatus !== 200) {
    await http('POST', `${GARAGE_ADMIN}/v2/ImportKey`, { headers: h, body: { accessKeyId, secretAccessKey, name: 'cap-platform' } });
    log('Clé S3 importée');
  }
  for (const bucket of BUCKETS) {
    let { status, json } = await http('GET', `${GARAGE_ADMIN}/v2/GetBucketInfo?globalAlias=${bucket}`, { headers: h, okStatuses: [400, 404] });
    if (status !== 200) {
      ({ json } = await http('POST', `${GARAGE_ADMIN}/v2/CreateBucket`, { headers: h, body: { globalAlias: bucket } }));
      log(`Bucket ${bucket} créé`);
    }
    await http('POST', `${GARAGE_ADMIN}/v2/AllowBucketKey`, {
      headers: h,
      body: { bucketId: json.id, accessKeyId, permissions: { read: true, write: true, owner: false } },
    });
  }
  return { accessKeyId, secretAccessKey };
}

/* -------------------------------- Main ------------------------------- */

// Surveillance seule (conteneur vault-unsealer) hors mode `file` : aucun jeton, aucune clé.
if (process.env.WATCH_UNSEAL === '1' && MODE !== 'file') {
  log(`Mode ${MODE} : aucun déverrouillage automatique par la plateforme ; surveillance de l’état seulement.`);
  for (;;) {
    try {
      const { json } = await http('GET', `${VAULT}/v1/sys/seal-status`);
      if (json.sealed) log(MODE === 'manual' ? 'Vault est scellé : scripts/vault-unseal.sh' : 'Vault est scellé : vérifiez le service de clés (vault/seal.env)');
    } catch (err) {
      log(`surveillance : ${err.message}`);
    }
    await sleep(60000);
  }
}

const { token, ephemeral } = await bootstrapVault();
await chown(`${SECRETS}/vault-init.json`, OWNER_UID, OWNER_GID).catch(() => undefined);
// BOOTSTRAP_ONLY_VAULT : tests des modes de déverrouillage, sans stockage objet.
const s3 = process.env.BOOTSTRAP_ONLY_VAULT === '1' ? null : await bootstrapGarage();
if (token && s3) {
  await putIfAbsent(token, 'infra/s3', s3);
  await putIfAbsent(token, 'infra/litellm', { masterKey: await readSecret('litellm_master_key') });
  await putIfAbsent(token, 'infra/preview', { key: randomBytes(32).toString('base64url') });
  await putIfAbsent(token, 'infra/session', { key: randomBytes(32).toString('base64url') });
}
if (ephemeral) {
  // Le jeton root n'a servi qu'à l'amorçage : il n'existe plus nulle part.
  await http('POST', `${VAULT}/v1/auth/token/revoke-self`, { token });
  log('Jeton root révoqué (régénérable par les détenteurs des clés : vault operator generate-root).');
}
log('Amorçage terminé.');

// Mode surveillance (mode `file`) : redescelle Vault après un redémarrage.
if (process.env.WATCH_UNSEAL === '1') {
  log('Surveillance du scellement de Vault active');
  for (;;) {
    await sleep(15000);
    try {
      const { json } = await http('GET', `${VAULT}/v1/sys/seal-status`);
      if (json.sealed) {
        const initData = JSON.parse(await readFile(`${SECRETS}/vault-init.json`, 'utf8'));
        for (const key of initData.keys_base64.slice(0, THRESHOLD)) await http('PUT', `${VAULT}/v1/sys/unseal`, { body: { key } });
        log('Vault redescellé');
      }
    } catch (err) {
      log(`surveillance : ${err.message}`);
    }
  }
}
