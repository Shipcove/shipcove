import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { ToolImageDto } from '@cap/contracts';
import { attachments, workspaces, type Database } from '@cap/database';
import { DB, ObjectStorage } from '@cap/server-core';
import { execCollect } from '@cap/sandbox';
import { SandboxManager, type ActiveSandbox } from './sandbox-manager.service.js';

/** Dossier des captures de Pi (plugin `browser` ou scripts) ; exclu des checkpoints. */
export const SCREENSHOTS_DIR = '/workspace/.cap/screenshots';
const MAX_PER_TOOL = 10;
const MAX_BYTES = 15 * 1024 * 1024;

/** Type et dimensions d'une image d'après son contenu (PNG, JPEG, WebP) ; `null` sinon. */
export function sniffImage(b: Buffer): { mime: string; width: number | null; height: number | null } | null {
  if (b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      i += 2 + len;
    }
    return { mime: 'image/jpeg', width: null, height: null };
  }
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X') return { mime: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8 ') return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { mime: 'image/webp', width: null, height: null };
  }
  return null;
}

/**
 * Captures d'écran de Pi : après un appel d'outil, les images apparues dans le dossier des captures
 * sont stockées comme pièces jointes (`source = agent`) et rattachées à l'appel, pour être affichées
 * dans la conversation. Le fichier reste dans la sandbox (Pi peut le relire), hors checkpoints.
 */
@Injectable()
export class ScreenshotsService {
  private readonly logger = new Logger('Screenshots');
  /** Captures déjà publiées, par instance de sandbox (nom + date de modification). */
  private readonly seenBySandbox = new Map<string, Set<string>>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly sandboxes: SandboxManager,
    private readonly storage: ObjectStorage,
  ) {}

  /** Images modifiées depuis `sinceMs` et pas encore publiées pour cette sandbox. */
  async collect(sb: ActiveSandbox, sinceMs: number): Promise<ToolImageDto[]> {
    let seen = this.seenBySandbox.get(sb.instanceId);
    if (!seen) {
      if (this.seenBySandbox.size > 500) this.seenBySandbox.clear();
      seen = new Set();
      this.seenBySandbox.set(sb.instanceId, seen);
    }
    const list = await execCollect(
      this.sandboxes.provider,
      sb.handle,
      ['sh', '-c', `[ -d ${SCREENSHOTS_DIR} ] && find ${SCREENSHOTS_DIR} -maxdepth 1 -type f \\( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' \\) -printf '%T@ %s %f\\n' || true`],
      { timeoutMs: 15_000 },
    );
    const candidates = list.stdout
      .toString('utf8')
      .split('\n')
      .map((l) => /^(\d+(?:\.\d+)?) (\d+) (.+)$/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ mtime: Number(m[1]) * 1000, size: Number(m[2]), name: m[3] }))
      .filter((f) => f.mtime >= sinceMs - 2_000 && !seen.has(`${f.name}@${f.mtime}`) && /^[\w.@+-]{1,200}$/.test(f.name))
      .sort((a, b) => a.mtime - b.mtime)
      .slice(0, MAX_PER_TOOL);
    if (!candidates.length) return [];
    const [ws] = await this.db.select({ ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, sb.workspaceId));
    const out: ToolImageDto[] = [];
    for (const f of candidates) {
      seen.add(`${f.name}@${f.mtime}`);
      if (f.size === 0 || f.size > MAX_BYTES) continue;
      const r = await execCollect(this.sandboxes.provider, sb.handle, ['cat', '--', `${SCREENSHOTS_DIR}/${f.name}`], { timeoutMs: 30_000, maxBytes: MAX_BYTES + 1 });
      if (r.exitCode !== 0) continue;
      const img = sniffImage(r.stdout);
      if (!img) {
        this.logger.warn(`${f.name} : contenu qui n'est pas une image, ignoré`);
        continue;
      }
      const sha = createHash('sha256').update(r.stdout).digest('hex');
      const storageKey = `attachments/${sb.workspaceId}/screenshots/${sha}-${Date.now()}`;
      await this.storage.put(this.storage.attachmentsBucket, storageKey, r.stdout, { contentType: img.mime, contentLength: r.stdout.length });
      const [row] = await this.db
        .insert(attachments)
        .values({
          ownerId: ws.ownerId,
          workspaceId: sb.workspaceId,
          fileName: f.name,
          declaredMimeType: img.mime,
          detectedMimeType: img.mime,
          kind: 'image',
          source: 'agent',
          size: r.stdout.length,
          sha256: sha,
          storageKey,
          status: 'ready',
        })
        .returning();
      out.push({ attachmentId: row.id, fileName: f.name, width: img.width, height: img.height });
    }
    return out;
  }
}
