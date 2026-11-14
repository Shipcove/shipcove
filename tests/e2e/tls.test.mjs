// Point d'entrée TLS (profil Compose « tls », Caddy) avec l'autorité locale de Caddy à la place
// d'ACME : application en HTTPS (HSTS, flux non tamponnés), certificats de preview émis à la demande
// uniquement pour une preview ouverte (vérifié par la plateforme).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const COMPOSE_DIR = new URL('../../infrastructure/docker/', import.meta.url).pathname;
const PORT = 18443;
const APP = 'app.cap.test';
const PREVIEW_DOMAIN = process.env.CAP_PREVIEW_DOMAIN ?? 'preview.localhost';
const env = { ...process.env, CAP_DOMAIN: APP, CAP_TLS_ISSUER: 'internal', CAP_TLS_BIND: '127.0.0.1', CAP_TLS_HTTPS_PORT: String(PORT), CAP_TLS_HTTP_PORT: '18481' };
const compose = (...args) => execFileSync('docker', ['compose', '--profile', 'tls', ...args], { cwd: COMPOSE_DIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sql = (q) => execFileSync('docker', ['exec', '-i', 'cap-postgres-1', 'psql', '-U', 'cap', '-d', 'cap', '-tAc', q], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let UP = true;
try {
  execFileSync('docker', ['inspect', 'cap-preview-1'], { stdio: 'ignore' });
} catch {
  UP = false;
}
const t = UP ? test : test.skip;
let ca = '';
let previewId = null;
let previewHost = '';

before(async () => {
  if (!UP) return;
  compose('up', '-d', '--no-deps', 'edge');
  for (let i = 0; i < 30 && !ca; i++) {
    await sleep(1000);
    try {
      ca = compose('exec', '-T', 'edge', 'cat', '/data/caddy/pki/authorities/local/root.crt');
    } catch {
      /* autorité pas encore créée */
    }
  }
  assert.ok(ca.includes('BEGIN CERTIFICATE'), 'autorité locale de Caddy');
  const ws = sql(`select id from workspaces where deleted_at is null order by created_at desc limit 1`);
  assert.ok(ws, 'un workspace existe (suite stack exécutée avant)');
  previewId = sql(`insert into preview_ports (workspace_id, port) values ('${ws}', 4777) returning id`).split('\n')[0];
  previewHost = `4777-${ws.replaceAll('-', '')}.${PREVIEW_DOMAIN}`;
});

after(() => {
  if (!UP) return;
  if (previewId) sql(`delete from preview_ports where id = '${previewId}'`);
  try {
    compose('rm', '-sf', 'edge');
  } catch {
    /* ignoré */
  }
});

function get(host, path = '/') {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: PORT, servername: host, path, headers: { Host: host }, ca, timeout: 20_000, agent: false }, (res) => {
      const cert = res.socket.getPeerCertificate();
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, cert }));
    });
    req.on('error', reject);
    req.end();
  });
}

t('application servie en HTTPS par le point d’entrée TLS (HSTS)', async () => {
  const r = await get(APP, '/api/v1/health/live');
  assert.equal(r.status, 200);
  assert.match(r.headers['strict-transport-security'] ?? '', /max-age=31536000/);
  assert.equal(r.headers.server, undefined);
  assert.ok(r.cert.subjectaltname.includes(APP), r.cert.subjectaltname);
});

t('preview ouverte : certificat émis à la demande ; nom inconnu : aucun certificat', async () => {
  const r = await get(previewHost);
  // La passerelle de preview répond (accès refusé sans jeton) : le TLS a abouti avec un certificat valide.
  assert.ok([401, 403, 503].includes(r.status), String(r.status));
  assert.ok(r.cert.subjectaltname.includes(previewHost), 'certificat propre à cette preview');
  const unknown = `4777-${randomBytes(16).toString('hex')}.${PREVIEW_DOMAIN}`;
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        const s = tls.connect({ host: '127.0.0.1', port: PORT, servername: unknown, ca }, () => (s.end(), resolve()));
        s.on('error', reject);
      }),
    'aucun certificat pour une preview inexistante',
  );
});
