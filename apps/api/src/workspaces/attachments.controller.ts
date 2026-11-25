import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Controller, Delete, Get, HttpCode, Inject, Injectable, Param, Post, Res, UploadedFiles, UseGuards, UseInterceptors, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { fileTypeFromFile } from 'file-type';
import { z } from 'zod';
import { toAttachmentDto, type AttachmentDto } from '@cap/contracts';
import { attachments, type Database } from '@cap/database';
import { AppError, AuditService, DB, ObjectStorage, SettingsService } from '@cap/server-core';
import { CurrentUser } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';
import { clamScan, inspectArchive } from './attachment-inspection.js';

const uuid = { schema: z.uuid() };
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const ARCHIVE_TYPES = new Set(['application/zip', 'application/x-tar', 'application/gzip', 'application/x-bzip2', 'application/x-xz', 'application/x-7z-compressed']);
const ALLOWED_BINARY = new Set(['application/pdf']);
const FORBIDDEN_EXT = /\.(exe|dll|msi|scr|com|bat|cmd|ps1|vbs|jar|apk|dmg|iso)$/i;

/** Fichier reçu par Multer, écrit sur disque (jamais entièrement en mémoire). */
interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  path: string;
}

/**
 * Dossier temporaire des envois : chaque fichier y est écrit pendant la réception, puis analysé et
 * envoyé vers S3 en flux, et supprimé. Plusieurs envois simultanés de 200 Mo ne saturent plus la
 * mémoire de l'API (dimensionner le disque : Helm `api.tmpSize`).
 */
const UPLOAD_DIR = process.env.ATTACHMENTS_TMP_DIR || join(tmpdir(), 'cap-uploads');

async function headOf(path: string, bytes = 8192): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function sha256Of(path: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

/** Plafond absolu par fichier (le réglage administrateur est borné à cette valeur). */
const HARD_MAX_FILE_MB = 500;

/**
 * Refuse une requête trop volumineuse AVANT que Multer ne charge les fichiers en mémoire :
 * `Content-Length` obligatoire et borné par les réglages (nombre × taille max + marge multipart).
 */
@Injectable()
export class UploadSizeGuard implements CanActivate {
  constructor(private readonly settings: SettingsService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const cfg = await this.settings.section('attachments');
    const length = Number(req.headers['content-length']);
    if (!Number.isFinite(length) || length <= 0) throw new AppError('validation_failed', 'En-tête Content-Length requis', undefined, 411);
    const max = cfg.maxFilesPerMessage * cfg.maxFileMb * 1024 * 1024 + 1024 * 1024;
    if (length > max) throw new AppError('attachment_rejected', `Envoi trop volumineux (max ${cfg.maxFilesPerMessage} × ${cfg.maxFileMb} Mo)`, undefined, 413);
    return true;
  }
}

/**
 * Pièces jointes (SPEC §16.3) :
 * - type réel détecté par signature (le type déclaré n'est pas cru) ;
 * - taille et nombre bornés par l'administration ;
 * - les archives ne sont JAMAIS extraites côté serveur : elles sont inspectées (nombre d'entrées,
 *   taille décompressée, chemins dangereux) puis déposées telles quelles dans la sandbox ;
 * - analyse antivirus via clamd si `CLAMAV_HOST` est configuré, en échec fermé ;
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
  @UseGuards(UploadSizeGuard)
  @UseInterceptors(FilesInterceptor('files', 50, { dest: UPLOAD_DIR, limits: { fileSize: HARD_MAX_FILE_MB * 1024 * 1024, files: 50, fields: 10, parts: 60 } }))
  async upload(@Param('id', uuid) id: string, @UploadedFiles() files: UploadedFile[], @CurrentUser() user: AuthUser): Promise<AttachmentDto[]> {
    try {
      return await this.processUploads(id, files ?? [], user);
    } finally {
      // Fichiers temporaires toujours supprimés, y compris en cas de refus ou d'erreur.
      await Promise.all((files ?? []).map((f) => unlink(f.path).catch(() => undefined)));
    }
  }

  private async processUploads(id: string, files: UploadedFile[], user: AuthUser): Promise<AttachmentDto[]> {
    await this.access.requireWorkspaceOwner(user, id);
    const cfg = await this.settings.section('attachments');
    if (!files?.length) throw new AppError('validation_failed', 'Aucun fichier');
    if (files.length > cfg.maxFilesPerMessage) throw new AppError('attachment_rejected', `Au plus ${cfg.maxFilesPerMessage} fichiers`);
    const out: AttachmentDto[] = [];
    for (const f of files) {
      const name = f.originalname.replace(/[/\\\0]/g, '_').slice(0, 200) || 'fichier';
      let status: 'ready' | 'rejected' = 'ready';
      let reason: string | null = null;
      const detected = await fileTypeFromFile(f.path);
      const mime = detected?.mime ?? (isProbablyText(await headOf(f.path)) ? 'text/plain' : 'application/octet-stream');
      const kind: AttachmentDto['kind'] = IMAGE_TYPES.has(mime) ? 'image' : ARCHIVE_TYPES.has(mime) ? 'archive' : mime === 'text/plain' ? 'text' : 'binary';
      if (f.size > cfg.maxFileMb * 1024 * 1024) [status, reason] = ['rejected', `Taille > ${cfg.maxFileMb} Mo`];
      else if (FORBIDDEN_EXT.test(name)) [status, reason] = ['rejected', 'Type de fichier exécutable interdit'];
      else if (kind === 'archive' && !cfg.allowArchives) [status, reason] = ['rejected', 'Archives non autorisées'];
      else if (kind === 'binary' && !ALLOWED_BINARY.has(mime)) [status, reason] = ['rejected', `Type non autorisé (${mime})`];
      else if (detected && f.mimetype.startsWith('image/') && !IMAGE_TYPES.has(mime)) [status, reason] = ['rejected', 'Type déclaré incohérent avec le contenu'];
      if (status === 'ready' && kind === 'archive') {
        // Seules les archives sont lues en entier (une à la fois, bornées par la taille maximale).
        const verdict = inspectArchive(await readFile(f.path), mime, { maxEntries: cfg.maxArchiveEntries, maxExpandedBytes: cfg.maxArchiveExpandedMb * 1024 * 1024 });
        if (!verdict.ok) [status, reason] = ['rejected', verdict.reason];
      }
      let scan: Record<string, unknown> = { engine: null, status: 'disabled' };
      if (status === 'ready') {
        scan = await clamScan(() => createReadStream(f.path));
        if (scan.status === 'infected') [status, reason] = ['rejected', `Logiciel malveillant détecté (${scan.signature})`];
        else if (scan.status === 'error') [status, reason] = ['rejected', 'Analyse antivirus indisponible : fichier refusé par précaution'];
      }
      const sha = await sha256Of(f.path);
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
      if (status === 'ready') await this.storage.put(this.storage.attachmentsBucket, row.storageKey, createReadStream(f.path), { contentType: mime, contentLength: f.size });
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
      .where(and(eq(attachments.id, attachmentId), eq(attachments.workspaceId, id), isNull(attachments.messageId), eq(attachments.source, 'user')));
    if (!a) throw new AppError('not_found', 'Pièce jointe introuvable ou déjà envoyée');
    if (a.status === 'ready') await this.storage.deleteMany(this.storage.attachmentsBucket, [a.storageKey]);
    await this.db.delete(attachments).where(eq(attachments.id, attachmentId));
  }
}

const toDto = (a: typeof attachments.$inferSelect): AttachmentDto => toAttachmentDto(a);

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

/**
 * Captures d'écran produites par Pi : visibles par quiconque peut lire la conversation (propriétaire
 * et personnes avec qui elle est partagée), contrairement aux pièces jointes déposées.
 */
@ApiTags('attachments')
@Controller('workspaces/:id/screenshots')
export class ScreenshotsController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly access: AccessService,
  ) {}

  @Get(':attachmentId')
  async get(@Param('id', uuid) id: string, @Param('attachmentId', uuid) attachmentId: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.access.requireWorkspaceRead(user, id);
    const [a] = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), eq(attachments.workspaceId, id), eq(attachments.source, 'agent'), eq(attachments.status, 'ready'), isNull(attachments.deletedAt)));
    if (!a || !IMAGE_TYPES.has(a.detectedMimeType)) throw new AppError('not_found', 'Capture introuvable');
    const buf = await this.storage.getBuffer(this.storage.attachmentsBucket, a.storageKey);
    if (!buf) throw new AppError('not_found', 'Capture indisponible');
    res.setHeader('Content-Type', a.detectedMimeType);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(buf);
  }
}

/**
 * Fichiers proposés au téléchargement par Pi (outil `share_files`) : comme les captures, visibles
 * par quiconque peut lire la conversation. Toujours servis en téléchargement, jamais interprétés
 * par le navigateur (HTML, SVG… produits dans la sandbox).
 */
@ApiTags('attachments')
@Controller('workspaces/:id/agent-files')
export class AgentFilesController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly access: AccessService,
  ) {}

  @Get(':attachmentId')
  async get(@Param('id', uuid) id: string, @Param('attachmentId', uuid) attachmentId: string, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.access.requireWorkspaceRead(user, id);
    const [a] = await this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, attachmentId), eq(attachments.workspaceId, id), eq(attachments.source, 'agent'), eq(attachments.status, 'ready'), isNull(attachments.deletedAt)));
    if (!a) throw new AppError('not_found', 'Fichier introuvable');
    const buf = await this.storage.getBuffer(this.storage.attachmentsBucket, a.storageKey);
    if (!buf) throw new AppError('not_found', 'Fichier indisponible');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(a.fileName)}`);
    res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.send(buf);
  }
}
