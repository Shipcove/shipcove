/**
 * Rattachement d'un dépôt cloné en cours de conversation (issue #1).
 * Prérequis : `pnpm test:infra:up` (PostgreSQL) et Docker (image `node:22-bookworm`, avec git) :
 * les scripts d'inventaire et de déplacement s'exécutent réellement dans un conteneur.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { conversations, gitConnections, messages, repositories, users, workspaces, type Database } from '@cap/database';
import type { ExecProcess, SandboxHandle, SandboxProvider } from '@cap/sandbox';
import { createTestDatabase, truncateAll } from '@cap/server-core';
import { RepositoryAttachService } from './repository-attach.service.js';

const IMAGE = 'node:22-bookworm';
const dockerOk = (() => {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Fournisseur minimal : `docker exec` dans un conteneur de test. */
function dockerExecProvider(container: string): SandboxProvider {
  return {
    exec: async (_h: SandboxHandle, argv: string[]): Promise<ExecProcess> => {
      const p = spawn('docker', ['exec', '-i', '-w', '/workspace', container, ...argv]);
      p.stdin.end();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      p.stdout.pipe(stdout);
      p.stderr.pipe(stderr);
      const code = new Promise<number>((r) => p.on('close', (c) => r(c ?? 1)));
      return { stdout, stderr, stdin: null, wait: () => code, kill: async () => void p.kill() } as unknown as ExecProcess;
    },
  } as unknown as SandboxProvider;
}

const container = `cap-test-attach-${process.pid}`;
const sh = (script: string) => execFileSync('docker', ['exec', container, 'bash', '-c', script], { encoding: 'utf8' });
let db: Database;
let service: RepositoryAttachService;
let emitted: Array<{ type: string; data: unknown }>;
let workspaceId: string;
let conversationId: string;
let ownerId: string;

describe.skipIf(!dockerOk)('Rattachement d’un dépôt cloné en cours de conversation', () => {
  beforeAll(async () => {
    execFileSync('docker', ['run', '-d', '--rm', '--name', container, IMAGE, 'sleep', 'infinity'], { stdio: 'ignore' });
    db = await createTestDatabase();
    const sandboxes = { provider: dockerExecProvider(container) };
    const checkpoints = { run: async () => ({ generation: 7 }) };
    const git = {
      upsertRepository: async (_tx: unknown, conn: { host: string; provider: 'github' }, fullName: string) => {
        const [row] = await db
          .insert(repositories)
          .values({ provider: conn.provider, host: conn.host, fullName, cloneUrl: `https://${conn.host}/${fullName}.git`, webUrl: `https://${conn.host}/${fullName}`, defaultBranch: 'main' })
          .onConflictDoUpdate({ target: [repositories.host, repositories.fullName], set: { defaultBranch: 'main' } })
          .returning();
        return row;
      },
    };
    const events = { emit: async (_ws: string, type: string, data: unknown) => void emitted.push({ type, data }) };
    service = new RepositoryAttachService(db, sandboxes as never, checkpoints as never, git as never, events as never);
  }, 120_000);

  afterAll(async () => {
    execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    await db?.$client.end();
  });

  beforeEach(async () => {
    emitted = [];
    await truncateAll(db);
    const [u] = await db.insert(users).values({ email: `u-${randomUUID()}@example.test`, username: `u${Date.now()}`, displayName: 'U', status: 'active' }).returning();
    ownerId = u.id;
    await db.insert(gitConnections).values({ userId: u.id, provider: 'github', host: 'github.com', accountId: '1', accountLogin: 'u', secretRef: 'x', authType: 'pat' });
    const [w] = await db.insert(workspaces).values({ ownerId: u.id, name: 'Sans dépôt' }).returning();
    workspaceId = w.id;
    const [c] = await db.insert(conversations).values({ workspaceId: w.id, ownerId: u.id }).returning();
    conversationId = c.id;
    sh('rm -rf /workspace && mkdir -p /workspace/.cap && git config --global user.email t@t && git config --global user.name t && git config --global init.defaultBranch main');
  });

  const sb = () => ({ instanceId: 'i', workspaceId, handle: {} as SandboxHandle, fencingToken: 1, runToken: 't' });
  const makeRepo = (dir: string, origin: string, branch = 'main') =>
    sh(`mkdir -p '${dir}' && cd '${dir}' && git init -q -b ${branch} && echo hi > README.md && git add . && git commit -qm init && git remote add origin '${origin}'`);
  const ws = async () => (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
  const notes = async () => (await db.select().from(messages).where(eq(messages.conversationId, conversationId))).map((m) => m.meta as { kind: string });

  it('clone à la racine : rattaché pendant le run, comme une conversation créée avec le dépôt', async () => {
    makeRepo('/workspace', 'https://github.com/acme/app', 'feature-x');
    expect(await service.tryAttach(sb(), { runId: null, allowMove: false })).toBe('acme/app');
    const w = await ws();
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, w.repositoryId!));
    expect(repo.fullName).toBe('acme/app');
    expect(w).toMatchObject({ branch: 'feature-x', baselineGeneration: 7, initialized: true });
    expect(sh('git -C /workspace remote get-url origin').trim()).toBe('https://github.com/acme/app.git');
    expect(emitted.find((e) => e.type === 'workspace.repository')?.data).toMatchObject({ repository: { fullName: 'acme/app' }, branch: 'feature-x' });
    expect((await notes()).map((n) => n.kind)).toEqual(['repository_attached']);
    // Pas de note pour Pi : les chemins n'ont pas changé.
    expect(await service.pendingAgentNote(workspaceId)).toBeNull();
    // Un second clone ne change rien.
    makeRepo('/workspace/autre', 'https://github.com/acme/autre');
    expect(await service.tryAttach(sb(), { runId: null, allowMove: true })).toBeNull();
    expect((await ws()).repositoryId).toBe(w.repositoryId);
  });

  it('clone en sous-dossier : attend la fin du run, puis remonte le contenu à la racine et prévient Pi', async () => {
    makeRepo('/workspace/app', 'git@github.com:acme/app.git');
    expect(await service.tryAttach(sb(), { runId: null, allowMove: false })).toBeNull();
    expect((await ws()).repositoryId).toBeNull();
    expect(await service.tryAttach(sb(), { runId: null, allowMove: true })).toBe('acme/app');
    expect(sh('ls -A /workspace').split('\n').filter(Boolean).sort()).toEqual(['.cap', '.git', 'README.md']);
    expect(sh('git -C /workspace status --porcelain').trim()).toBe('');
    const note = await service.pendingAgentNote(workspaceId);
    expect(note).toContain('/workspace/app');
    expect(await service.pendingAgentNote(workspaceId)).toBeNull(); // transmise une seule fois
  });

  it('sous-dossier à côté d’autres fichiers : non rattaché, avec une note (une seule fois)', async () => {
    makeRepo('/workspace/app', 'https://github.com/acme/app.git');
    sh('echo notes > /workspace/notes.txt');
    expect(await service.tryAttach(sb(), { runId: null, allowMove: true })).toBeNull();
    expect(await service.tryAttach(sb(), { runId: null, allowMove: true })).toBeNull();
    expect((await ws()).repositoryId).toBeNull();
    expect(sh('ls /workspace/app')).toContain('README.md');
    expect((await notes()).map((n) => n.kind)).toEqual(['repository_not_attached']);
  });

  it('plusieurs dépôts à la fois : aucun rattachement', async () => {
    makeRepo('/workspace/a', 'https://github.com/acme/a.git');
    makeRepo('/workspace/b', 'https://github.com/acme/b.git');
    expect(await service.tryAttach(sb(), { runId: null, allowMove: true })).toBeNull();
    expect((await notes()).map((n) => n.kind)).toEqual(['repository_ambiguous']);
  });

  it('forge sans connexion de l’utilisateur ou dépôt local : ignoré', async () => {
    makeRepo('/workspace', 'https://gitlab.example.com/acme/app.git');
    expect(await service.tryAttach(sb(), { runId: null, allowMove: true })).toBeNull();
    sh('rm -rf /workspace && mkdir -p /workspace');
    makeRepo('/workspace', '/srv/local.git');
    expect(await service.tryAttach(sb(), { runId: null, allowMove: true })).toBeNull();
    expect((await ws()).repositoryId).toBeNull();
    expect(await notes()).toEqual([]);
    expect(ownerId).toBeTruthy();
  });
});
