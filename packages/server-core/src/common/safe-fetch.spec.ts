import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedirectRefusedError, fetchSameOrigin } from './safe-fetch.js';

/** Deux serveurs locaux sur des ports différents : deux origines distinctes. */
let a: http.Server;
let b: http.Server;
let aUrl = '';
let bUrl = '';

beforeAll(async () => {
  b = http.createServer((_req, res) => res.end('interne'));
  await new Promise<void>((r) => b.listen(0, '127.0.0.1', r));
  bUrl = `http://127.0.0.1:${(b.address() as AddressInfo).port}`;
  a = http.createServer((req, res) => {
    if (req.url === '/same') return res.writeHead(301, { location: '/final' }).end();
    if (req.url === '/cross') return res.writeHead(302, { location: `${bUrl}/secret` }).end();
    if (req.url === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    if (req.url === '/post') return res.writeHead(307, { location: '/final' }).end();
    res.end(`ok ${req.url}`);
  });
  await new Promise<void>((r) => a.listen(0, '127.0.0.1', r));
  aUrl = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
});
afterAll(() => {
  a.close();
  b.close();
});

describe('fetchSameOrigin', () => {
  it('suit une redirection vers le même origine', async () => {
    expect(await (await fetchSameOrigin(`${aUrl}/same`)).text()).toBe('ok /final');
  });
  it('refuse une redirection vers un autre origine (SSRF)', async () => {
    await expect(fetchSameOrigin(`${aUrl}/cross`)).rejects.toBeInstanceOf(RedirectRefusedError);
  });
  it('borne le nombre de redirections', async () => {
    await expect(fetchSameOrigin(`${aUrl}/loop`)).rejects.toBeInstanceOf(RedirectRefusedError);
  });
  it('ne redirige jamais une requête avec un corps', async () => {
    await expect(fetchSameOrigin(`${aUrl}/post`, { method: 'POST', body: 'x' })).rejects.toBeInstanceOf(RedirectRefusedError);
  });
});
