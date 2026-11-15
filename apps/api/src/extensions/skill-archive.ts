import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { SKILL_LIMITS, isSafeSkillPath, type StoredSkillFile } from '@cap/contracts';
import { AppError } from '@cap/server-core';

/** Entrées ignorées à l'import (métadonnées de systèmes de fichiers). */
const IGNORED = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;

export interface ZipEntry {
  path: string;
  data: Buffer;
  executable: boolean;
}

/**
 * Lecture d'une archive ZIP (méthodes « stored » et « deflate ») sans dépendance externe, avec
 * garde-fous : chemins sûrs uniquement, liens symboliques refusés, ZIP64 refusé, nombre d'entrées
 * et taille décompressée bornés (bombes de décompression), CRC vérifié.
 */
export function readZip(buf: Buffer, limits = SKILL_LIMITS): ZipEntry[] {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalid('archive ZIP illisible (répertoire central absent)');
  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) throw invalid('archive ZIP64 non prise en charge');
  if (total > limits.maxFiles * 2) throw invalid(`plus de ${limits.maxFiles} fichiers`);
  const out: ZipEntry[] = [];
  let expanded = 0;
  let off = cdOffset;
  for (let n = 0; n < total; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw invalid('entrée invalide');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const madeBy = buf.readUInt16LE(off + 4) >> 8;
    const external = buf.readUInt32LE(off + 38);
    const localOff = buf.readUInt32LE(off + 42);
    const rawName = buf.subarray(off + 46, off + 46 + nameLen).toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1');
    off += 46 + nameLen + extraLen + commentLen;
    const name = rawName.replace(/\\/g, '/');
    if (name.endsWith('/') || IGNORED.test(name)) continue; // dossier ou métadonnées
    if (!isSafeSkillPath(name)) throw invalid(`chemin dangereux ou invalide : ${name.slice(0, 120)}`);
    const unixMode = madeBy === 3 ? external >>> 16 : 0;
    if ((unixMode & 0o170000) === 0o120000) throw invalid(`lien symbolique refusé : ${name}`);
    if (flags & 0x1) throw invalid(`fichier chiffré : ${name}`);
    if (csize === 0xffffffff || usize === 0xffffffff) throw invalid('archive ZIP64 non prise en charge');
    if (usize > limits.maxFileBytes) throw invalid(`${name} dépasse ${mb(limits.maxFileBytes)} Mo`);
    expanded += usize;
    if (expanded > limits.maxTotalBytes) throw invalid(`taille décompressée > ${mb(limits.maxTotalBytes)} Mo`);
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw invalid(`entrée locale invalide : ${name}`);
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const compressed = buf.subarray(dataStart, dataStart + csize);
    if (compressed.length !== csize) throw invalid(`données tronquées : ${name}`);
    let data: Buffer;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: limits.maxFileBytes + 1 });
      } catch {
        throw invalid(`décompression impossible : ${name}`);
      }
    } else throw invalid(`méthode de compression non prise en charge (${method}) : ${name}`);
    if (data.length !== usize || crc32(data) >>> 0 !== crc) throw invalid(`contrôle d’intégrité échoué : ${name}`);
    out.push({ path: name, data, executable: (unixMode & 0o111) !== 0 });
  }
  if (out.length > limits.maxFiles) throw invalid(`plus de ${limits.maxFiles} fichiers`);
  return stripCommonRoot(out);
}

/** « mon-skill/SKILL.md » → « SKILL.md » quand tout est sous un même dossier racine. */
function stripCommonRoot(entries: ZipEntry[]): ZipEntry[] {
  if (!entries.length || entries.some((e) => e.path === 'SKILL.md')) return entries;
  const roots = new Set(entries.map((e) => e.path.split('/')[0]));
  if (roots.size !== 1 || entries.some((e) => !e.path.includes('/'))) return entries;
  const root = [...roots][0];
  return entries.map((e) => ({ ...e, path: e.path.slice(root.length + 1) }));
}

/** Archive ZIP (deflate) d'un skill, avec les droits d'exécution. */
export function writeZip(files: Array<{ path: string; data: Buffer; executable?: boolean }>, root?: string): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const f of files) {
    const name = Buffer.from(root ? `${root}/${f.path}` : f.path, 'utf8');
    const deflated = deflateRawSync(f.data);
    const useDeflate = deflated.length < f.data.length;
    const body = useDeflate ? deflated : f.data;
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // noms en UTF-8
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // Unix : droits dans les attributs externes
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((0o100000 | (f.executable ? 0o755 : 0o644)) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Fichiers d'une archive → fichiers stockés (texte UTF-8 si possible, sinon base64). */
export function toStoredFiles(entries: ZipEntry[]): StoredSkillFile[] {
  return entries.map((e) => {
    const text = isText(e.data);
    return { path: e.path, content: text ? e.data.toString('utf8') : e.data.toString('base64'), ...(text ? {} : { encoding: 'base64' as const }), ...(e.executable ? { executable: true } : {}) };
  });
}

/** UTF-8 valide sans octet nul : traité comme texte (éditable). */
export function isText(data: Buffer): boolean {
  if (data.includes(0)) return false;
  return Buffer.from(data.toString('utf8'), 'utf8').equals(data);
}

function dosTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const mb = (n: number) => Math.round(n / 1024 / 1024);
const invalid = (msg: string) => new AppError('validation_failed', `Archive refusée : ${msg}`);
