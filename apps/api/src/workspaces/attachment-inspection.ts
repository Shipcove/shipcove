import net from 'node:net';
import type { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';

export interface ArchiveLimits {
  maxEntries: number;
  maxExpandedBytes: number;
}

export type ArchiveVerdict = { ok: true; entries: number; expandedBytes: number } | { ok: false; reason: string };

/** Chemin d'entrée dangereux (zip slip) : absolu, lecteur Windows, `..`. */
function unsafePath(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  return n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').some((s) => s === '..');
}

/**
 * Inspection d'archive SANS extraction (SPEC §16.3 : décompression d'archives contrôlée).
 * L'extraction éventuelle a lieu dans la sandbox, sous ses limites CPU/RAM/disque ;
 * cette inspection refuse en amont les bombes de décompression et les chemins dangereux.
 */
export function inspectArchive(buf: Buffer, mime: string, limits: ArchiveLimits): ArchiveVerdict {
  try {
    switch (mime) {
      case 'application/zip':
        return inspectZip(buf, limits);
      case 'application/x-tar':
        return inspectTar(buf, limits);
      case 'application/gzip': {
        let inner: Buffer;
        try {
          inner = gunzipSync(buf, { maxOutputLength: limits.maxExpandedBytes + 1 });
        } catch (e) {
          if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError) return tooLarge(limits);
          return { ok: false, reason: 'Archive gzip corrompue' };
        }
        if (inner.length > limits.maxExpandedBytes) return tooLarge(limits);
        // .tar.gz : inspection du tar interne ; sinon fichier unique compressé.
        return isTar(inner) ? inspectTar(inner, limits) : { ok: true, entries: 1, expandedBytes: inner.length };
      }
      default:
        return { ok: false, reason: 'Format d’archive non analysable (zip, tar, tar.gz et gzip acceptés)' };
    }
  } catch (e) {
    return { ok: false, reason: `Archive illisible : ${(e as Error).message}` };
  }
}

const tooLarge = (l: ArchiveLimits): ArchiveVerdict => ({ ok: false, reason: `Taille décompressée > ${Math.round(l.maxExpandedBytes / 1024 / 1024)} Mo` });

function inspectZip(buf: Buffer, limits: ArchiveLimits): ArchiveVerdict {
  // Fin du répertoire central : signature 0x06054b50 dans les 64 Kio + 22 derniers octets.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, reason: 'Archive ZIP corrompue (répertoire central absent)' };
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) return { ok: false, reason: 'Archive ZIP64 non prise en charge' };
  if (total > limits.maxEntries) return { ok: false, reason: `Plus de ${limits.maxEntries} entrées` };
  let off = cdOffset;
  let expanded = 0;
  for (let n = 0; n < total; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) return { ok: false, reason: 'Archive ZIP corrompue (entrée invalide)' };
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    if (size === 0xffffffff) return { ok: false, reason: 'Archive ZIP64 non prise en charge' };
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    if (unsafePath(name)) return { ok: false, reason: `Chemin dangereux dans l’archive : ${name.slice(0, 100)}` };
    expanded += size;
    if (expanded > limits.maxExpandedBytes) return tooLarge(limits);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, entries: total, expandedBytes: expanded };
}

function isTar(buf: Buffer): boolean {
  return buf.length >= 512 && buf.subarray(257, 262).toString('latin1') === 'ustar';
}

function inspectTar(buf: Buffer, limits: ArchiveLimits): ArchiveVerdict {
  let off = 0;
  let entries = 0;
  let expanded = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // fin d'archive
    const field = (start: number, len: number) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const type = String.fromCharCode(header[156] || 48);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) return { ok: false, reason: 'Archive TAR corrompue' };
    if (unsafePath(name)) return { ok: false, reason: `Chemin dangereux dans l’archive : ${name.slice(0, 100)}` };
    if ((type === '1' || type === '2') && unsafePath(field(157, 100))) return { ok: false, reason: `Lien sortant de l’archive : ${name.slice(0, 100)}` };
    if (type !== 'x' && type !== 'g' && type !== 'L' && type !== 'K') entries++;
    expanded += size;
    if (entries > limits.maxEntries) return { ok: false, reason: `Plus de ${limits.maxEntries} entrées` };
    if (expanded > limits.maxExpandedBytes) return tooLarge(limits);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return { ok: true, entries, expandedBytes: expanded };
}

export type ScanResult =
  | { engine: null; status: 'disabled' }
  | { engine: 'clamav'; status: 'clean' | 'infected' | 'error'; signature?: string; detail?: string; scannedAt: string };

/**
 * Analyse antivirus via clamd (INSTREAM). Échec fermé : seule la réponse `stream: OK` vaut
 * « sain » ; erreur, délai, limite de taille clamd ou réponse inattendue → `error` (fichier refusé).
 */
export function clamScan(input: Buffer | (() => Readable), host = process.env.CLAMAV_HOST, port = Number(process.env.CLAMAV_PORT ?? 3310), timeoutMs = 60_000): Promise<ScanResult> {
  if (!host) return Promise.resolve({ engine: null, status: 'disabled' });
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: Omit<Extract<ScanResult, { engine: 'clamav' }>, 'engine' | 'scannedAt'>) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ engine: 'clamav', scannedAt: new Date().toISOString(), ...r });
    };
    const sock = net.connect(port, host);
    let out = '';
    sock.setTimeout(timeoutMs, () => done({ status: 'error', detail: 'délai dépassé' }));
    /** Écriture respectant la contre-pression (fichier lu en flux, jamais entièrement en mémoire). */
    const write = (b: Buffer) => (sock.write(b) ? Promise.resolve() : new Promise<void>((r) => sock.once('drain', () => r())));
    sock.on('connect', () => {
      void (async () => {
        sock.write('zINSTREAM\0');
        const source: AsyncIterable<Buffer> | Iterable<Buffer> = Buffer.isBuffer(input) ? [input] : (input() as AsyncIterable<Buffer>);
        for await (const piece of source) {
          for (let i = 0; i < piece.length; i += 64 * 1024) {
            if (settled) return;
            const chunk = piece.subarray(i, i + 64 * 1024);
            const len = Buffer.alloc(4);
            len.writeUInt32BE(chunk.length);
            await write(len);
            await write(chunk);
          }
        }
        sock.write(Buffer.alloc(4));
      })().catch((e: Error) => done({ status: 'error', detail: `lecture du fichier : ${e.message}` }));
    });
    sock.on('data', (d) => (out += d.toString()));
    sock.on('end', () => {
      const reply = out.replace(/\0/g, '').trim();
      if (reply === 'stream: OK') return done({ status: 'clean' });
      const found = /^stream: (.+) FOUND$/.exec(reply);
      if (found) return done({ status: 'infected', signature: found[1] });
      done({ status: 'error', detail: reply.slice(0, 200) || 'réponse vide' });
    });
    sock.on('error', (e) => done({ status: 'error', detail: e.message }));
  });
}
