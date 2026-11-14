// Modes de déverrouillage de Vault en production (docs/operations/vault.md), sur des Vault jetables :
// - manual : clés chiffrées pour les clés PGP des opérateurs, rien en clair sur l'hôte, jeton root révoqué ;
// - auto   : déverrouillage par un service de clés (transit d'un autre Vault), y compris après redémarrage.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const VAULT_IMAGE = 'hashicorp/vault:2.2.2';
const NODE_IMAGE = 'node:26-bookworm-slim';
const BOOTSTRAP = resolve(new URL('../../infrastructure/docker/bootstrap', import.meta.url).pathname);
const id = Math.random().toString(36).slice(2, 8);
const NET = `cap-vt-${id}`;
const dir = mkdtempSync(join(tmpdir(), 'cap-vault-modes-'));
chmodSync(dir, 0o755); // lisible par l'utilisateur `vault` des conteneurs
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const containers = [];

const VAULT_HCL = `ui = false
disable_mlock = true
storage "raft" {
  path    = "/vault/file"
  node_id = "n1"
}
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}
api_addr     = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"
`;

function startVault(name, configDir, env = {}) {
  containers.push(name);
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  docker('run', '-d', '--name', name, '--network', NET, '--cap-add', 'IPC_LOCK', '-e', 'VAULT_ADDR=http://127.0.0.1:8200', ...envArgs, '-v', `${configDir}:/vault/config:ro`, VAULT_IMAGE, 'server');
}

function status(name) {
  try {
    return JSON.parse(docker('exec', name, 'vault', 'status', '-format=json'));
  } catch (e) {
    return JSON.parse(e.stdout); // code 2 quand scellé
  }
}

async function waitFor(fn, what, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      /* réessai */
    }
    if (Date.now() > end) throw new Error(`délai dépassé : ${what}`);
    await sleep(1000);
  }
}

function bootstrap(name, vault, secrets, env, detach = false) {
  containers.push(name);
  const envArgs = Object.entries({ VAULT_ADDR: `http://${vault}:8200`, SECRETS_DIR: '/secrets', BOOTSTRAP_ONLY_VAULT: '1', ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  return docker('run', ...(detach ? ['-d'] : []), '--name', name, '--network', NET, ...envArgs, '-v', `${BOOTSTRAP}:/bootstrap:ro`, '-v', `${secrets}:/secrets`, NODE_IMAGE, 'node', '/bootstrap/bootstrap.mjs');
}

let DOCKER = true;
try {
  docker('image', 'inspect', VAULT_IMAGE);
  docker('image', 'inspect', NODE_IMAGE);
} catch {
  DOCKER = false;
}
const t = DOCKER ? test : test.skip;

before(() => {
  if (DOCKER) docker('network', 'create', NET);
});

after(() => {
  for (const c of containers) {
    try {
      docker('rm', '-f', c);
    } catch {
      /* déjà supprimé */
    }
  }
  try {
    docker('network', 'rm', NET);
  } catch {
    /* absent */
  }
  // Fichiers créés en root par les conteneurs : suppression via un conteneur.
  try {
    docker('run', '--rm', '-v', `${dir}:/d`, NODE_IMAGE, 'sh', '-c', 'rm -rf /d/*');
  } catch {
    /* ignoré */
  }
  rmSync(dir, { recursive: true, force: true });
});

t('mode manual : clés chiffrées pour 3 opérateurs (seuil 2), rien en clair, jeton root révoqué, pas de déverrouillage automatique', async () => {
  const conf = join(dir, 'manual-conf');
  const secrets = join(dir, 'manual-secrets');
  const gnupg = join(dir, 'gnupg');
  mkdirSync(conf);
  mkdirSync(join(secrets, 'vault-pgp'), { recursive: true });
  mkdirSync(gnupg, { mode: 0o700 });
  writeFileSync(join(conf, 'vault.hcl'), VAULT_HCL);
  const gpg = (...args) => execFileSync('gpg', ['--homedir', gnupg, '--batch', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  for (const op of ['alice', 'bob', 'carol']) {
    gpg('--passphrase', '', '--quick-gen-key', `${op}@example.test`, 'rsa2048', 'encr', '1d');
    writeFileSync(join(secrets, 'vault-pgp', `${op}.asc`), gpg('--armor', '--export', `${op}@example.test`));
  }
  startVault(`vt-manual-${id}`, conf);
  await waitFor(() => status(`vt-manual-${id}`).type, 'Vault manual démarré');

  // L'amorçage attend le déverrouillage humain.
  bootstrap(`vt-boot-manual-${id}`, `vt-manual-${id}`, secrets, { VAULT_UNSEAL_MODE: 'manual', VAULT_KEY_THRESHOLD: '2' }, true);
  const keysFile = join(secrets, 'vault-unseal-keys.pgp.json');
  await waitFor(() => existsSync(keysFile), 'clés chiffrées écrites');
  const keys = JSON.parse(readFileSync(keysFile, 'utf8'));
  assert.equal(keys['clés de déverrouillage'].length, 3);
  assert.equal(keys.threshold, 2);
  assert.ok(!existsSync(join(secrets, 'vault-init.json')), 'aucun fichier de clés en clair');
  assert.ok(!readdirSync(secrets).some((f) => f.includes('A-RETIRER')), 'aucune clé en clair');
  assert.equal(status(`vt-manual-${id}`).sealed, true, 'Vault reste scellé sans les opérateurs');

  // Deux opérateurs déchiffrent leur part et déverrouillent.
  for (const i of [0, 2]) {
    const share = execFileSync('gpg', ['--homedir', gnupg, '--batch', '--quiet', '--decrypt'], { input: Buffer.from(keys['clés de déverrouillage'][i], 'base64'), encoding: 'utf8' }).trim();
    docker('exec', `vt-manual-${id}`, 'vault', 'operator', 'unseal', share);
  }
  assert.equal(status(`vt-manual-${id}`).sealed, false);
  await waitFor(() => docker('inspect', '-f', '{{.State.Status}}', `vt-boot-manual-${id}`) === 'exited', 'fin de l’amorçage', 120_000);
  const logs = docker('logs', `vt-boot-manual-${id}`);
  assert.equal(docker('inspect', '-f', '{{.State.ExitCode}}', `vt-boot-manual-${id}`), '0', logs);
  assert.match(logs, /Jeton root révoqué/);
  for (const svc of ['api', 'worker', 'gateway', 'preview']) assert.ok(existsSync(join(secrets, 'approle', svc, 'secret_id')), `AppRole ${svc}`);

  // Une identité de service fonctionne ; le surveillant ne déverrouille rien après un redémarrage.
  const login = docker('exec', `vt-manual-${id}`, 'sh', '-c', `vault write -format=json auth/approle/login role_id=$(cat <<'X'\n${readFileSync(join(secrets, 'approle/worker/role_id'), 'utf8')}\nX\n) secret_id=$(cat <<'X'\n${readFileSync(join(secrets, 'approle/worker/secret_id'), 'utf8')}\nX\n)`);
  assert.ok(JSON.parse(login).auth.client_token);
  docker('restart', `vt-manual-${id}`);
  await waitFor(() => status(`vt-manual-${id}`).type, 'redémarrage');
  // Une nouvelle exécution sans jeton d'administration conserve la configuration.
  const again = bootstrap(`vt-boot-manual2-${id}`, `vt-manual-${id}`, secrets, { VAULT_UNSEAL_MODE: 'manual', WATCH_UNSEAL: '0' }, true);
  void again;
  await sleep(3000);
  assert.equal(status(`vt-manual-${id}`).sealed, true, 'aucun déverrouillage automatique en mode manual');
});

t('mode auto (transit) : déverrouillage par le service de clés, y compris après redémarrage ; clés de récupération chiffrées', async () => {
  // Service de clés : un Vault de développement avec le moteur transit.
  containers.push(`vt-kms-${id}`);
  docker('run', '-d', '--name', `vt-kms-${id}`, '--network', NET, '--cap-add', 'IPC_LOCK', '-e', 'VAULT_DEV_ROOT_TOKEN_ID=kms-root', '-e', 'VAULT_ADDR=http://127.0.0.1:8200', VAULT_IMAGE, 'server', '-dev', '-dev-listen-address=0.0.0.0:8200');
  await waitFor(() => docker('exec', '-e', 'VAULT_TOKEN=kms-root', `vt-kms-${id}`, 'vault', 'status').includes('Sealed'), 'KMS démarré');
  docker('exec', '-e', 'VAULT_TOKEN=kms-root', `vt-kms-${id}`, 'vault', 'secrets', 'enable', 'transit');
  docker('exec', '-e', 'VAULT_TOKEN=kms-root', `vt-kms-${id}`, 'vault', 'write', '-f', 'transit/keys/cap-unseal');

  const conf = join(dir, 'auto-conf');
  const secrets = join(dir, 'auto-secrets');
  mkdirSync(conf);
  mkdirSync(join(secrets, 'vault-pgp'), { recursive: true });
  writeFileSync(join(conf, 'vault.hcl'), VAULT_HCL);
  writeFileSync(join(conf, 'seal.hcl'), `seal "transit" {\n  address    = "http://vt-kms-${id}:8200"\n  key_name   = "cap-unseal"\n  mount_path = "transit/"\n}\n`);
  for (const op of ['alice', 'bob']) writeFileSync(join(secrets, 'vault-pgp', `${op}.asc`), readFileSync(join(dir, 'manual-secrets', 'vault-pgp', `${op}.asc`)));
  startVault(`vt-auto-${id}`, conf, { VAULT_TOKEN: 'kms-root' });
  await waitFor(() => status(`vt-auto-${id}`).type, 'Vault auto démarré');

  bootstrap(`vt-boot-auto-${id}`, `vt-auto-${id}`, secrets, { VAULT_UNSEAL_MODE: 'auto' });
  const logs = docker('logs', `vt-boot-auto-${id}`);
  assert.match(logs, /clés de récupération/);
  assert.match(logs, /Jeton root révoqué/);
  const rec = JSON.parse(readFileSync(join(secrets, 'vault-recovery-keys.pgp.json'), 'utf8'));
  assert.equal(rec['clés de récupération'].length, 2);
  assert.ok(!existsSync(join(secrets, 'vault-init.json')));
  assert.equal(status(`vt-auto-${id}`).sealed, false);
  assert.equal(status(`vt-auto-${id}`).type, 'transit');

  docker('restart', `vt-auto-${id}`);
  await waitFor(() => status(`vt-auto-${id}`).sealed === false, 'déverrouillage automatique après redémarrage');
});
