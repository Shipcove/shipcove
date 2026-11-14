import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { and, desc, eq, sql } from 'drizzle-orm';
import tar from 'tar-stream';
import { workspaceSnapshots, workspaces, type Database } from '@cap/database';
import { execCollect, type SandboxHandle, type SandboxProvider } from '@cap/sandbox';
import { MANIFEST_VERSION, ROOTS, diffManifests, sameTree, type Manifest, type ManifestChange, type ManifestEntry } from './manifest.js';

/** Stockage objet minimal requis (implémenté par S3 côté serveur, en mémoire dans les tests). */
export interface BlobStore {
  put(key: string, body: Buffer, sha256Base64?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  head(key: string): Promise<{ size: number } | null>;
  list(prefix: string): Promise<Array<{ key: string; size: number }>>;
  deleteMany(keys: string[]): Promise<void>;
}

export class FencingError extends Error {
  constructor(workspaceId: string) {
    super(`Lease perdu pour le workspace ${workspaceId} (writer périmé)`);
    this.name = 'FencingError';
  }
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrityError';
  }
}

export interface CheckpointInput {
  workspaceId: string;
  fencingToken: number;
  provider: SandboxProvider;
  handle: SandboxHandle;
  reason: string;
  /** Clé d'idempotence de l'événement d'écriture (ex. `tool:<runId>:<toolCallId>`). */
  triggerKey?: string;
  excludes?: string[];
}

export interface CheckpointResult {
  generation: number;
  snapshotId: string;
  changed: ManifestChange[];
  bytesUploaded: number;
  /** `false` si l'arborescence était identique (aucune nouvelle génération). */
  created: boolean;
}

const MAX_INLINE_FILE = 512 * 1024 * 1024;

/**
 * Checkpoints incrémentaux adressés par contenu (ADR 0006).
 * Invariants :
 *  - un manifeste n'est publié comme courant qu'après vérification de tous ses objets ;
 *  - la publication est conditionnée au fencing token du lease (writer périmé → FencingError) ;
 *  - idempotence par `triggerKey` ;
 *  - aucune écriture n'est annoncée réussie en cas d'erreur.
 */
export class WorkspaceStorage {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
  ) {}

  manifestKey(workspaceId: string, generation: number): string {
    return `workspaces/${workspaceId}/manifests/${String(generation).padStart(10, '0')}.json.gz`;
  }

  objectKey(workspaceId: string, sha256: string): string {
    return `workspaces/${workspaceId}/objects/${sha256.slice(0, 2)}/${sha256}`;
  }

  /* ------------------------------ Lecture ------------------------------ */

  async currentGeneration(workspaceId: string): Promise<number> {
    const [w] = await this.db.select({ g: workspaces.currentGeneration }).from(workspaces).where(eq(workspaces.id, workspaceId));
    return w?.g ?? 0;
  }

  async readManifest(workspaceId: string, generation: number): Promise<Manifest | null> {
    if (generation <= 0) return null;
    const [snap] = await this.db
      .select()
      .from(workspaceSnapshots)
      .where(and(eq(workspaceSnapshots.workspaceId, workspaceId), eq(workspaceSnapshots.generation, generation)));
    if (!snap) return null;
    const buf = await this.blobs.get(snap.manifestKey);
    if (!buf) throw new IntegrityError(`Manifeste ${generation} absent du stockage`);
    if (sha256(buf) !== snap.manifestSha256) throw new IntegrityError(`Manifeste ${generation} corrompu`);
    return JSON.parse(gunzipSync(buf).toString('utf8')) as Manifest;
  }

  /** Contenu d'un fichier d'un checkpoint (vérifié). */
  async readObject(workspaceId: string, sha: string): Promise<Buffer> {
    const buf = await this.blobs.get(this.objectKey(workspaceId, sha));
    if (!buf) throw new IntegrityError(`Objet ${sha} absent`);
    if (sha256(buf) !== sha) throw new IntegrityError(`Objet ${sha} corrompu`);
    return buf;
  }

  /* ----------------------------- Checkpoint ---------------------------- */

  async checkpoint(input: CheckpointInput): Promise<CheckpointResult> {
    const { workspaceId } = input;
    if (input.triggerKey) {
      const [existing] = await this.db
        .select()
        .from(workspaceSnapshots)
        .where(and(eq(workspaceSnapshots.workspaceId, workspaceId), eq(workspaceSnapshots.triggerKey, input.triggerKey)));
      if (existing) return { generation: existing.generation, snapshotId: existing.id, changed: [], bytesUploaded: 0, created: false };
    }
    await this.assertFencing(workspaceId, input.fencingToken);

    // 1. Inventaire réel du système de fichiers de la sandbox.
    const scan = await execCollect(
      input.provider,
      input.handle,
      ['/opt/cap/bin/cap-snapshot', 'scan', ...ROOTS, ...(input.excludes ?? []).flatMap((e) => ['--exclude', e])],
      { timeoutMs: 600_000 },
    );
    if (scan.exitCode !== 0) throw new Error(`cap-snapshot a échoué (${scan.exitCode}) : ${scan.stderr.toString('utf8').slice(0, 500)}`);
    const { entries } = JSON.parse(scan.stdout.toString('utf8')) as { entries: ManifestEntry[] };

    const prevGen = await this.currentGeneration(workspaceId);
    const prev = await this.readManifest(workspaceId, prevGen);
    if (prev && sameTree(prev.entries, entries)) {
      const [snap] = await this.db
        .select({ id: workspaceSnapshots.id })
        .from(workspaceSnapshots)
        .where(and(eq(workspaceSnapshots.workspaceId, workspaceId), eq(workspaceSnapshots.generation, prevGen)));
      return { generation: prevGen, snapshotId: snap.id, changed: [], bytesUploaded: 0, created: false };
    }

    // 2. Objets à téléverser : hachages absents du manifeste précédent et du stockage.
    const known = new Set((prev?.entries ?? []).filter((e) => e.h).map((e) => e.h!));
    const needed = new Map<string, ManifestEntry>();
    for (const e of entries) {
      if (e.t === 'f' && e.h && !known.has(e.h) && !needed.has(e.h)) needed.set(e.h, e);
    }
    for (const [h] of [...needed]) {
      if (await this.blobs.head(this.objectKey(workspaceId, h))) needed.delete(h);
    }

    // 3. Extraction (tar) des fichiers nécessaires ; le hachage réel du contenu transféré fait foi.
    let bytesUploaded = 0;
    const finalHash = new Map<string, string>(); // chemin -> hachage effectivement téléversé
    if (needed.size > 0) {
      const paths = [...needed.values()].map((e) => e.p.replace(/^\//, ''));
      const proc = await input.provider.exec(input.handle, ['tar', '-c', '-f', '-', '-C', '/', '--null', '-T', '-', '--ignore-failed-read'], {
        stdin: Buffer.from(`${paths.join('\0')}\0`),
        timeoutMs: 1_800_000,
      });
      const extract = tar.extract();
      const done = new Promise<void>((resolve, reject) => {
        extract.on('entry', (header, stream, next) => {
          if (header.type !== 'file') {
            stream.resume();
            stream.on('end', next);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on('data', (raw: unknown) => {
            const c = raw as Buffer;
            size += c.length;
            if (size > MAX_INLINE_FILE) {
              stream.destroy(new Error(`Fichier trop volumineux pour un checkpoint : /${header.name}`));
              return;
            }
            chunks.push(c);
          });
          stream.on('end', () => {
            const body = Buffer.concat(chunks);
            const h = sha256(body);
            finalHash.set(`/${header.name.replace(/^\.?\/*/, '')}`, h);
            this.blobs
              .put(this.objectKey(workspaceId, h), body, createHash('sha256').update(body).digest('base64'))
              .then(() => {
                bytesUploaded += body.length;
                next();
              })
              .catch(reject);
          });
          stream.on('error', reject);
        });
        extract.on('finish', resolve);
        extract.on('error', reject);
      });
      proc.stdout.pipe(extract);
      const [code] = await Promise.all([proc.wait(), done]);
      if (code !== 0 && code !== 1) throw new Error(`tar a échoué (code ${code})`);
    }
    // Fichiers disparus entre l'inventaire et le tar : retirés du manifeste ; fichiers modifiés
    // entre-temps : le contenu effectivement téléversé fait foi.
    const finalEntries: ManifestEntry[] = [];
    for (const e of entries) {
      if (e.t === 'f' && e.h && needed.has(e.h) && needed.get(e.h)!.p === e.p) {
        const h = finalHash.get(e.p);
        if (!h) continue;
        finalEntries.push({ ...e, h });
      } else {
        finalEntries.push(e);
      }
    }
    // Les doublons de contenu pointent vers le hachage téléversé par leur représentant.
    const repHash = new Map<string, string>();
    for (const [h, e] of needed) repHash.set(h, finalHash.get(e.p) ?? h);
    for (const e of finalEntries) if (e.t === 'f' && e.h && repHash.has(e.h)) e.h = repHash.get(e.h);

    // 4. Vérification : chaque objet référencé existe avec la bonne taille.
    const toVerify = new Map<string, number>();
    for (const e of finalEntries) if (e.t === 'f' && e.h && !known.has(e.h)) toVerify.set(e.h, e.s);
    for (const [h] of toVerify) {
      const head = await this.blobs.head(this.objectKey(workspaceId, h));
      if (!head) throw new IntegrityError(`Objet ${h} non vérifié après téléversement`);
    }

    // 5. Manifeste puis publication sous fencing.
    const generation = prevGen + 1;
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      workspaceId,
      generation,
      parentGeneration: prevGen || null,
      createdAt: new Date().toISOString(),
      roots: [...ROOTS],
      entries: finalEntries,
    };
    const manifestBuf = gzipSync(Buffer.from(JSON.stringify(manifest)));
    const manifestKey = this.manifestKey(workspaceId, generation);
    await this.blobs.put(manifestKey, manifestBuf);
    const check = await this.blobs.get(manifestKey);
    if (!check || sha256(check) !== sha256(manifestBuf)) throw new IntegrityError('Manifeste non vérifié après écriture');

    const changed = diffManifests(prev?.entries ?? null, finalEntries);
    const snapshotId = await this.db.transaction(async (tx) => {
      // Verrou sur le lease : le fencing token doit être celui du writer courant.
      const lease = await tx.execute<{ fencing_token: number }>(
        sql`select fencing_token from workspace_leases where workspace_id = ${workspaceId} for update`,
      );
      if (Number(lease.rows[0]?.fencing_token) !== input.fencingToken) throw new FencingError(workspaceId);
      const updated = await tx
        .update(workspaces)
        .set({ currentGeneration: generation, lastCheckpointAt: new Date(), syncState: 'synced' })
        .where(and(eq(workspaces.id, workspaceId), eq(workspaces.currentGeneration, prevGen)))
        .returning({ id: workspaces.id });
      if (updated.length === 0) throw new FencingError(workspaceId);
      const [snap] = await tx
        .insert(workspaceSnapshots)
        .values({
          workspaceId,
          generation,
          parentGeneration: prevGen || null,
          manifestKey,
          manifestSha256: sha256(manifestBuf),
          fileCount: finalEntries.filter((e) => e.t === 'f').length,
          totalBytes: finalEntries.reduce((a, e) => a + (e.t === 'f' ? e.s : 0), 0),
          changedFiles: changed.length,
          bytesUploaded,
          fencingToken: input.fencingToken,
          reason: input.reason,
          triggerKey: input.triggerKey ?? null,
        })
        .returning({ id: workspaceSnapshots.id });
      await tx.update(workspaces).set({ currentSnapshotId: snap.id }).where(eq(workspaces.id, workspaceId));
      return snap.id;
    });
    return { generation, snapshotId, changed, bytesUploaded, created: true };
  }

  /* ----------------------------- Restauration -------------------------- */

  /**
   * Restaure le dernier checkpoint validé dans une sandbox vierge (vérification sha256 de chaque objet).
   * Renvoie la génération restaurée (0 = aucun état antérieur).
   */
  async restore(input: { workspaceId: string; fencingToken: number; provider: SandboxProvider; handle: SandboxHandle }): Promise<{ generation: number; files: number }> {
    await this.assertFencing(input.workspaceId, input.fencingToken);
    const generation = await this.currentGeneration(input.workspaceId);
    const manifest = await this.readManifest(input.workspaceId, generation);
    if (!manifest) return { generation: 0, files: 0 };

    const pack = tar.pack();
    const proc = await input.provider.exec(input.handle, ['tar', '-x', '-f', '-', '-C', '/', '--no-same-owner', '--delay-directory-restore'], {
      stdin: pack.pipe(new PassThrough()),
      timeoutMs: 1_800_000,
    });
    const stderr: Buffer[] = [];
    proc.stderr.on('data', (c: Buffer) => stderr.push(c));
    proc.stdout.resume();
    const ordered = [...manifest.entries].sort((a, b) => a.p.localeCompare(b.p));
    let files = 0;
    try {
      for (const e of ordered) {
        const name = e.p.replace(/^\//, '');
        const mtime = new Date(e.mt);
        if (e.t === 'd') {
          await entry(pack, { name, type: 'directory', mode: e.m, mtime });
        } else if (e.t === 'l') {
          await entry(pack, { name, type: 'symlink', linkname: e.l!, mode: e.m, mtime });
        } else {
          const body = await this.readObject(input.workspaceId, e.h!);
          await entry(pack, { name, type: 'file', mode: e.m, mtime, size: body.length }, body);
          files++;
        }
      }
      pack.finalize();
    } catch (err) {
      pack.destroy(err as Error);
      await proc.kill();
      throw err;
    }
    const code = await proc.wait();
    if (code !== 0) throw new Error(`Restauration : tar a échoué (code ${code}) ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`);
    return { generation, files };
  }

  /**
   * Retour en arrière : ramène les fichiers de `/workspace` à l'état d'une génération antérieure,
   * dans une sandbox active, sans toucher à l'état de Pi (`/workspace-state`) ni aux chemins exclus
   * des checkpoints (absents des manifestes). Seuls sont supprimés les chemins présents dans le
   * checkpoint courant et absents de la cible ; seuls sont réécrits ceux qui diffèrent.
   * L'appelant publie ensuite un nouveau checkpoint : l'historique est conservé (réversible).
   */
  async rewind(input: { workspaceId: string; fencingToken: number; provider: SandboxProvider; handle: SandboxHandle; targetGeneration: number }): Promise<{ deleted: number; written: number }> {
    await this.assertFencing(input.workspaceId, input.fencingToken);
    const target = await this.readManifest(input.workspaceId, input.targetGeneration);
    if (!target) throw new Error(`Point de restauration ${input.targetGeneration} introuvable (purgé ?)`);
    const current = await this.readManifest(input.workspaceId, await this.currentGeneration(input.workspaceId));
    const inWorkspace = (e: ManifestEntry) => e.p.startsWith('/workspace/');
    const targetBy = new Map(target.entries.filter(inWorkspace).map((e) => [e.p, e]));
    const currentEntries = (current?.entries ?? []).filter(inWorkspace);
    const same = (a: ManifestEntry, b: ManifestEntry) => a.t === b.t && a.h === b.h && a.l === b.l && a.m === b.m;

    // Suppressions (y compris changement de type), des plus profonds aux moins profonds.
    const toDelete = currentEntries.filter((e) => {
      const t = targetBy.get(e.p);
      return !t || t.t !== e.t;
    });
    const topLevel = toDelete
      .map((e) => e.p)
      .sort()
      .filter((p, i, all) => !all.slice(0, i).some((q) => p.startsWith(`${q}/`)));
    for (let i = 0; i < topLevel.length; i += 200) {
      const proc = await input.provider.exec(input.handle, ['rm', '-rf', '--', ...topLevel.slice(i, i + 200)], { timeoutMs: 300_000 });
      proc.stdout.resume();
      proc.stderr.resume();
      const code = await proc.wait();
      if (code !== 0) throw new Error(`Retour en arrière : suppression impossible (code ${code})`);
    }
    // Écritures : entrées absentes ou différentes de l'état courant.
    const currentBy = new Map(currentEntries.map((e) => [e.p, e]));
    const toWrite = [...targetBy.values()].filter((t) => {
      const c = currentBy.get(t.p);
      return !c || !same(c, t) || toDelete.some((d) => t.p === d.p || t.p.startsWith(`${d.p}/`));
    });
    if (toWrite.length) await this.extract(input.workspaceId, toWrite, input.provider, input.handle);
    return { deleted: topLevel.length, written: toWrite.filter((e) => e.t === 'f').length };
  }

  /** Dépose des entrées de manifeste dans la sandbox (flux tar, sans shell). */
  private async extract(workspaceId: string, entries: ManifestEntry[], provider: SandboxProvider, handle: SandboxHandle): Promise<number> {
    const pack = tar.pack();
    const proc = await provider.exec(handle, ['tar', '-x', '-f', '-', '-C', '/', '--no-same-owner', '--delay-directory-restore'], {
      stdin: pack.pipe(new PassThrough()),
      timeoutMs: 1_800_000,
    });
    const stderr: Buffer[] = [];
    proc.stderr.on('data', (c: Buffer) => stderr.push(c));
    proc.stdout.resume();
    let files = 0;
    try {
      for (const e of [...entries].sort((a, b) => a.p.localeCompare(b.p))) {
        const name = e.p.replace(/^\//, '');
        const mtime = new Date(e.mt);
        if (e.t === 'd') await entry(pack, { name, type: 'directory', mode: e.m, mtime });
        else if (e.t === 'l') await entry(pack, { name, type: 'symlink', linkname: e.l!, mode: e.m, mtime });
        else {
          const body = await this.readObject(workspaceId, e.h!);
          await entry(pack, { name, type: 'file', mode: e.m, mtime, size: body.length }, body);
          files++;
        }
      }
      pack.finalize();
    } catch (err) {
      pack.destroy(err as Error);
      await proc.kill();
      throw err;
    }
    const code = await proc.wait();
    if (code !== 0) throw new Error(`Restauration : tar a échoué (code ${code}) ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`);
    return files;
  }

  /** Vérifie l'intégrité d'un checkpoint (manifeste + présence/taille de chaque objet). */
  async verify(workspaceId: string, generation: number): Promise<{ ok: boolean; missing: string[] }> {
    const manifest = await this.readManifest(workspaceId, generation);
    if (!manifest) return { ok: generation === 0, missing: [] };
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const e of manifest.entries) {
      if (e.t !== 'f' || !e.h || seen.has(e.h)) continue;
      seen.add(e.h);
      const head = await this.blobs.head(this.objectKey(workspaceId, e.h));
      if (!head || head.size !== e.s) missing.push(e.p);
    }
    return { ok: missing.length === 0, missing };
  }

  /**
   * Nettoyage : conserve les `keep` dernières générations (et la courante), supprime les
   * manifestes plus anciens puis les objets non référencés. Contrôle de génération : la
   * génération courante n'est jamais supprimée.
   */
  async cleanup(workspaceId: string, keep = 20): Promise<{ manifestsDeleted: number; objectsDeleted: number }> {
    const snaps = await this.db
      .select()
      .from(workspaceSnapshots)
      .where(and(eq(workspaceSnapshots.workspaceId, workspaceId), eq(workspaceSnapshots.status, 'validated')))
      .orderBy(desc(workspaceSnapshots.generation));
    const current = await this.currentGeneration(workspaceId);
    const kept = snaps.filter((s, i) => i < keep || s.generation === current);
    const dropped = snaps.filter((s) => !kept.includes(s));
    const referenced = new Set<string>();
    for (const s of kept) {
      const m = await this.readManifest(workspaceId, s.generation);
      for (const e of m?.entries ?? []) if (e.h) referenced.add(e.h);
    }
    const objects = await this.blobs.list(`workspaces/${workspaceId}/objects/`);
    const orphanObjects = objects.filter((o) => !referenced.has(o.key.split('/').pop()!)).map((o) => o.key);
    if (dropped.length) {
      await this.db
        .update(workspaceSnapshots)
        .set({ status: 'purged' })
        .where(and(eq(workspaceSnapshots.workspaceId, workspaceId), sql`${workspaceSnapshots.generation} in (${sql.join(dropped.map((d) => sql`${d.generation}`), sql`, `)})`));
      await this.blobs.deleteMany(dropped.map((d) => d.manifestKey));
    }
    if (orphanObjects.length) await this.blobs.deleteMany(orphanObjects);
    return { manifestsDeleted: dropped.length, objectsDeleted: orphanObjects.length };
  }

  /** Suppression complète (suppression définitive d'un workspace). */
  async purgeAll(workspaceId: string): Promise<number> {
    const all = await this.blobs.list(`workspaces/${workspaceId}/`);
    await this.blobs.deleteMany(all.map((o) => o.key));
    return all.length;
  }

  private async assertFencing(workspaceId: string, token: number): Promise<void> {
    const res = await this.db.execute<{ fencing_token: number }>(sql`select fencing_token from workspace_leases where workspace_id = ${workspaceId}`);
    if (Number(res.rows[0]?.fencing_token) !== token) throw new FencingError(workspaceId);
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function entry(pack: tar.Pack, header: Partial<tar.Header> & { name: string }, body?: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const cb = (err?: Error | null) => (err ? reject(err) : resolve());
    if (body) pack.entry(header as tar.Header, body, cb);
    else pack.entry(header as tar.Header, cb);
  });
}
