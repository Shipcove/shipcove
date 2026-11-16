import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DEFAULT_CHECKPOINT_EXCLUDES } from '@cap/contracts';
import { workspaces, type Database } from '@cap/database';
import type { SandboxHandle, SandboxProvider } from '@cap/sandbox';
import { DB, EventsService, NotificationService, ObjectStorage, SettingsService, redactString } from '@cap/server-core';
import { FencingError, WorkspaceStorage, toUserPath, type BlobStore, type CheckpointResult } from '@cap/storage';

/** Adaptateur S3 → BlobStore (bucket des workspaces, distinct des pièces jointes). */
export function s3BlobStore(storage: ObjectStorage): BlobStore {
  const bucket = storage.workspaceBucket;
  return {
    put: (key, body) => storage.put(bucket, key, body, { contentLength: body.length, sha256Base64: createHash('sha256').update(body).digest('base64') }),
    get: (key) => storage.getBuffer(bucket, key),
    head: (key) => storage.head(bucket, key),
    list: (prefix) => storage.list(bucket, prefix),
    deleteMany: (keys) => storage.deleteMany(bucket, keys),
  };
}

export interface CheckpointRequest {
  workspaceId: string;
  fencingToken: number;
  provider: SandboxProvider;
  handle: SandboxHandle;
  reason: string;
  triggerKey?: string;
  runId?: string | null;
}

/**
 * Orchestration des checkpoints côté worker :
 * - sérialisation par workspace dans ce processus (les courses inter-instances sont
 *   arbitrées par le contrôle de génération + fencing en base) ;
 * - événements SSE `checkpoint.*` et `file.changed` ;
 * - en cas d'échec : état `unsynced`, notification, et AUCUNE annonce de réussite.
 */
@Injectable()
export class CheckpointService {
  private readonly logger = new Logger('Checkpoint');
  private readonly chains = new Map<string, Promise<unknown>>();
  readonly storage: WorkspaceStorage;

  constructor(
    @Inject(DB) private readonly db: Database,
    objectStorage: ObjectStorage,
    private readonly events: EventsService,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
  ) {
    this.storage = new WorkspaceStorage(db, s3BlobStore(objectStorage));
  }

  /** Exécute un checkpoint, en série avec les autres checkpoints du même workspace. */
  run(req: CheckpointRequest): Promise<CheckpointResult> {
    const prev = this.chains.get(req.workspaceId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.doCheckpoint(req));
    this.chains.set(req.workspaceId, next);
    void next.finally(() => {
      if (this.chains.get(req.workspaceId) === next) this.chains.delete(req.workspaceId);
    }).catch(() => undefined);
    return next;
  }

  private async doCheckpoint(req: CheckpointRequest): Promise<CheckpointResult> {
    // Captures d'écran de Pi : conservées comme pièces jointes, jamais dans les checkpoints.
    const sandbox = await this.settings.section('sandbox');
    const excludes = [...(sandbox.excludeDependencyDirs ? DEFAULT_CHECKPOINT_EXCLUDES : []), ...sandbox.checkpointExcludes, '.cap/screenshots'];
    await this.db.update(workspaces).set({ syncState: 'syncing' }).where(eq(workspaces.id, req.workspaceId));
    let attempt = 0;
    for (;;) {
      try {
        const result = await this.storage.checkpoint({
          workspaceId: req.workspaceId,
          fencingToken: req.fencingToken,
          provider: req.provider,
          handle: req.handle,
          reason: req.reason,
          triggerKey: req.triggerKey,
          excludes,
        });
        await this.db.update(workspaces).set({ syncState: 'synced' }).where(eq(workspaces.id, req.workspaceId));
        if (result.created) {
          const paths = result.changed.map((c) => toUserPath(c.path)).filter((p): p is string => p !== null && p !== '');
          await this.events.append(req.workspaceId, [
            ...(paths.length ? [{ type: 'file.changed' as const, runId: req.runId ?? null, data: { paths: paths.slice(0, 500), generation: result.generation } }] : []),
            {
              type: 'checkpoint.completed' as const,
              runId: req.runId ?? null,
              data: { generation: result.generation, changedFiles: result.changed.length, bytesUploaded: result.bytesUploaded },
            },
          ]);
        }
        return result;
      } catch (err) {
        attempt++;
        // Course de génération entre instances (même lease) : une nouvelle tentative suffit.
        if (err instanceof FencingError && attempt < 3) {
          const lease = await this.db.execute<{ fencing_token: number }>(
            sql`select fencing_token from workspace_leases where workspace_id = ${req.workspaceId}`,
          );
          if (Number(lease.rows[0]?.fencing_token) === req.fencingToken) continue;
        }
        const message = redactString((err as Error).message);
        this.logger.error(`Checkpoint ${req.workspaceId} : ${message}`);
        await this.db.update(workspaces).set({ syncState: 'unsynced' }).where(eq(workspaces.id, req.workspaceId));
        const willRetry = !(err instanceof FencingError);
        await this.events.emit(req.workspaceId, 'checkpoint.failed', { error: message.slice(0, 500), willRetry }, req.runId ?? null);
        const [w] = await this.db.select({ ownerId: workspaces.ownerId, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, req.workspaceId));
        if (w) {
          await this.notifications.notify({
            userId: w.ownerId,
            type: 'checkpoint.failed',
            title: `Sauvegarde du workspace « ${w.name} » en échec`,
            body: 'Les dernières modifications ne sont pas encore synchronisées. Une nouvelle tentative est programmée.',
            link: `/workspaces/${req.workspaceId}`,
            dedupeKey: `ckpt-fail:${req.workspaceId}:${Math.floor(Date.now() / 600_000)}`,
          });
        }
        throw err;
      }
    }
  }
}
