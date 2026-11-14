/**
 * Test d'intégration réel : sandbox Docker (image officielle), Garage S3, PostgreSQL.
 * Prérequis : `pnpm test:infra:up` et l'image `shipcove-sandbox:latest`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { projects, teams, users, workspaces, type Database } from '@cap/database';
import { DockerSandboxProvider, execCollect, type SandboxHandle } from '@cap/sandbox';
import { createTestDatabase, truncateAll } from '@cap/server-core';
import { FencingError, LeaseService, WorkspaceStorage, type BlobStore } from './index.js';

const BUCKET = 'cap-test';
const s3 = new S3Client({
  endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:3910',
  region: 'garage',
  forcePathStyle: true,
  credentials: { accessKeyId: 'GK000000000000000000000000', secretAccessKey: '0'.repeat(64) },
});
const blobs: BlobStore = {
  async put(key, body) {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
  },
  async get(key) {
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      return Buffer.from(await r.Body!.transformToByteArray());
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  },
  async head(key) {
    try {
      const r = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      return { size: Number(r.ContentLength) };
    } catch {
      return null;
    }
  },
  async list(prefix) {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
    return (r.Contents ?? []).map((o) => ({ key: o.Key!, size: Number(o.Size) }));
  },
  async deleteMany(keys) {
    if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
  },
};

const provider = new DockerSandboxProvider({ network: 'bridge' });
let db: Database;
let storage: WorkspaceStorage;
let leases: LeaseService;
let workspaceId: string;
const handles: SandboxHandle[] = [];

async function sandbox(): Promise<SandboxHandle> {
  const h = await provider.create({
    instanceId: randomUUID(),
    workspaceId,
    ownerId: randomUUID(),
    image: 'shipcove-sandbox:latest',
    resources: { cpu: 1, memoryMb: 512, diskMb: 2048, pidsLimit: 256 },
    env: {},
  });
  handles.push(h);
  return provider.start(h);
}
const sh = async (h: SandboxHandle, script: string) => {
  const r = await execCollect(provider, h, ['bash', '-lc', script]);
  if (r.exitCode !== 0) throw new Error(`${script}: ${r.stderr.toString()}`);
  return r.stdout.toString('utf8');
};

beforeAll(async () => {
  db = await createTestDatabase();
  await truncateAll(db);
  storage = new WorkspaceStorage(db, blobs);
  leases = new LeaseService(db);
  const [u] = await db.insert(users).values({ email: 's@x.io', username: 's', displayName: 'S' }).returning();
  const [t] = await db.insert(teams).values({ name: 'T', slug: 't-storage' }).returning();
  const [p] = await db.insert(projects).values({ teamId: t.id, name: 'P' }).returning();
  const [w] = await db.insert(workspaces).values({ projectId: p.id, teamId: t.id, ownerId: u.id, name: 'W' }).returning();
  workspaceId = w.id;
});

afterAll(async () => {
  for (const h of handles) await provider.destroy(h).catch(() => undefined);
  await db.$client.end();
});

describe('WorkspaceStorage (intégration Docker + S3 + PostgreSQL)', () => {
  it('capture les écritures shell, restaure fidèlement (Git compris) et applique le fencing', async () => {
    const lease = (await leases.acquire(workspaceId, 'worker-a', 60_000))!;
    const a = await sandbox();
    // Écritures réelles via shell (pas via les outils write/edit de Pi).
    await sh(
      a,
      `cd /workspace && git init -q && git config user.email t@t && git config user.name t &&
       echo "v1" > a.txt && mkdir -p src/deep && printf 'x%.0s' {1..5000} > src/deep/big.txt &&
       git add . && git commit -qm init && echo "v2 non commité" >> a.txt && echo staged > s.txt && git add s.txt &&
       ln -s a.txt lien && chmod 750 src/deep/big.txt && mkdir -p empty/dir &&
       mkdir -p /workspace-state/pi-sessions && echo '{"type":"session"}' > /workspace-state/pi-sessions/s.jsonl`,
    );
    const c1 = await storage.checkpoint({ workspaceId, fencingToken: lease.fencingToken, provider, handle: a, reason: 'test', triggerKey: 't1' });
    expect(c1.created).toBe(true);
    expect(c1.generation).toBe(1);
    // Idempotence par événement d'écriture.
    const again = await storage.checkpoint({ workspaceId, fencingToken: lease.fencingToken, provider, handle: a, reason: 'test', triggerKey: 't1' });
    expect(again).toMatchObject({ generation: 1, created: false });

    // Modification + suppression via shell → incrémental.
    await sh(a, 'cd /workspace && echo nouveau > b.txt && rm s.txt && git rm -q --cached s.txt || true');
    const c2 = await storage.checkpoint({ workspaceId, fencingToken: lease.fencingToken, provider, handle: a, reason: 'test', triggerKey: 't2' });
    expect(c2.generation).toBe(2);
    const paths = c2.changed.map((c) => `${c.status}:${c.path}`);
    expect(paths).toContain('added:/workspace/b.txt');
    expect(paths).toContain('deleted:/workspace/s.txt');
    expect(c2.bytesUploaded).toBeLessThan(5000); // big.txt non re-téléversé

    // Rien n'a changé → pas de nouvelle génération.
    const c3 = await storage.checkpoint({ workspaceId, fencingToken: lease.fencingToken, provider, handle: a, reason: 'noop' });
    expect(c3).toMatchObject({ generation: 2, created: false });

    const before = await sh(a, 'cd /workspace && git status --porcelain && git log --oneline | wc -l && md5sum a.txt b.txt src/deep/big.txt && readlink lien && stat -c %a src/deep/big.txt && ls -d empty/dir');

    // Destruction de la sandbox, nouvelle sandbox, restauration.
    await provider.destroy(a);
    const b = await sandbox();
    const restored = await storage.restore({ workspaceId, fencingToken: lease.fencingToken, provider, handle: b });
    expect(restored.generation).toBe(2);
    const after = await sh(b, 'cd /workspace && git status --porcelain && git log --oneline | wc -l && md5sum a.txt b.txt src/deep/big.txt && readlink lien && stat -c %a src/deep/big.txt && ls -d empty/dir');
    expect(after).toBe(before);
    expect(await sh(b, 'cat /workspace-state/pi-sessions/s.jsonl')).toContain('session');
    expect((await storage.verify(workspaceId, 2)).ok).toBe(true);

    // Un autre worker prend le lease (après expiration) : l'ancien ne peut plus publier.
    await db.execute(`update workspace_leases set expires_at = now() - interval '1 second' where workspace_id = '${workspaceId}'` as never);
    const lease2 = (await leases.acquire(workspaceId, 'worker-b', 60_000))!;
    expect(lease2.fencingToken).toBe(lease.fencingToken + 1);
    await sh(b, 'echo stale > /workspace/stale.txt');
    await expect(storage.checkpoint({ workspaceId, fencingToken: lease.fencingToken, provider, handle: b, reason: 'stale' })).rejects.toBeInstanceOf(FencingError);
    const c4 = await storage.checkpoint({ workspaceId, fencingToken: lease2.fencingToken, provider, handle: b, reason: 'ok' });
    expect(c4.generation).toBe(3);
  });
});
