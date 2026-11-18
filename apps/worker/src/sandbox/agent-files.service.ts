import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { ToolFileDto } from '@cap/contracts';
import { attachments, workspaces, type Database } from '@cap/database';
import { DB, ObjectStorage, SettingsService, scrubSecrets } from '@cap/server-core';
import { execCollect } from '@cap/sandbox';
import { SandboxManager, type ActiveSandbox } from './sandbox-manager.service.js';
import { sniffImage } from './screenshots.service.js';

/** Dossiers de la sandbox dont Pi peut proposer des fichiers au téléchargement. */
const ALLOWED_ROOTS = ['/workspace', '/tmp'];
/** Dossiers internes jamais partagés (état de Pi, captures déjà affichées autrement). */
const FORBIDDEN_PREFIXES = ['/workspace/.cap/', '/workspace-state'];
export const MAX_SHARED_FILES = 10;
/** Plafond absolu par fichier (le réglage administrateur des pièces jointes s'applique en dessous). */
const HARD_MAX_MB = 100;
const ARCHIVE_EXT = /\.(zip|tar|tgz|gz|bz2|xz|7z)$/i;

const within = (p: string, root: string) => p === root || p.startsWith(`${root}/`);

/** Chemin demandé par Pi, normalisé et confiné aux dossiers autorisés ; `null` sinon. */
export function normalizeSharedPath(raw: string): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) return null;
  const p = posix.normalize(raw.trim().startsWith('/') ? raw.trim() : `/workspace/${raw.trim()}`);
  if (!ALLOWED_ROOTS.some((r) => within(p, r)) || FORBIDDEN_PREFIXES.some((f) => p.startsWith(f))) return null;
  return p;
}

/** Nature du contenu (même catégories que les pièces jointes de l'utilisateur). */
export function classify(buf: Buffer, fileName: string): { kind: ToolFileDto['kind']; mime: string } {
  const img = sniffImage(buf);
  if (img) return { kind: 'image', mime: img.mime };
  if (ARCHIVE_EXT.test(fileName) || (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04)) return { kind: 'archive', mime: 'application/octet-stream' };
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'binary', mime: 'application/pdf' };
  const sample = buf.subarray(0, 8192);
  if (!sample.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
      return { kind: 'text', mime: 'text/plain' };
    } catch {
      /* binaire */
    }
  }
  return { kind: 'binary', mime: 'application/octet-stream' };
}

/**
 * Fichiers proposés au téléchargement par Pi (outil `share_files`) : chaque fichier est copié depuis
 * la sandbox au moment du partage et stocké comme pièce jointe `source = agent`, rattachée à l'appel
 * d'outil. La copie reste téléchargeable même si le fichier change ou disparaît ensuite. Les valeurs
 * secrètes de l'environnement sont masquées dans les fichiers texte, comme dans les sorties d'outils.
 */
@Injectable()
export class AgentFilesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly sandboxes: SandboxManager,
    private readonly storage: ObjectStorage,
    private readonly settings: SettingsService,
  ) {}

  async share(sb: ActiveSandbox, rawPaths: unknown, secretValues: string[]): Promise<{ files: ToolFileDto[]; errors: string[] }> {
    const list = Array.isArray(rawPaths) ? rawPaths.map(String) : [];
    if (!list.length) throw new Error('Aucun fichier indiqué (paramètre « paths »).');
    if (list.length > MAX_SHARED_FILES) throw new Error(`Au plus ${MAX_SHARED_FILES} fichiers par appel.`);
    const cfg = await this.settings.section('attachments');
    const maxBytes = Math.min(cfg.maxFileMb, HARD_MAX_MB) * 1024 * 1024;
    const [ws] = await this.db.select({ ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, sb.workspaceId));
    const files: ToolFileDto[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const raw of list) {
      const asked = normalizeSharedPath(raw);
      if (!asked) {
        errors.push(`${raw} : seuls les fichiers de /workspace ou /tmp peuvent être partagés`);
        continue;
      }
      // Lien symbolique résolu dans la sandbox, puis confinement vérifié sur le chemin réel.
      const st = await execCollect(this.sandboxes.provider, sb.handle, ['sh', '-c', 'p=$(realpath -e -- "$1") && stat -c "%s|%F" -- "$p" && printf "%s" "$p"', 'sh', asked], { timeoutMs: 15_000 });
      const [meta = '', real = ''] = st.stdout.toString('utf8').split('\n');
      const [sizeText, type] = meta.split('|');
      const path = normalizeSharedPath(real);
      if (st.exitCode !== 0 || !real) {
        errors.push(`${raw} : fichier introuvable`);
        continue;
      }
      if (!path) {
        errors.push(`${raw} : le fichier pointe hors de /workspace et /tmp`);
        continue;
      }
      if (type !== 'regular file' && type !== 'regular empty file') {
        errors.push(`${raw} : ce n’est pas un fichier (dossier ? archivez-le d’abord, par ex. avec zip ou tar)`);
        continue;
      }
      if (seen.has(path)) continue;
      seen.add(path);
      const size = Number(sizeText);
      if (!(size > 0)) {
        errors.push(`${raw} : fichier vide`);
        continue;
      }
      if (size > maxBytes) {
        errors.push(`${raw} : trop volumineux (max ${Math.round(maxBytes / 1024 / 1024)} Mo)`);
        continue;
      }
      const r = await execCollect(this.sandboxes.provider, sb.handle, ['cat', '--', path], { timeoutMs: 60_000, maxBytes: maxBytes + 1 });
      if (r.exitCode !== 0) {
        errors.push(`${raw} : lecture impossible`);
        continue;
      }
      const fileName = posix.basename(path).replace(/[\\\0]/g, '_').slice(0, 200) || 'fichier';
      const { kind, mime } = classify(r.stdout, fileName);
      const content = kind === 'text' && secretValues.length ? Buffer.from(scrubSecrets(r.stdout.toString('utf8'), secretValues), 'utf8') : r.stdout;
      const sha = createHash('sha256').update(content).digest('hex');
      const storageKey = `attachments/${sb.workspaceId}/shared/${sha}-${Date.now()}`;
      await this.storage.put(this.storage.attachmentsBucket, storageKey, content, { contentType: mime, contentLength: content.length });
      const [row] = await this.db
        .insert(attachments)
        .values({
          ownerId: ws.ownerId,
          workspaceId: sb.workspaceId,
          fileName,
          declaredMimeType: mime,
          detectedMimeType: mime,
          kind,
          source: 'agent',
          size: content.length,
          sha256: sha,
          storageKey,
          status: 'ready',
        })
        .returning();
      files.push({ attachmentId: row.id, fileName, path, size: content.length, kind });
    }
    return { files, errors };
  }
}
