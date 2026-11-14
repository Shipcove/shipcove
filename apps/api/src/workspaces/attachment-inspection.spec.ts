import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { clamScan, inspectArchive } from './attachment-inspection.js';

const LIMITS = { maxEntries: 10, maxExpandedBytes: 1024 * 1024 };

/** ZIP minimal (méthode « stored ») ; `declared` permet de mentir sur la taille décompressée. */
function zip(entries: Array<{ name: string; data: string; declared?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const data = Buffer.from(e.data);
    const size = e.declared ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** TAR ustar minimal. */
function tar(entries: Array<{ name: string; data?: string; type?: string; link?: string; size?: number }>): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    const data = Buffer.from(e.data ?? '');
    h.write((e.size ?? data.length).toString(8).padStart(11, '0') + '\0', 124);
    h.write(e.type ?? '0', 156);
    if (e.link) h.write(e.link, 157, 100);
    h.write('ustar\0', 257);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

describe('inspection des archives (sans extraction)', () => {
  it('accepte un ZIP sain et compte ses entrées', () => {
    const v = inspectArchive(zip([{ name: 'a.txt', data: 'a' }, { name: 'dir/b.txt', data: 'bb' }]), 'application/zip', LIMITS);
    expect(v).toEqual({ ok: true, entries: 2, expandedBytes: 3 });
  });

  it('refuse le zip slip et les chemins absolus', () => {
    expect(inspectArchive(zip([{ name: '../../etc/cron.d/x', data: 'x' }]), 'application/zip', LIMITS).ok).toBe(false);
    expect(inspectArchive(zip([{ name: '/etc/passwd', data: 'x' }]), 'application/zip', LIMITS).ok).toBe(false);
    expect(inspectArchive(zip([{ name: 'C:\\Windows\\x', data: 'x' }]), 'application/zip', LIMITS).ok).toBe(false);
  });

  it('refuse une bombe ZIP (taille décompressée déclarée) et trop d’entrées', () => {
    const bomb = inspectArchive(zip([{ name: 'z', data: 'z', declared: 50 * 1024 * 1024 }]), 'application/zip', LIMITS);
    expect(bomb).toMatchObject({ ok: false });
    const many = inspectArchive(zip(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, data: '' }))), 'application/zip', LIMITS);
    expect(many).toMatchObject({ ok: false, reason: expect.stringContaining('entrées') });
  });

  it('inspecte TAR et tar.gz : chemins, liens sortants, taille réelle décompressée', () => {
    expect(inspectArchive(tar([{ name: 'ok.txt', data: 'ok' }]), 'application/x-tar', LIMITS)).toMatchObject({ ok: true, entries: 1 });
    expect(inspectArchive(tar([{ name: '../evil', data: 'x' }]), 'application/x-tar', LIMITS).ok).toBe(false);
    expect(inspectArchive(tar([{ name: 'lien', type: '2', link: '/etc/shadow' }]), 'application/x-tar', LIMITS).ok).toBe(false);
    expect(inspectArchive(gzipSync(tar([{ name: 'ok.txt', data: 'ok' }])), 'application/gzip', LIMITS)).toMatchObject({ ok: true, entries: 1 });
    // 5 Mo de zéros compressés en quelques Ko : refusés dès la décompression bornée.
    const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(inspectArchive(bomb, 'application/gzip', LIMITS)).toMatchObject({ ok: false, reason: expect.stringContaining('décompressée') });
  });

  it('refuse les formats non analysables', () => {
    expect(inspectArchive(Buffer.from('xz'), 'application/x-xz', LIMITS).ok).toBe(false);
    expect(inspectArchive(Buffer.from('7z'), 'application/x-7z-compressed', LIMITS).ok).toBe(false);
  });
});

describe('antivirus clamd (échec fermé)', () => {
  let server: net.Server | null = null;
  afterEach(() => server?.close());

  /** Faux clamd : lit le flux INSTREAM puis répond `reply`. */
  async function fakeClamd(reply: string): Promise<number> {
    server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (buf.subarray(-4).equals(Buffer.alloc(4))) sock.end(reply);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return (server.address() as net.AddressInfo).port;
  }

  it('sain uniquement sur « stream: OK »', async () => {
    expect(await clamScan(Buffer.from('x'), '127.0.0.1', await fakeClamd('stream: OK\0'))).toMatchObject({ status: 'clean' });
  });
  it('infecté avec la signature', async () => {
    expect(await clamScan(Buffer.from('x'), '127.0.0.1', await fakeClamd('stream: Eicar-Test-Signature FOUND\0'))).toMatchObject({ status: 'infected', signature: 'Eicar-Test-Signature' });
  });
  it('erreur clamd (limite de taille) → erreur, pas « sain »', async () => {
    expect(await clamScan(Buffer.from('x'), '127.0.0.1', await fakeClamd('INSTREAM size limit exceeded. ERROR\0'))).toMatchObject({ status: 'error' });
  });
  it('clamd injoignable → erreur', async () => {
    expect(await clamScan(Buffer.from('x'), '127.0.0.1', 1, 2000)).toMatchObject({ status: 'error' });
  });
  it('désactivé sans hôte', async () => {
    expect(await clamScan(Buffer.from('x'), '')).toEqual({ engine: null, status: 'disabled' });
  });
});
