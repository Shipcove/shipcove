import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { workspaces, type Database } from '@cap/database';
import { execCollect } from '@cap/sandbox';
import { DB, EventsService } from '@cap/server-core';
import { fromUserPath } from '@cap/storage';
import { JobRunner, PermanentJobError } from '../jobs/job-runner.service.js';
import { CheckpointService } from '../sandbox/checkpoint.service.js';
import { SandboxManager } from '../sandbox/sandbox-manager.service.js';
import { RetentionService } from '../maintenance/retention.service.js';

type RpcPayload =
  | { op: 'workspace.start'; workspaceId: string }
  | { op: 'workspace.stop'; workspaceId: string; reason?: string; force?: boolean }
  | { op: 'workspace.delete'; workspaceId: string }
  | { op: 'git.status'; workspaceId: string }
  | { op: 'git.diff_head'; workspaceId: string; path?: string }
  | { op: 'git.fetch'; workspaceId: string }
  | { op: 'git.pull'; workspaceId: string; branch?: string }
  | { op: 'file.write'; workspaceId: string; path: string; content: string; ifMatch: string | null; userId: string };

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/**
 * Opérations internes déléguées par l'API (qui n'a aucun accès au moteur de conteneurs).
 * Ce ne sont PAS des exécutions shell arbitraires : chaque opération est fixe et paramétrée.
 */
@Injectable()
export class SandboxRpcService implements OnApplicationBootstrap {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly runner: JobRunner,
    private readonly sandboxes: SandboxManager,
    private readonly checkpoints: CheckpointService,
    private readonly events: EventsService,
    private readonly retention: RetentionService,
  ) {}

  onApplicationBootstrap(): void {
    this.runner.register('sandbox.rpc', (p) => this.handle(p as RpcPayload), { concurrency: 16, leaseMs: 300_000 });
  }

  private async handle(p: RpcPayload): Promise<unknown> {
    switch (p.op) {
      case 'workspace.start': {
        await this.sandboxes.ensureRunning(p.workspaceId);
        return { status: 'running' };
      }
      case 'workspace.stop':
        return this.sandboxes.stop(p.workspaceId, p.reason ?? 'user', { force: p.force });
      case 'workspace.delete': {
        // Suppression définitive demandée : la sandbox est détruite sans checkpoint final.
        await this.sandboxes.stop(p.workspaceId, 'suppression', { force: true });
        await this.retention.hardDeleteWorkspace(p.workspaceId);
        return { deleted: true };
      }
      case 'git.status':
        return this.gitStatus(p.workspaceId);
      case 'git.diff_head':
        return this.diffHead(p.workspaceId, p.path);
      case 'git.fetch':
      case 'git.pull': {
        const sb = await this.sandboxes.ensureRunning(p.workspaceId);
        const argv = p.op === 'git.fetch' ? ['git', 'fetch', '--prune', 'origin'] : ['git', 'pull', '--ff-only', 'origin', ...(p.branch ? [p.branch] : [])];
        const r = await execCollect(this.sandboxes.provider, sb.handle, argv, { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 300_000 });
        if (p.op === 'git.pull') {
          await this.checkpoints.run({ workspaceId: p.workspaceId, fencingToken: sb.fencingToken, provider: this.sandboxes.provider, handle: sb.handle, reason: 'git_pull' });
        }
        await this.sandboxes.touch(p.workspaceId);
        return { ok: r.exitCode === 0, output: (r.stdout.toString() + r.stderr.toString()).replace(/Bearer \S+/g, 'Bearer [REDACTED]').slice(0, 10_000) };
      }
      case 'file.write':
        return this.writeFile(p);
      default:
        throw new PermanentJobError('Opération inconnue');
    }
  }

  private async gitStatus(workspaceId: string) {
    const sb = await this.sandboxes.getActive(workspaceId);
    if (!sb) return { available: false, source: 'unavailable' };
    const r = await execCollect(this.sandboxes.provider, sb.handle, ['git', 'status', '--porcelain=v2', '--branch', '-z']);
    if (r.exitCode !== 0) return { available: false, source: 'unavailable' };
    const out = { available: true, branch: null as string | null, head: null as string | null, upstream: null as string | null, ahead: 0, behind: 0, staged: [] as string[], unstaged: [] as string[], untracked: [] as string[], conflicted: [] as string[], source: 'sandbox' };
    const parts = r.stdout.toString('utf8').split('\0');
    for (let i = 0; i < parts.length; i++) {
      const line = parts[i];
      if (line.startsWith('# branch.head ')) out.branch = line.slice(14);
      else if (line.startsWith('# branch.oid ')) out.head = line.slice(13) === '(initial)' ? null : line.slice(13);
      else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
      else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(line);
        if (m) [out.ahead, out.behind] = [Number(m[1]), Number(m[2])];
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
        const fields = line.split(' ');
        const xy = fields[1];
        const path = line.startsWith('1 ') ? fields.slice(8).join(' ') : fields.slice(9).join(' ');
        if (line.startsWith('2 ')) i++; // chemin d'origine du renommage
        if (xy[0] !== '.') out.staged.push(path);
        if (xy[1] !== '.') out.unstaged.push(path);
      } else if (line.startsWith('u ')) out.conflicted.push(line.split(' ').slice(10).join(' '));
      else if (line.startsWith('? ')) out.untracked.push(line.slice(2));
    }
    return out;
  }

  /** Différences du répertoire de travail par rapport à HEAD (portée « Git »). */
  private async diffHead(workspaceId: string, path?: string) {
    const sb = await this.sandboxes.getActive(workspaceId);
    if (!sb) return { available: false };
    if (path) {
      const rel = fromUserPath(path).slice('/workspace/'.length);
      const head = await execCollect(this.sandboxes.provider, sb.handle, ['git', 'show', `HEAD:${rel}`], { maxBytes: 5_000_000 });
      return { available: true, original: head.exitCode === 0 ? head.stdout.toString('base64') : null };
    }
    const r = await execCollect(this.sandboxes.provider, sb.handle, ['git', 'diff', 'HEAD', '--numstat', '-z', '--find-renames']);
    const untracked = await execCollect(this.sandboxes.provider, sb.handle, ['git', 'ls-files', '--others', '--exclude-standard', '-z']);
    const nameStatus = await execCollect(this.sandboxes.provider, sb.handle, ['git', 'diff', 'HEAD', '--name-status', '-z', '--find-renames']);
    if (r.exitCode !== 0) return { available: false };
    const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    const ns = r.stdout.toString('utf8').split('\0').filter(Boolean);
    for (let i = 0; i < ns.length; i++) {
      const [a, d, p] = ns[i].split('\t');
      const file = p === '' ? ns[(i += 2)] : p;
      stats.set(file, { additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d), binary: a === '-' });
    }
    const files: Array<{ path: string; oldPath?: string; status: string; additions: number; deletions: number; binary: boolean }> = [];
    const st = nameStatus.stdout.toString('utf8').split('\0').filter(Boolean);
    for (let i = 0; i < st.length; i++) {
      const code = st[i];
      if (code.startsWith('R')) {
        const oldPath = st[++i];
        const newPath = st[++i];
        files.push({ path: newPath, oldPath, status: 'renamed', ...(stats.get(newPath) ?? { additions: 0, deletions: 0, binary: false }) });
      } else {
        const p = st[++i];
        files.push({ path: p, status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified', ...(stats.get(p) ?? { additions: 0, deletions: 0, binary: false }) });
      }
    }
    for (const p of untracked.stdout.toString('utf8').split('\0').filter(Boolean)) {
      files.push({ path: p, status: 'added', additions: 0, deletions: 0, binary: false });
    }
    return { available: true, files };
  }

  /**
   * Écriture manuelle depuis l'éditeur : contrôle de version (If-Match), jamais d'écrasement
   * silencieux d'une modification de Pi, puis checkpoint.
   */
  private async writeFile(p: Extract<RpcPayload, { op: 'file.write' }>) {
    const abs = fromUserPath(p.path);
    if (abs === '/workspace' || abs.startsWith('/workspace/.git/')) throw new PermanentJobError('Chemin non modifiable');
    const sb = await this.sandboxes.ensureRunning(p.workspaceId);
    const cur = await execCollect(this.sandboxes.provider, sb.handle, ['cat', '--', abs], { maxBytes: 10_000_000 });
    const currentEtag = cur.exitCode === 0 ? sha256(cur.stdout) : null;
    if (p.ifMatch !== null && p.ifMatch !== currentEtag) return { conflict: true, currentEtag };
    if (p.ifMatch === null && currentEtag !== null) return { conflict: true, currentEtag };
    await this.sandboxes.writeFiles(sb.handle, [{ path: abs.slice(1), content: p.content }]);
    const ck = await this.checkpoints.run({
      workspaceId: p.workspaceId,
      fencingToken: sb.fencingToken,
      provider: this.sandboxes.provider,
      handle: sb.handle,
      reason: 'editor_save',
      triggerKey: `editor:${p.userId}:${sha256(p.path + p.content)}:${Date.now()}`,
    });
    await this.db.update(workspaces).set({ lastActivityAt: new Date() }).where(eq(workspaces.id, p.workspaceId));
    return { conflict: false, etag: sha256(p.content), generation: ck.generation };
  }
}
