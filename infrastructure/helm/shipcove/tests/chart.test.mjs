// Tests du chart (node --test infrastructure/helm/shipcove/tests/) : cohérence des politiques Vault
// avec l'amorçage Docker Compose, rendu du chart (helm requis) et garde-fous de sécurité.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const CHART = new URL('..', import.meta.url).pathname;
const ROOT = new URL('../../../..', import.meta.url).pathname;
const hasHelm = spawnSync('helm', ['version'], { stdio: 'ignore' }).status === 0;

test('politiques Vault identiques à celles de l’amorçage Docker Compose', () => {
  const src = readFileSync(`${ROOT}/infrastructure/docker/bootstrap/bootstrap.mjs`, 'utf8');
  const block = src.slice(src.indexOf('const POLICIES = {'), src.indexOf('\n};', src.indexOf('const POLICIES = {')));
  const compose = Object.fromEntries([...block.matchAll(/\n {2}(\w+): `([\s\S]*?)`/g)].map((m) => [m[1], m[2].trim()]));
  const chart = JSON.parse(readFileSync(`${CHART}/files/vault-policies.json`, 'utf8'));
  assert.deepEqual(Object.fromEntries(Object.entries(chart).map(([k, v]) => [k, v.trim()])), compose);
});

const render = (...sets) => execFileSync('helm', ['template', 't', CHART, ...sets.flatMap((s) => ['--set', s])], { encoding: 'utf8' });
const docs = (yaml) => yaml.split(/^---$/m).filter((d) => /^kind:/m.test(d));
const kind = (yaml, k, name) => docs(yaml).find((d) => new RegExp(`^kind: ${k}$`, 'm').test(d) && (!name || d.includes(`name: ${name}`)));

test('helm lint', { skip: !hasHelm }, () => {
  execFileSync('helm', ['lint', CHART, '--strict'], { stdio: 'pipe' });
});

test('rendu par défaut : sandboxes isolées, aucun conteneur privilégié, jetons non montés', { skip: !hasHelm }, () => {
  const out = render();
  assert.ok(kind(out, 'NetworkPolicy', 'shipcove-default-deny'), 'deny-all du namespace des sandboxes');
  assert.ok(kind(out, 'NetworkPolicy', 'shipcove-sandbox-egress'));
  assert.ok(kind(out, 'NetworkPolicy', 'shipcove-sandbox-ingress'));
  assert.doesNotMatch(out, /privileged: true/);
  assert.doesNotMatch(out, /allowPrivilegeEscalation: true/);
  const web = kind(out, 'Deployment', 't-shipcove-web');
  assert.match(web, /automountServiceAccountToken: false/);
  // Droits du worker : namespace des sandboxes seulement, jamais de ClusterRole.
  assert.ok(!docs(out).some((d) => /^kind: ClusterRole$/m.test(d)));
  assert.match(kind(out, 'Role', 't-shipcove-worker'), /namespace: shipcove-sandboxes/);
  // Migrations avant les services.
  assert.match(kind(out, 'Job', 't-shipcove-migrate'), /helm.sh\/hook: pre-install,pre-upgrade/);
});

test('Vault : authentification Kubernetes par défaut, AppRole possible', { skip: !hasHelm }, () => {
  assert.match(kind(render(), 'Deployment', 't-shipcove-api'), /name: VAULT_K8S_ROLE\s+value: "cap-api"/);
  const approle = render('vault.authMethod=approle', 'vault.approle.existingSecret=ar');
  const api = kind(approle, 'Deployment', 't-shipcove-api');
  assert.match(api, /VAULT_ROLE_ID_FILE/);
  assert.match(api, /key: api-role-id/);
});

test('configuration de Vault : jeton requis, revue des jetons par un compte dédié', { skip: !hasHelm }, () => {
  const r = spawnSync('helm', ['template', 't', CHART, '--set', 'vaultSetup.enabled=true'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /vaultSetup.tokenSecret est requis/);
  const out = render('vaultSetup.enabled=true', 'vaultSetup.tokenSecret=vt');
  assert.match(kind(out, 'ClusterRoleBinding'), /system:auth-delegator/);
  assert.match(kind(out, 'Job', 't-shipcove-vault-setup'), /\\"serviceAccount\\":\\"t-shipcove-worker\\"/);
});

test('NetworkPolicies désactivables (avertissement dans les notes)', { skip: !hasHelm }, () => {
  const out = render('networkPolicies.enabled=false');
  assert.ok(!kind(out, 'NetworkPolicy'));
});
