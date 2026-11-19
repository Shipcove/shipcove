import tls from 'node:tls';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { readSni } from './tls-sni.js';

/** ClientHello réel produit par Node pour `servername`, capturé côté serveur. */
function captureHello(servername?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      const chunks: Buffer[] = [];
      sock.on('data', (c: Buffer) => {
        chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (buf.length >= 5 && buf.length >= 5 + buf.readUInt16BE(3)) {
          resolve(buf);
          sock.destroy();
          server.close();
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      const c = tls.connect({ host: '127.0.0.1', port, servername, rejectUnauthorized: false });
      c.on('error', () => undefined);
    });
    server.on('error', reject);
  });
}

describe('readSni', () => {
  it('lit le nom de serveur d’un vrai ClientHello', async () => {
    expect(readSni(await captureHello('Registry.NPMJS.org'))).toEqual({ kind: 'sni', name: 'registry.npmjs.org' });
  });
  it('signale un ClientHello sans SNI', async () => {
    expect(readSni(await captureHello(''))).toEqual({ kind: 'no-sni' });
  });
  it('attend la suite d’un message incomplet', async () => {
    const hello = await captureHello('pypi.org');
    expect(readSni(hello.subarray(0, 20))).toEqual({ kind: 'incomplete' });
  });
  it('reconnaît un flux qui n’est pas du TLS', () => {
    expect(readSni(Buffer.from('GET / HTTP/1.1\r\nHost: evil.example\r\n\r\n'))).toEqual({ kind: 'not-tls' });
  });
});
