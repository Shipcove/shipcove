import { createHash } from 'node:crypto';
import { Body, Controller, Get, Headers, Inject, Param, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  ChangeScopeSchema,
  WriteFileSchema,
  type ChangeScope,
  type ChangesResponse,
  type FileChangeDto,
  type FileContentDto,
  type FileDiffDto,
  type FileEntryDto,
} from '@cap/contracts';
import { agentRuns, workspaces, type Database } from '@cap/database';
import { AppError, AuditService, DB, ObjectStorage, SettingsService } from '@cap/server-core';
import { IntegrityError, WorkspaceStorage, diffManifests, fromUserPath, isBinary, toUserPath, unifiedDiff, type BlobStore, type Manifest } from '@cap/storage';
import { CurrentUser } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';
import { SandboxRpcClient } from './sandbox-rpc.client.js';
import { ContentCache } from './content-cache.js';
import { buildChangeList, type ChangeEntry, type LineStats } from './change-stats.js';

const uuid = { schema: z.uuid() };
const MAX_DISPLAY = 2 * 1024 * 1024;
const HIDDEN = [/^\.git(\/|$)/, /^\.cap(\/|$)/];
/** Objets conservés en mémoire : au plus 512 Kio chacun, 64 Mio au total (par processus). */
const OBJECT_CACHE_MAX_ITEM = 512 * 1024;
const OBJECT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Réponses de `GET changes` gardées en mémoire : au plus 100 000 fichiers listés au total. */
const RESPONSE_CACHE_MAX_FILES = 100_000;

function blobStore(s: ObjectStorage): BlobStore {
  const b = s.workspaceBucket;
  return {
    put: (k, body) => s.put(b, k, body),
    get: (k) => s.getBuffer(b, k),
    head: (k) => s.head(b, k),
    list: (p) => s.list(b, p),
    deleteMany: (k) => s.deleteMany(b, k),
  };
}

/**
 * Fichiers et modifications du workspace. Les lectures s'appuient sur le dernier checkpoint
 * validé (disponible même sandbox détruite) ; l'écriture manuelle passe par le worker avec
 * contrôle de version (If-Match) et déclenche un checkpoint.
 */
@ApiTags('files')
@Controller('workspaces/:id')
export class FilesController {
  private readonly storage: WorkspaceStorage;

  constructor(
    @Inject(DB) private readonly db: Database,
    objectStorage: ObjectStorage,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    private readonly rpc: SandboxRpcClient,
    private readonly audit: AuditService,
  ) {
    this.storage = new WorkspaceStorage(db, blobStore(objectStorage));
  }

  /*
   * Caches (issue #10). Tout ce qui est mis en cache est immuable : un manifeste est figé pour une
   * génération donnée, un objet est adressé par son sha256, les statistiques d'un fichier ne
   * dépendent que du couple (ancien hachage, nouveau hachage). Aucune invalidation n'est donc
   * nécessaire, et les chargements concurrents d'une même clé sont fusionnés.
   */
  private readonly manifests = new ContentCache<Manifest | null>({ maxEntries: 16, shouldCache: (m) => m !== null });
  private readonly objects = new ContentCache<Buffer | null>({
    maxEntries: 20_000,
    maxWeight: OBJECT_CACHE_MAX_BYTES,
    weigh: (b) => b?.length ?? 0,
    shouldCache: (b) => b !== null && b.length <= OBJECT_CACHE_MAX_ITEM,
  });
  private readonly lineStats = new ContentCache<LineStats>({ maxEntries: 50_000 });
  /**
   * Réponses de `GET changes`, indexées par (workspace, portée, génération de base, génération
   * courante), pesées au nombre de fichiers. Une réponse incomplète (lecture du stockage en échec)
   * n'est pas conservée : le rechargement suivant la recalcule.
   */
  private readonly changesResponses = new ContentCache<{ response: ChangesResponse; complete: boolean }>({
    maxEntries: 64,
    maxWeight: RESPONSE_CACHE_MAX_FILES,
    weigh: (v) => Math.max(1, v.response.files.length),
    shouldCache: (v) => v.complete,
  });

  private async manifest(workspaceId: string, generation?: number | null): Promise<Manifest | null> {
    const gen = generation ?? (await this.storage.currentGeneration(workspaceId));
    if (gen <= 0) return null;
    return this.manifests.getOrLoad(`${workspaceId}:${gen}`, () => this.storage.readManifest(workspaceId, gen));
  }

  @Get('files')
  async list(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser, @Query('path', { schema: z.string().max(4096).optional() }) path = ''): Promise<FileEntryDto[]> {
    await this.access.requireWorkspaceRead(user, id);
    const m = await this.manifest(id);
    if (!m) return [];
    const base = fromUserPath(path);
    const prefix = base === '/workspace' ? '/workspace/' : `${base}/`;
    const out: FileEntryDto[] = [];
    for (const e of m.entries) {
      if (!e.p.startsWith(prefix)) continue;
      const rest = e.p.slice(prefix.length);
      if (rest.includes('/')) continue;
      const rel = toUserPath(e.p)!;
      if (HIDDEN.some((re) => re.test(rel)) && rel !== '.git') continue;
      if (rel === '.git' || rel === '.cap') continue;
      out.push({ path: rel, type: e.t === 'd' ? 'dir' : e.t === 'l' ? 'symlink' : 'file', size: e.s });
    }
    return out.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
  }

  /** Liste plate de tous les fichiers (recherche dans l'explorateur et le panneau Modifications). */
  @Get('files/all')
  async all(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser): Promise<string[]> {
    await this.access.requireWorkspaceRead(user, id);
    const m = await this.manifest(id);
    return (m?.entries ?? [])
      .filter((e) => e.t === 'f')
      .map((e) => toUserPath(e.p))
      .filter((p): p is string => !!p && !HIDDEN.some((re) => re.test(p)))
      .slice(0, 50_000);
  }

  @Get('files/content')
  async content(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthUser,
    @Query('path', { schema: z.string().min(1).max(4096) }) path: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FileContentDto> {
    await this.access.requireWorkspaceRead(user, id);
    const m = await this.manifest(id);
    const abs = fromUserPath(path);
    const entry = m?.entries.find((e) => e.p === abs && e.t === 'f');
    if (!entry || !entry.h) throw new AppError('not_found', 'Fichier introuvable');
    res.setHeader('ETag', `"${entry.h}"`);
    if (entry.s > MAX_DISPLAY) return { path, content: null, binary: false, size: entry.s, etag: entry.h, source: 'snapshot' };
    const buf = await this.storage.readObject(id, entry.h);
    const binary = isBinary(buf);
    return { path, content: binary ? null : buf.toString('utf8'), binary, size: entry.s, etag: entry.h, source: 'snapshot' };
  }

  /**
   * Édition manuelle (désactivée par défaut, activable par l'administrateur).
   * `If-Match: "<etag>"` obligatoire (ou `If-None-Match: *` pour créer) : aucun écrasement silencieux.
   */
  @Put('files')
  async write(
    @Param('id', uuid) id: string,
    @Body({ schema: WriteFileSchema }) body: z.infer<typeof WriteFileSchema>,
    @CurrentUser() user: AuthUser,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.access.requireWorkspaceOwner(user, id);
    assertEditablePath(body.path);
    const { manualEditingEnabled } = await this.settings.section('editor');
    if (!manualEditingEnabled) throw new AppError('editing_disabled', 'L’édition manuelle est désactivée par l’administration');
    const expected = ifMatch ? ifMatch.replace(/^W\//, '').replace(/"/g, '') : ifNoneMatch === '*' ? null : undefined;
    if (expected === undefined) throw new AppError('precondition_required', 'En-tête If-Match (ou If-None-Match: *) requis');
    const [run] = await this.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspaceId, id), eq(agentRuns.status, 'running')));
    if (run) throw new AppError('workspace_busy', 'Pi est en cours d’exécution : attendez la fin du run pour éditer');
    const r = await this.rpc.call<{ conflict: boolean; etag?: string; currentEtag?: string | null; generation?: number }>({
      op: 'file.write',
      workspaceId: id,
      path: body.path,
      content: body.content,
      ifMatch: expected,
      userId: user.id,
    });
    if (r.conflict) throw new AppError('edit_conflict', 'Le fichier a été modifié entre-temps (par Pi ou une autre session)', { currentEtag: r.currentEtag });
    res.setHeader('ETag', `"${r.etag}"`);
    await this.audit.record({ actorId: user.id, action: 'file.write', targetType: 'workspace', targetId: id, metadata: { path: body.path, size: body.content.length } });
    return { etag: r.etag, generation: r.generation };
  }

  /* ------------------------- Panneau « Modifications » ------------------------- */

  private async baseGeneration(id: string, scope: ChangeScope): Promise<{ gen: number | null; label: string }> {
    if (scope === 'last_run') {
      const [r] = await this.db
        .select({ g: agentRuns.startGeneration })
        .from(agentRuns)
        .where(and(eq(agentRuns.workspaceId, id), isNotNull(agentRuns.startGeneration)))
        .orderBy(desc(agentRuns.queuedAt))
        .limit(1);
      return { gen: r?.g ?? null, label: 'Depuis le début du dernier run' };
    }
    const [w] = await this.db.select({ g: workspaces.baselineGeneration }).from(workspaces).where(eq(workspaces.id, id));
    return { gen: w?.g ?? null, label: 'Depuis le début de la conversation' };
  }

  @Get('changes')
  async changes(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser, @Query('scope', { schema: ChangeScopeSchema.default('conversation') }) scope: ChangeScope): Promise<ChangesResponse> {
    await this.access.requireWorkspaceRead(user, id);
    if (scope === 'git_head') {
      const r = await this.rpc.call<{ available: boolean; files?: FileChangeDto[] }>({ op: 'git.diff_head', workspaceId: id }, 30_000);
      if (!r.available) return { scope, baseLabel: 'Git indisponible (sandbox arrêtée ou pas de dépôt)', files: [] };
      return { scope, baseLabel: 'Par rapport à HEAD', files: (r.files ?? []).filter((f) => !HIDDEN.some((re) => re.test(f.path))) };
    }
    const { gen, label } = await this.baseGeneration(id, scope);
    const currentGen = await this.storage.currentGeneration(id);
    // Entrées immuables : une même (base, courante) donne toujours la même réponse. Les rechargements
    // déclenchés par les événements SSE, sur chaque onglet et chaque réplique, se résolvent ici.
    return (await this.changesResponses.getOrLoad(`${id}:${scope}:${gen ?? 0}:${currentGen}`, () => this.computeChanges(id, scope, label, gen, currentGen))).response;
  }

  private async computeChanges(id: string, scope: ChangeScope, label: string, gen: number | null, currentGen: number): Promise<{ response: ChangesResponse; complete: boolean }> {
    const current = await this.manifest(id, currentGen);
    if (!current) return { response: { scope, baseLabel: label, files: [] }, complete: true };
    const base = gen ? await this.manifest(id, gen) : null;
    const entries: ChangeEntry[] = [];
    for (const c of diffManifests(base?.entries ?? [], current.entries)) {
      if (c.type === 'd') continue;
      const rel = toUserPath(c.path);
      if (!rel || HIDDEN.some((re) => re.test(rel))) continue;
      entries.push({ path: rel, status: c.status, oldHash: c.oldHash, newHash: c.newHash });
    }
    // Les statistiques ne dépendent que des deux contenus : d'une génération à l'autre, seuls les
    // fichiers réellement modifiés depuis le calcul précédent sont relus dans le stockage.
    const { files, complete } = await buildChangeList(entries, (c) =>
      this.lineStats.getOrLoad(`${id}:${c.oldHash ?? ''}:${c.newHash ?? ''}`, () => this.computeLineStats(id, c.path, c.oldHash, c.newHash)),
    );
    return { response: { scope, baseLabel: label, files }, complete };
  }

  private async computeLineStats(id: string, rel: string, oldHash?: string | null, newHash?: string | null): Promise<LineStats> {
    const before = oldHash ? await this.object(id, oldHash) : null;
    const after = newHash ? await this.object(id, newHash) : null;
    if (isBinary(before) || isBinary(after)) return { additions: 0, deletions: 0, binary: true };
    if ((before?.length ?? 0) + (after?.length ?? 0) >= 4 * MAX_DISPLAY) return { additions: 0, deletions: 0, binary: false };
    const d = unifiedDiff(rel, before?.toString('utf8') ?? null, after?.toString('utf8') ?? null);
    return { additions: d.additions, deletions: d.deletions, binary: false };
  }

  @Get('changes/diff')
  async diff(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthUser,
    @Query('path', { schema: z.string().min(1).max(4096) }) path: string,
    @Query('scope', { schema: ChangeScopeSchema.default('conversation') }) scope: ChangeScope,
  ): Promise<FileDiffDto> {
    await this.access.requireWorkspaceRead(user, id);
    const abs = fromUserPath(path);
    const current = await this.manifest(id);
    const cur = current?.entries.find((e) => e.p === abs && e.t === 'f');
    const modifiedBuf = cur?.h ? await this.object(id, cur.h) : null;
    let originalBuf: Buffer | null = null;
    if (scope === 'git_head') {
      const r = await this.rpc.call<{ available: boolean; original?: string | null }>({ op: 'git.diff_head', workspaceId: id, path }, 30_000);
      originalBuf = r.original ? Buffer.from(r.original, 'base64') : null;
    } else {
      const { gen } = await this.baseGeneration(id, scope);
      const base = gen ? await this.manifest(id, gen) : null;
      const old = base?.entries.find((e) => e.p === abs && e.t === 'f');
      originalBuf = old?.h ? await this.object(id, old.h) : null;
    }
    const binary = isBinary(originalBuf) || isBinary(modifiedBuf);
    if (binary || (originalBuf?.length ?? 0) > MAX_DISPLAY || (modifiedBuf?.length ?? 0) > MAX_DISPLAY) {
      return { path, scope, original: null, modified: null, binary: true, patch: '' };
    }
    const original = originalBuf?.toString('utf8') ?? null;
    const modified = modifiedBuf?.toString('utf8') ?? null;
    return { path, scope, original, modified, binary: false, patch: unifiedDiff(path, original, modified).patch };
  }

  /**
   * Objet par hachage : `null` seulement s'il est absent ou corrompu (définitif) ; une erreur
   * passagère du stockage est propagée, pour ne rien mettre en cache à partir d'une lecture ratée.
   */
  private object(id: string, h: string): Promise<Buffer | null> {
    return this.objects.getOrLoad(`${id}:${h}`, () =>
      this.storage.readObject(id, h).catch((err: unknown) => {
        if (err instanceof IntegrityError) return null;
        throw err;
      }),
    );
  }
}

/**
 * Chemin éditable : relatif à la racine du workspace, sans `.`/`..`, sans antislash ni caractère
 * de contrôle, hors du dépôt Git interne (`.git`) et des fichiers de la plateforme (`.cap`).
 */
export function assertEditablePath(path: string): void {
  const segs = path.split('/');
  const bad =
    path.startsWith('/') ||
    path.endsWith('/') ||
    /[\\\x00-\x1f]/.test(path) ||
    segs.some((s) => s === '' || s === '.' || s === '..') ||
    segs.includes('.git') ||
    segs[0] === '.cap';
  if (bad) throw new AppError('validation_failed', 'Chemin non modifiable : chemin relatif au workspace attendu (hors .git et .cap)');
}

export const etagOf = (s: string) => createHash('sha256').update(s).digest('hex');
