import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { proxyUpgrade } from './preview-proxy.service.js';

const servers: Array<http.Server | net.Server> = [];
const sockets = new Set<net.Socket>();
afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen<T extends http.Server | net.Server>(s: T): Promise<number> {
  servers.push(s);
  s.on('connection', (c: net.Socket) => sockets.add(c));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return (s.address() as AddressInfo).port;
}

/** Proxy minimal : toute requête d'upgrade est relayée vers `target`. */
async function proxyTo(targetPort: number): Promise<number> {
  const p = http.createServer((_req, res) => res.end());
  p.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket as net.Socket, head, { host: '127.0.0.1', port: targetPort }));
  return listen(p);
}

/** Envoie une requête d'upgrade brute, puis `payload`, et renvoie tout ce qui revient avant fermeture. */
function rawUpgrade(port: number, payload = ''): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1', () => {
      c.write('GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
      if (payload) setTimeout(() => c.write(payload), 100);
    });
    let out = '';
    c.on('data', (d) => (out += d.toString('latin1')));
    c.on('close', () => resolve(out));
    c.on('error', () => resolve(out));
    setTimeout(() => c.destroy(), 1500);
  });
}

describe('relais WebSocket des previews', () => {
  it('ouvre le tunnel quand l’application répond 101', async () => {
    const app = http.createServer();
    app.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (d) => socket.write(`echo:${d}`));
    });
    const out = await rawUpgrade(await proxyTo(await listen(app)), 'bonjour');
    expect(out).toMatch(/^HTTP\/1\.1 101/);
    expect(out).toContain('echo:bonjour');
  });

  it('ne fait pas de tunnel vers un service qui ne parle pas HTTP (PostgreSQL, Redis…)', async () => {
    const db = net.createServer((s) => {
      s.on('data', () => s.write('SECRET-DB-BYTES'));
      s.on('error', () => {});
    });
    const out = await rawUpgrade(await proxyTo(await listen(db)), 'requete-sql');
    expect(out).not.toContain('SECRET-DB-BYTES');
    expect(out).not.toMatch(/^HTTP\/1\.1 101/);
  });

  it('refuse sans relayer le contenu quand l’application répond en HTTP ordinaire', async () => {
    const app = http.createServer((_req, res) => res.end('contenu-prive'));
    const out = await rawUpgrade(await proxyTo(await listen(app)));
    expect(out).toMatch(/^HTTP\/1\.1 200 Upgrade Refused/);
    expect(out).not.toContain('contenu-prive');
  });
});
