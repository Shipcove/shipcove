import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ForgeCaService } from './forge-ca.service.js';
import { ForgeProxyService } from './forge-proxy.service.js';

const RUN_TOKEN = 'cap_rt_' + 'x'.repeat(32);
const REAL = 'gho_REALTOKEN_never_in_sandbox';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const pkt = (s: string) => (s.length + 4).toString(16).padStart(4, '0') + s;

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('proxy des forges (interception TLS)', () => {
  let ca: ForgeCaService;
  let forge: ForgeProxyService;
  let upstream: https.Server;
  let plainUpstream: http.Server;
  let proxy: http.Server;
  const seen: Seen[] = [];
  const audits: unknown[] = [];

  beforeAll(async () => {
    const store = new Map<string, Record<string, string>>();
    const secrets = {
      reference: (p: string) => p,
      read: async (p: string) => {
        const v = store.get(p);
        if (!v) throw new Error('absent');
        return v;
      },
      write: async (p: string, d: Record<string, string>) => (store.set(p, d), p),
    };
    const db = { transaction: async (fn: (tx: unknown) => unknown) => fn({ execute: async () => undefined }) };
    ca = new ForgeCaService(db as never, secrets as never);
    await ca.onModuleInit();

    // Forge factice : HTTPS avec des certificats émis par la même autorité.
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url?.includes('info/refs?service=git-receive-pack')) {
          const adv = pkt('# service=git-receive-pack\n') + '0000' + pkt(`${A} refs/heads/main\0report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta push-options object-format=sha1 agent=git/2.50.0\n`) + '0000';
          return void res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement' }).end(adv);
        }
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') });
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
      });
    };
    upstream = https.createServer({ SNICallback: (name, cb) => void ca.contextFor(name).then((ctx) => cb(null, ctx), (e: Error) => cb(e)) }, handler);
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    plainUpstream = http.createServer(handler);
    await new Promise<void>((r) => plainUpstream.listen(0, '127.0.0.1', () => r()));

    const tokens = {
      authenticate: async (h: string) => (h === `Bearer ${RUN_TOKEN}` ? { tokenId: 't', workspaceId: 'w', userId: 'u', teamId: 'tm', runId: 'r', runStatus: 'running' } : null),
    };
    const git = {
      token: async () => REAL,
      // Délai réaliste : la requête se termine pendant l'appel à la forge.
      branchFacts: async () => (await new Promise((r) => setTimeout(r, 300)), { defaultBranch: 'main', protectedBranches: new Set<string>() }),
      assertTransport: async () => undefined,
    };
    const audit = { record: async (e: unknown) => void audits.push(e) };
    const env = { EGRESS_BLOCK_PRIVATE: true };
    forge = new ForgeProxyService(env as never, {} as never, tokens as never, git as never, ca, audit as never);
    Object.assign(forge, {
      selfHosted: async () => new Map([['forge.test:8929', { family: 'gitlab', connHost: 'forge.test:8929' }]]),
      connection: async () => ({ id: 'c1', provider: 'github', host: 'github.com' }),
    });
    forge.upstreamOverride = { address: '127.0.0.1', port: (upstream.address() as AddressInfo).port, ca: ca.certificatePem };

    proxy = http.createServer((req, res) => {
      const url = new URL(req.url ?? '');
      void forge.match(url.hostname, Number(url.port || 80), false).then(async (t) => {
        if (!t) return void res.writeHead(403).end();
        const saved = forge.upstreamOverride;
        forge.upstreamOverride = { address: '127.0.0.1', port: (plainUpstream.address() as AddressInfo).port };
        await forge.handlePlain(req, res, t, `${url.pathname}${url.search}`);
        forge.upstreamOverride = saved;
      });
    });
    proxy.on('connect', (req, socket, head) => {
      const [host, port] = (req.url ?? '').split(':');
      void forge.match(host, Number(port), true).then(async (t) => {
        if (t) await forge.intercept(socket as net.Socket, head, t);
        else socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      });
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
  });

  afterAll(async () => {
    proxy?.close();
    plainUpstream?.close();
    upstream?.close();
  });

  /** Requête HTTPS via CONNECT, en vérifiant le certificat avec l'autorité des forges (comme la sandbox). */
  async function request(host: string, method: string, path: string, headers: Record<string, string>, body?: string | Buffer) {
    const port = (proxy.address() as AddressInfo).port;
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: `${host}:443` });
      req.on('connect', (res, s) => (res.statusCode === 200 ? resolve(s) : reject(new Error(`CONNECT ${res.statusCode}`))));
      req.on('error', reject);
      req.end();
    });
    const secure = tls.connect({ socket, servername: host, ca: ca.certificatePem });
    await new Promise<void>((r, j) => secure.once('secureConnect', () => r()).once('error', j));
    return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = https.request({ host, method, path, headers, createConnection: () => secure }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  it('substitue le jeton OAuth au jeton de run (certificat valide pour la sandbox)', async () => {
    const r = await request('api.github.com', 'GET', '/user', { authorization: `token ${RUN_TOKEN}` });
    expect(r.status).toBe(200);
    const last = seen.at(-1)!;
    expect(last.headers.authorization).toBe(`Bearer ${REAL}`);
    expect(JSON.stringify(last.headers)).not.toContain(RUN_TOKEN);
  });

  it('autorise la création de PR et l’audite', async () => {
    const r = await request('api.github.com', 'POST', '/repos/o/r/pulls', { authorization: `token ${RUN_TOKEN}`, 'content-type': 'application/json' }, '{"title":"t"}');
    expect(r.status).toBe(200);
    expect(seen.at(-1)!.body).toBe('{"title":"t"}');
    expect(audits.at(-1)).toMatchObject({ action: 'git.agent_write', outcome: 'success' });
  });

  it('refuse la fusion sans contacter la forge', async () => {
    const before = seen.length;
    const r = await request('api.github.com', 'PUT', '/repos/o/r/pulls/1/merge', { authorization: `token ${RUN_TOKEN}` });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body.toString()).message).toContain('platform_merge_pull_request');
    expect(seen.length).toBe(before);
  });

  it('en-tête Host imposé par la connexion, LFS reconnu sur le chemin seul', async () => {
    const before = seen.length;
    const r = await request('github.com', 'PUT', '/repos/o/r/pulls/1/merge?x=/info/lfs/', { authorization: `token ${RUN_TOKEN}`, host: 'api.github.com' });
    expect(r.status).toBe(403);
    expect(seen.length).toBe(before);
    await request('github.com', 'GET', '/o/r', { authorization: `token ${RUN_TOKEN}`, host: 'api.github.com' });
    expect(seen.at(-1)!.headers.host).toBe('github.com');
    const gql = await request('api.github.com', 'POST', '/graphql', { authorization: `token ${RUN_TOKEN}`, 'content-type': 'application/json' }, JSON.stringify([{ query: 'query{viewer{login}}' }, { query: 'mutation{mergePullRequest(input:{pullRequestId:"x"}){clientMutationId}}' }]));
    expect(gql.status).toBe(403);
    const override = await request('api.github.com', 'POST', '/repos/o/r/pulls/1/merge', { authorization: `token ${RUN_TOKEN}`, 'x-http-method-override': 'PUT' });
    expect(override.status).toBe(403);
  });

  it('exige le jeton de run (401 pour que git appelle son assistant)', async () => {
    const r = await request('github.com', 'GET', '/o/r.git/info/refs?service=git-upload-pack', {});
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain('Basic');
  });

  it('push : branche de travail relayée intacte, branche par défaut refusée au format git', async () => {
    const auth = `Basic ${Buffer.from(`x-access-token:${RUN_TOKEN}`).toString('base64')}`;
    const pack = 'PACK\x00\x00\x00\x02' + 'z'.repeat(70_000);
    const ok = pkt(`${A} ${B} refs/heads/feature\0report-status side-band-64k\n`) + '0000' + pack;
    const r1 = await request('github.com', 'POST', '/o/r.git/git-receive-pack', { authorization: auth, 'content-type': 'application/x-git-receive-pack-request' }, Buffer.from(ok, 'latin1'));
    expect(r1.status).toBe(200);
    expect(seen.at(-1)!.body).toBe(ok);
    expect(seen.at(-1)!.headers.authorization).toBe(`Basic ${Buffer.from(`x-access-token:${REAL}`).toString('base64')}`);

    const before = seen.length;
    const bad = pkt(`${A} ${B} refs/heads/main\0report-status side-band-64k\n`) + '0000' + pack;
    const r2 = await request('github.com', 'POST', '/o/r.git/git-receive-pack', { authorization: auth }, Buffer.from(bad, 'latin1'));
    expect(r2.status).toBe(200);
    expect(r2.headers['content-type']).toBe('application/x-git-receive-pack-result');
    expect(r2.body.toString()).toContain('ng refs/heads/main');
    expect(seen.length).toBe(before);
  });

  it('push gzip : section de commandes compressée lue, bombe de décompression refusée sans bloquer', async () => {
    const auth = `Basic ${Buffer.from(`x-access-token:${RUN_TOKEN}`).toString('base64')}`;
    const pack = 'PACK\x00\x00\x00\x02' + 'z'.repeat(10_000);
    const bad = pkt(`${A} ${B} refs/heads/main\0report-status side-band-64k\n`) + '0000' + pack;
    const r1 = await request('github.com', 'POST', '/o/r.git/git-receive-pack', { authorization: auth, 'content-encoding': 'gzip' }, zlib.gzipSync(Buffer.from(bad, 'latin1')));
    expect(r1.body.toString()).toContain('ng refs/heads/main');

    // 64 Mio de zéros (≈ 64 Kio compressés) sans fin de section : refusé dès 1 Mio décompressé.
    const before = seen.length;
    const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024));
    const t0 = Date.now();
    const r2 = await request('github.com', 'POST', '/o/r.git/git-receive-pack', { authorization: auth, 'content-encoding': 'gzip' }, bomb);
    expect(r2.status).toBe(400);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(seen.length).toBe(before);
  });

  it.each([['https://github.com/o/r.git'], ['http://forge.test:8929/g/r.git']])('git réel (%s) : le refus d’un push sur main s’affiche et git se termine', async (remote) => {
    const { execFileSync, spawn } = await import('node:child_process');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'forge-git-'));
    writeFileSync(join(dir, 'ca.pem'), ca.certificatePem);
    const env = {
      ...process.env,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      https_proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      http_proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      GIT_SSL_CAINFO: join(dir, 'ca.pem'),
    };
    writeFileSync(join(dir, '.gitconfig'), `[credential]\n\thelper = "!f() { echo username=x; echo password=${RUN_TOKEN}; }; f"\n[user]\n\tname = t\n\temail = t@t\n`);
    const repo = join(dir, 'r');
    execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
    writeFileSync(join(repo, 'a'), 'a');
    execFileSync('git', ['-C', repo, 'add', '.'], { env });
    execFileSync('git', ['-C', repo, 'commit', '-qm', 'a'], { env });
    const r = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const p = spawn('git', ['-C', repo, 'push', remote, '+HEAD:main'], { env });
      let stderr = '';
      p.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      const t = setTimeout(() => p.kill(), 20_000);
      p.on('close', (status) => (clearTimeout(t), resolve({ status, stderr })));
    });
    if (!/remote rejected.*main/.test(r.stderr)) console.log('STDERR', r.stderr);
    expect(r.stderr).toMatch(/remote rejected.*main/);
    expect(r.status).not.toBe(0);
  });

  it('ne s’applique qu’aux forges', async () => {
    expect(await forge.match('registry.npmjs.org', 443, true)).toBeNull();
    expect(await forge.match('github.com', 22, true)).toBeNull();
    expect(await forge.match('github.com', 443, false)).toBeNull();
  });
});
