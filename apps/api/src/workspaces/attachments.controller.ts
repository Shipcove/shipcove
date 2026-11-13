import { createHash } from 'node:crypto';
import net from 'node:net';
import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { fileTypeFromBuffer } from 'file-type';
import { z } from 'zod';
import type { AttachmentDto } from '@cap/contracts';
import { attachments, type Database } from '@cap/database';
import { AppError, AuditService, DB, ObjectStorage, SettingsService } from '@cap/server-core';
import { CurrentUser } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';

const uuid = { schema: z.uuid() };
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ARCHIVE_TYPES = new Set(['application/zip', 'application/x-tar', 'application/gzip', 'application/x-bzip2', 'application/x-xz', 'application/x-7z-compressed']);
const ALLOWED_BINARY = new Set(['application/pdf']);
const FORBIDDEN_EXT = /\.(exe|dll|msi|scr|com|bat|cmd|ps1|vbs|jar|apk|dmg|iso)$/i;

interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * Pièces jointes (SPEC §16.3) :
 * - type réel détecté par signature (le type déclaré n'est pas cru) ;
 * - taille et nombre bornés par l'administration ;
 * - les archives ne sont JAMAIS décompressées côté serveur : elles sont déposées telles quelles
 *   dans la sandbox, où une éventuelle extraction est soumise aux limites CPU/RAM/disque ;
 * - analyse antivirus via clamd si `CLAMAV_HOST` est configuré ;
 * - stockées dans un bucket distinct des snapshots, accessibles au seul propriétaire.
 */
@ApiTags('attachments')
@Controller('workspaces/:id/attachments')
export class AttachmentsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @UseInterceptors(FilesInterceptor('files', 50, { limits: { fileSize: 500 * 1024 * 1024 } }))
  async upload(@Param('id', uuid) id: string, @UploadedFiles() files: UploadedFile[], @CurrentUser() user: AuthUser): Promise<AttachmentDto[]> {
    await this.access.requireWorkspaceOwner(user, id);
    const cfg = await this.settings.section('attachments');
    if (!files?.length) throw new AppError('validation_failed', 'Aucun fichier');
    if (files.length > cfg.maxFilesPerMessage) throw new AppError('attachment_rejected', `Au plus ${cfg.maxFilesPerMessage} fichiers`);
    const out: AttachmentDto[] = [];
    for (const f of files) {
      const name = f.originalname.replace(/[/\\\0]/g, '_').slice(0, 200) || 'fichier';
      let status: 'ready' | 'rejected' = 'ready';
      let reason: string | null = null;
      const detected = await fileTypeFromBuffer(f.buffer);
      const mime = detected?.mime ?? (isProbablyText(f.buffer) ? 'text/plain' : 'application/octet-stream');
      const kind: AttachmentDto['kind'] = IMAGE_TYPES.has(mime) ? 'image' : ARCHIVE_TYPES.has(mime) ? 'archive' : mime === 'text/plain' ? 'text' : 'binary';
      if (f.size > cfg.maxFileMb * 1024 * 1024) [status, reason] = ['rejected', `Taille > ${cfg.maxFileMb} Mo`];
      else if (FORBIDDEN_EXT.test(name)) [status, reason] = ['rejected', 'Type de fichier exécutable interdit'];
      else if (kind === 'archive' && !cfg.allowArchives) [status, reason] = ['rejected', 'Archives non autorisées'];
      else if (kind === 'binary' && !ALLOWED_BINARY.has(mime)) [status, reason] = ['rejected', `Type non autorisé (${mime})`];
      else if (detected && f.mimetype.startsWith('image/') && !IMAGE_TYPES.has(mime)) [status, reason] = ['rejected', 'Type déclaré incohérent avec le contenu'];
      let scan: Record<string, unknown> = { engine: null, skipped: true };
      if (status === 'ready') {
        scan = await clamScan(f.buffer);
        if (scan.infected) [status, reason] = ['rejected', `Logiciel malveillant détecté (${scan.signature})`];
      }
      const sha = createHash('sha256').update(f.buffer).digest('hex');
      const [row] = await this.db
        .insert(attachments)
        .values({
          ownerId: user.id,
          workspaceId: id,
          fileName: name,
          declaredMimeType: f.mimetype,
          detectedMimeType: mime,
          kind,
          size: f.size,
          sha256: sha,
          storageKey: `attachments/${id}/${sha}-${Date.now()}`,
          status,
          rejectionReason: reason,
          scan,
        })
        .returning();
      if (status === 'ready') await this.storage.put(this.storage.attachmentsBucket, row.storageKey, f.buffer, { contentType: mime, contentLength: f.size });
      await this.audit.record({ actorId: user.id, action: 'attachment.upload', targetType: 'attachment', targetId: row.id, outcome: status === 'ready' ? 'success' : 'failure', metadata: { name, mime, size: f.size, reason } });
      out.push(toDto(row));
    }
    return out;
  }

  /** Téléchargement (propriétaire uniquement : un partage de conversation ne l'expose pas). */
  @Get(':attachmentId')
  async download(@Param('id', uuid) id: string, @Param('attachmentId', uuid) attachmentId: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.access.requireWorkspaceOwner(user, id);
    const [a] = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), eq(attachments.workspaceId, id), eq(attachments.status, 'ready'), isNull(attachments.deletedAt)));
    if (!a) throw new AppError('not_found', 'Pièce jointe introuvable');
    const buf = await this.storage.getBuffer(this.storage.attachmentsBucket, a.storageKey);
    if (!buf) throw new AppError('not_found', 'Contenu indisponible');
    res.setHeader('Content-Type', IMAGE_TYPES.has(a.detectedMimeType) ? a.detectedMimeType : 'application/octet-stream');
    res.setHeader('Content-Disposition', `${IMAGE_TYPES.has(a.detectedMimeType) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(buf);
  }

  /** Retrait d'une pièce jointe non encore associée à un message. */
  @Delete(':attachmentId')
  @HttpCode(204)
  async remove(@Param('id', uuid) id: string, @Param('attachmentId', uuid) attachmentId: string, @CurrentUser() user: AuthUser) {
    await this.access.requireWorkspaceOwner(user, id);
    const [a] = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), eq(attachments.workspaceId, id), isNull(attachments.messageId)));
    if (!a) throw new AppError('not_found', 'Pièce jointe introuvable ou déjà envoyée');
    if (a.status === 'ready') await this.storage.deleteMany(this.storage.attachmentsBucket, [a.storageKey]);
    await this.db.delete(attachments).where(eq(attachments.id, attachmentId));
  }
}

function toDto(a: typeof attachments.$inferSelect): AttachmentDto {
  return { id: a.id, fileName: a.fileName, mimeType: a.detectedMimeType, size: a.size, kind: a.kind, status: a.status, rejectionReason: a.rejectionReason, createdAt: a.createdAt.toISOString() };
}

function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.max(0, sample.length - 4)));
    return true;
  } catch {
    return false;
  }
}

/** Analyse clamd (protocole INSTREAM) si `CLAMAV_HOST` est défini. */
async function clamScan(buf: Buffer): Promise<Record<string, unknown>> {
  const host = process.env.CLAMAV_HOST;
  if (!host) return { engine: null, skipped: true };
  const port = Number(process.env.CLAMAV_PORT ?? 3310);
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    let out = '';
    sock.setTimeout(30_000, () => {
      sock.destroy();
      resolve({ engine: 'clamav', error: 'timeout', infected: false, skipped: true });
    });
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buf.length; i += 64 * 1024) {
        const chunk = buf.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      }
      sock.write(Buffer.alloc(4));
    });
    sock.on('data', (d) => (out += d.toString()));
    sock.on('end', () => {
      const infected = /FOUND/.test(out);
      resolve({ engine: 'clamav', infected, signature: infected ? out.replace(/^stream: /, '').replace(/ FOUND.*$/s, '') : null, scannedAt: new Date().toISOString() });
    });
    sock.on('error', (e) => resolve({ engine: 'clamav', error: e.message, infected: false, skipped: true }));
  });
}
