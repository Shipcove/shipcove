import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  agentRuns,
  gitApprovalRequests,
  gitConnections,
  gitOperations,
  messages,
  conversations,
  repositories,
  workspaces,
  type Database,
} from '@cap/database';
import { execCollect } from '@cap/sandbox';
import {
  AppError,
  AuditService,
  DB,
  ENV,
  EventsService,
  GitProviderClient,
  GitProviderError,
  JobsService,
  NotificationService,
  canonicalJson,
  redactString,
  sha256Hex,
} from '@cap/server-core';
import type { GitActionKind } from '@cap/contracts';
import type { WorkerEnv } from '../env.js';
import { JobRunner, PermanentJobError } from '../jobs/job-runner.service.js';
import { SandboxManager } from '../sandbox/sandbox-manager.service.js';
import type { RunContext } from '../runs/run-orchestrator.service.js';

const run = promisify(execFile);
const APPROVAL_TTL_MS = 24 * 3600_000;
const BRANCH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;

interface PreparedTarget {
  workspace: typeof workspaces.$inferSelect;
  repo: typeof repositories.$inferSelect;
  conn: typeof gitConnections.$inferSelect;
}

/**
 * Git Credential Broker (ADR 0007). Les credentials ne quittent jamais le worker ;
 * chaque opération distante sensible exige une approbation à usage unique liée à l'action exacte.
 */
@Injectable()
export class GitBrokerService implements OnApplicationBootstrap {
  private readonly logger = new Logger('GitBroker');

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: WorkerEnv,
    private readonly jobsRunner: JobRunner,
    private readonly jobs: JobsService,
    private readonly sandboxes: SandboxManager,
    private readonly git: GitProviderClient,
    private readonly events: EventsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    this.jobsRunner.register('git.execute', (p) => this.execute((p as { approvalId: string }).approvalId), { concurrency: 4, leaseMs: 300_000 });
    this.jobsRunner.register('git.reconcile', (p) => this.reconcile((p as { operationId: string }).operationId), { concurrency: 2 });
    this.jobsRunner.register('git.prepare', (p) => {
      const x = p as { workspaceId: string; userId: string; params: Record<string, unknown> };
      return this.prepare(x.workspaceId, 'user', x.params, null);
    });
  }

  /* ----------------------------- Préparation ---------------------------- */

  async requestFromAgent(ctx: RunContext, params: Record<string, unknown>): Promise<string> {
    const res = await this.prepare(ctx.workspaceId, 'agent', params, String(params.toolCallId ?? ''));
    return (
      `Demande d'approbation créée (${res.approvalId}) pour « ${res.summary} ». ` +
      `L'utilisateur doit l'approuver dans l'interface ; l'opération sera exécutée par la plateforme après approbation. ` +
      `Ne réessaie pas et n'essaie pas de publier autrement.`
    );
  }

  private async target(workspaceId: string): Promise<PreparedTarget> {
    const [row] = await this.db
      .select({ w: workspaces, repo: repositories })
      .from(workspaces)
      .leftJoin(repositories, eq(repositories.id, workspaces.repositoryId))
      .where(eq(workspaces.id, workspaceId));
    if (!row) throw new AppError('not_found', 'Conversation introuvable');
    if (!row.repo) throw new AppError('conflict', 'Cette conversation n’est associée à aucun dépôt Git');
    const [conn] = await this.db
      .select()
      .from(gitConnections)
      .where(and(eq(gitConnections.userId, row.w.ownerId), eq(gitConnections.host, row.repo.host), eq(gitConnections.status, 'active'), isNull(gitConnections.revokedAt)))
      .orderBy(desc(gitConnections.lastUsedAt))
      .limit(1);
    if (!conn) throw new AppError('conflict', `Aucune connexion ${row.repo.host} active : rattachez votre compte dans les paramètres`);
    return { workspace: row.w, repo: row.repo, conn };
  }

  /** Prépare une demande : capture l'action exacte (SHA, commits, diff) et crée l'approbation. */
  async prepare(workspaceId: string, requestedBy: 'agent' | 'user', params: Record<string, unknown>, toolCallExternalId: string | null) {
    const t = await this.target(workspaceId);
    const action = String(params.action) as GitActionKind | 'create_pull_request';
    const sb = await this.sandboxes.ensureRunning(workspaceId);
    const sh = async (argv: string[]) => {
      const r = await execCollect(this.sandboxes.provider, sb.handle, argv, { env: this.sandboxes.forgeEnv(sb), timeoutMs: 120_000 });
      return { code: r.exitCode, out: r.stdout.toString('utf8').trim(), err: r.stderr.toString('utf8').trim() };
    };
    let commitSha: string | null = null;
    let commits: Array<{ sha: string; subject: string; author: string }> = [];
    let diffStat: string | null = null;
    let patchPreview: string | null = null;
    let target = '';
    let normalized: Record<string, unknown>;
    let realAction: string = action;

    if (action === 'push') {
      const local = String(params.localBranch ?? '');
      const remote = String(params.remoteBranch ?? local);
      if (!BRANCH_RE.test(local) || !BRANCH_RE.test(remote)) throw new AppError('validation_failed', 'Nom de branche invalide');
      const head = await sh(['git', 'rev-parse', '--verify', `refs/heads/${local}`]);
      if (head.code !== 0) throw new AppError('validation_failed', `Branche locale inconnue : ${local}`);
      commitSha = head.out;
      await sh(['git', 'fetch', '--quiet', 'origin']);
      const remoteRef = await sh(['git', 'rev-parse', '--verify', `refs/remotes/origin/${remote}`]);
      const base = remoteRef.code === 0 ? remoteRef.out : (await sh(['git', 'rev-parse', '--verify', `refs/remotes/origin/${t.repo.defaultBranch}`])).out || null;
      const range = base ? `${base}..${commitSha}` : commitSha;
      const log = await sh(['git', 'log', '--format=%H%x1f%s%x1f%an', '-n', '200', range]);
      commits = log.out ? log.out.split('\n').map((l) => { const [sha, subject, author] = l.split('\x1f'); return { sha, subject, author }; }) : [];
      if (base) {
        diffStat = (await sh(['git', 'diff', '--stat', base, commitSha])).out.slice(0, 20_000);
        patchPreview = (await sh(['git', 'diff', base, commitSha])).out.slice(0, 200_000);
      }
      if (remoteRef.code === 0 && commits.length === 0) throw new AppError('conflict', 'Rien à publier : la branche distante est à jour');
      target = `${t.repo.fullName}:${remote}`;
      normalized = { localBranch: local, remoteBranch: remote, force: params.force === true };
      // Réécrire l'historique de la branche par défaut n'est jamais proposé à l'approbation.
      if (normalized.force && remote === t.repo.defaultBranch) throw new AppError('forbidden', 'Push forcé interdit sur la branche par défaut');
    } else if (action === 'create_pull_request' || action === 'create_merge_request') {
      realAction = t.repo.provider.startsWith('gitlab') ? 'create_merge_request' : 'create_pull_request';
      const source = String(params.sourceBranch ?? '');
      const targetBranch = String(params.targetBranch ?? t.repo.defaultBranch);
      if (!BRANCH_RE.test(source) || !BRANCH_RE.test(targetBranch)) throw new AppError('validation_failed', 'Nom de branche invalide');
      commitSha = await this.git.branchHead(t.conn, t.repo.fullName, source);
      if (!commitSha) throw new AppError('conflict', `La branche ${source} n’existe pas sur le dépôt distant : publiez-la d’abord (platform_git_push)`);
      await sh(['git', 'fetch', '--quiet', 'origin']);
      const log = await sh(['git', 'log', '--format=%H%x1f%s%x1f%an', '-n', '200', `origin/${targetBranch}..origin/${source}`]);
      commits = log.out ? log.out.split('\n').map((l) => { const [sha, subject, author] = l.split('\x1f'); return { sha, subject, author }; }) : [];
      diffStat = (await sh(['git', 'diff', '--stat', `origin/${targetBranch}...origin/${source}`])).out.slice(0, 20_000) || null;
      patchPreview = (await sh(['git', 'diff', `origin/${targetBranch}...origin/${source}`])).out.slice(0, 200_000) || null;
      target = `${t.repo.fullName}:${source} → ${targetBranch}`;
      normalized = {
        sourceBranch: source,
        targetBranch,
        title: String(params.title ?? '').slice(0, 250) || `Modifications de ${source}`,
        body: String(params.body ?? '').slice(0, 60_000),
        draft: params.draft === true,
      };
    } else if (action === 'merge') {
      const number = Number(params.number);
      if (!Number.isInteger(number) || number <= 0) throw new AppError('validation_failed', 'Numéro de PR/MR invalide');
      const pr = await this.git.getPullRequest(t.conn, t.repo.fullName, number);
      if (pr.merged) throw new AppError('conflict', 'Déjà fusionnée');
      commitSha = pr.headSha ?? null;
      target = `${t.repo.fullName}#${number}`;
      normalized = { number, method: ['merge', 'squash', 'rebase'].includes(String(params.method)) ? String(params.method) : 'merge', url: pr.url };
    } else if (action === 'delete_remote_branch') {
      const branch = String(params.branch ?? '');
      if (!BRANCH_RE.test(branch)) throw new AppError('validation_failed', 'Nom de branche invalide');
      if (branch === t.repo.defaultBranch) throw new AppError('forbidden', 'Suppression de la branche par défaut interdite');
      commitSha = await this.git.branchHead(t.conn, t.repo.fullName, branch);
      if (!commitSha) throw new AppError('not_found', `Branche distante inconnue : ${branch}`);
      target = `${t.repo.fullName}:${branch}`;
      normalized = { branch };
    } else {
      throw new AppError('validation_failed', `Action Git inconnue : ${action}`);
    }

    const digest = sha256Hex(canonicalJson({ action: realAction, repositoryId: t.repo.id, params: normalized, commitSha }));
    const [approval] = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(gitApprovalRequests)
        .values({
          workspaceId,
          requesterId: t.workspace.ownerId,
          requestedBy,
          action: realAction as GitActionKind,
          repositoryId: t.repo.id,
          gitConnectionId: t.conn.id,
          params: normalized,
          target,
          commitSha,
          commits,
          diffStat,
          patchPreview: patchPreview ? redactString(patchPreview) : null,
          actionDigest: digest,
          expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
          toolCallExternalId,
        })
        .returning();
      await tx.insert(gitOperations).values({ workspaceId, userId: t.workspace.ownerId, action: realAction, approvalId: rows[0].id, params: normalized, status: 'awaiting_approval' });
      await this.audit.record({ actorId: requestedBy === 'user' ? t.workspace.ownerId : null, actorLabel: requestedBy === 'agent' ? 'pi' : null, action: 'git.approval_requested', targetType: 'git_approval', targetId: rows[0].id, metadata: { action: realAction, target, commitSha } }, tx);
      return rows;
    });
    // Le push forcé est annoncé partout où le propriétaire décide (carte, notification).
    const forced = realAction === 'push' && normalized.force === true;
    const summary = `${labelOf(realAction)}${forced ? ' FORCÉ (réécrit l’historique distant)' : ''} ${target}`;
    await this.events.emit(workspaceId, 'approval.required', { approvalId: approval.id, action: realAction as GitActionKind, summary });
    await this.notifications.notify({
      userId: t.workspace.ownerId,
      type: 'approval.required',
      title: 'Approbation Git requise',
      body: summary,
      link: `/workspaces/${workspaceId}?approval=${approval.id}`,
      dedupeKey: `approval:${approval.id}`,
    });
    return { approvalId: approval.id, summary };
  }

  /* ------------------------------ Exécution ----------------------------- */

  async execute(approvalId: string): Promise<{ status: string }> {
    // Consommation atomique : une approbation ne sert qu'une seule fois.
    const consumed = await this.db
      .update(gitApprovalRequests)
      .set({ status: 'consumed', consumedAt: new Date() })
      .where(and(eq(gitApprovalRequests.id, approvalId), eq(gitApprovalRequests.status, 'approved'), sql`${gitApprovalRequests.expiresAt} > now()`))
      .returning();
    if (consumed.length === 0) throw new PermanentJobError('Approbation absente, déjà consommée ou expirée');
    const a = consumed[0];
    const digest = sha256Hex(canonicalJson({ action: a.action, repositoryId: a.repositoryId, params: a.params, commitSha: a.commitSha }));
    if (digest !== a.actionDigest) throw new PermanentJobError('Empreinte de l’action incohérente');
    const [op] = await this.db
      .update(gitOperations)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(gitOperations.approvalId, approvalId))
      .returning();
    const t = await this.target(a.workspaceId);
    if (t.repo.id !== a.repositoryId || t.conn.id !== a.gitConnectionId) {
      return this.complete(op.id, a, 'failed', null, 'Le dépôt ou la connexion a changé depuis l’approbation');
    }
    const p = a.params as Record<string, string | number | boolean>;
    try {
      if (a.action === 'push') {
        const result = await this.push(a, t, String(p.localBranch), String(p.remoteBranch), p.force === true);
        return this.complete(op.id, a, 'succeeded', result, null);
      }
      if (a.action === 'create_pull_request' || a.action === 'create_merge_request') {
        const head = await this.git.branchHead(t.conn, t.repo.fullName, String(p.sourceBranch));
        if (head !== a.commitSha) return this.complete(op.id, a, 'failed', null, 'La branche source a changé depuis l’approbation : nouvelle approbation nécessaire');
        const pr = await this.git.createPullRequest(t.conn, t.repo.fullName, { source: String(p.sourceBranch), target: String(p.targetBranch), title: String(p.title), body: String(p.body ?? ''), draft: p.draft === true });
        return this.complete(op.id, a, 'succeeded', { number: pr.number, url: pr.url }, null);
      }
      if (a.action === 'merge') {
        const r = await this.git.mergePullRequest(t.conn, t.repo.fullName, Number(p.number), String(p.method) as 'merge', a.commitSha);
        return this.complete(op.id, a, r.merged ? 'succeeded' : 'failed', { merged: r.merged, sha: r.sha }, r.merged ? null : 'Fusion refusée par la forge');
      }
      if (a.action === 'delete_remote_branch') {
        const head = await this.git.branchHead(t.conn, t.repo.fullName, String(p.branch));
        if (head !== a.commitSha) return this.complete(op.id, a, 'failed', null, 'La branche a changé depuis l’approbation');
        await this.git.deleteBranch(t.conn, t.repo.fullName, String(p.branch));
        return this.complete(op.id, a, 'succeeded', { deleted: p.branch }, null);
      }
      return this.complete(op.id, a, 'failed', null, 'Action non supportée');
    } catch (err) {
      const uncertain = err instanceof GitProviderError ? err.uncertain : err instanceof UncertainError;
      const msg = redactString((err as Error).message);
      if (uncertain) {
        // Résultat distant inconnu : JAMAIS de rejeu aveugle ; réconciliation d'abord.
        await this.db.update(gitOperations).set({ status: 'unknown', error: msg, updatedAt: new Date() }).where(eq(gitOperations.id, op.id));
        await this.events.emit(a.workspaceId, 'git.operation', { operationId: op.id, action: a.action as GitActionKind, status: 'unknown', detail: 'Résultat incertain : vérification en cours' });
        await this.jobs.enqueue('git.reconcile', { operationId: op.id }, { dedupeKey: `reconcile:${op.id}`, delayMs: 5000 });
        return { status: 'unknown' };
      }
      return this.complete(op.id, a, 'failed', null, msg);
    }
  }

  /** Push via bundle exporté de la sandbox : le credential reste côté worker. */
  private async push(a: typeof gitApprovalRequests.$inferSelect, t: PreparedTarget, local: string, remote: string, force: boolean) {
    const sb = await this.sandboxes.ensureRunning(a.workspaceId);
    const head = await execCollect(this.sandboxes.provider, sb.handle, ['git', 'rev-parse', '--verify', `refs/heads/${local}`]);
    if (head.stdout.toString().trim() !== a.commitSha) throw new PermanentJobError('La branche locale a changé depuis l’approbation : nouvelle approbation nécessaire');
    const bundle = await execCollect(this.sandboxes.provider, sb.handle, ['git', 'bundle', 'create', '-', `refs/heads/${local}`], { maxBytes: 2 * 1024 * 1024 * 1024, timeoutMs: 600_000 });
    if (bundle.exitCode !== 0) throw new Error(`git bundle : ${bundle.stderr.toString().slice(0, 300)}`);
    const dir = await mkdtemp(join(this.env.GIT_BROKER_TMP || tmpdir(), 'push-'));
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: dir };
    try {
      await writeFile(join(dir, 'x.bundle'), bundle.stdout);
      await run('git', ['init', '--bare', '-q', join(dir, 'repo.git')], { env: gitEnv });
      const repo = join(dir, 'repo.git');
      await run('git', ['-C', repo, 'bundle', 'verify', join(dir, 'x.bundle')], { env: gitEnv });
      await run('git', ['-C', repo, 'fetch', '-q', join(dir, 'x.bundle'), `refs/heads/${local}:refs/heads/cap-push`], { env: gitEnv });
      const { stdout } = await run('git', ['-C', repo, 'rev-parse', 'refs/heads/cap-push'], { env: gitEnv });
      if (stdout.trim() !== a.commitSha) throw new PermanentJobError('Contenu du bundle différent du commit approuvé');
      // Jeton dans l'environnement du processus (lisible par son seul propriétaire), pas dans ses
      // arguments (visibles de tous dans /proc).
      const remoteAuth = await this.git.authenticatedRemote(t.conn, t.repo.cloneUrl);
      try {
        const res = await run('git', ['-C', repo, '-c', 'credential.helper=', 'push', '--porcelain', ...(force ? ['--force'] : []), remoteAuth.url, `${a.commitSha}:refs/heads/${remote}`], {
          env: { ...gitEnv, ...remoteAuth.env },
          timeout: 300_000,
        });
        await execCollect(this.sandboxes.provider, sb.handle, ['git', 'fetch', '--quiet', 'origin'], { env: this.sandboxes.forgeEnv(sb) }).catch(() => undefined);
        return { remoteBranch: remote, sha: a.commitSha, output: redactString(res.stdout).slice(0, 2000) };
      } catch (err) {
        const e = err as { stderr?: string; killed?: boolean; signal?: string };
        const stderr = redactString(e.stderr ?? (err as Error).message);
        if (/rejected|non-fast-forward|denied|protected branch|permission/i.test(stderr)) throw new PermanentJobError(`Push refusé par la forge : ${stderr.slice(0, 500)}`);
        throw new UncertainError(`Push au résultat incertain : ${stderr.slice(0, 500)}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Réconciliation d'un résultat incertain : lecture de l'état distant, sans rejouer. */
  async reconcile(operationId: string): Promise<{ status: string }> {
    const [op] = await this.db.select().from(gitOperations).where(eq(gitOperations.id, operationId));
    if (!op || op.status !== 'unknown') return { status: op?.status ?? 'missing' };
    const [a] = await this.db.select().from(gitApprovalRequests).where(eq(gitApprovalRequests.id, op.approvalId!));
    const t = await this.target(op.workspaceId);
    const p = a.params as Record<string, string | number>;
    if (a.action === 'push') {
      const head = await this.git.branchHead(t.conn, t.repo.fullName, String(p.remoteBranch));
      if (head === a.commitSha) return this.complete(op.id, a, 'succeeded', { reconciled: true, sha: head }, null);
      return this.complete(op.id, a, 'failed', { reconciled: true, remoteHead: head }, 'Le push n’a pas été appliqué (vérifié) : une nouvelle approbation est nécessaire pour réessayer');
    }
    if (a.action === 'create_pull_request' || a.action === 'create_merge_request') {
      const pr = await this.git.findOpenPullRequest(t.conn, t.repo.fullName, String(p.sourceBranch), String(p.targetBranch));
      if (pr) return this.complete(op.id, a, 'succeeded', { reconciled: true, number: pr.number, url: pr.url }, null);
      return this.complete(op.id, a, 'failed', { reconciled: true }, 'Aucune PR/MR créée (vérifié)');
    }
    if (a.action === 'merge') {
      const pr = await this.git.getPullRequest(t.conn, t.repo.fullName, Number(p.number));
      return this.complete(op.id, a, pr.merged ? 'succeeded' : 'failed', { reconciled: true, merged: pr.merged }, pr.merged ? null : 'Non fusionnée (vérifié)');
    }
    if (a.action === 'delete_remote_branch') {
      const head = await this.git.branchHead(t.conn, t.repo.fullName, String(p.branch));
      return this.complete(op.id, a, head === null ? 'succeeded' : 'failed', { reconciled: true }, head === null ? null : 'Branche toujours présente (vérifié)');
    }
    return { status: 'unknown' };
  }

  private async complete(
    operationId: string,
    a: typeof gitApprovalRequests.$inferSelect,
    status: 'succeeded' | 'failed',
    result: Record<string, unknown> | null,
    error: string | null,
  ): Promise<{ status: string }> {
    await this.db
      .update(gitOperations)
      .set({ status, result, error, finishedAt: new Date(), updatedAt: new Date(), attempts: sql`${gitOperations.attempts} || ${JSON.stringify([{ at: new Date().toISOString(), outcome: status }])}::jsonb` })
      .where(eq(gitOperations.id, operationId));
    const detail = status === 'succeeded' ? `${labelOf(a.action)} ${a.target} : réussi${result?.url ? ` (${result.url})` : ''}` : `${labelOf(a.action)} ${a.target} : échec — ${error}`;
    await this.events.emit(a.workspaceId, 'git.operation', { operationId, action: a.action as GitActionKind, status, detail });
    await this.audit.record({ actorId: a.decidedBy, action: `git.${a.action}`, outcome: status === 'succeeded' ? 'success' : 'failure', targetType: 'git_operation', targetId: operationId, metadata: { target: a.target, commitSha: a.commitSha, error } });
    // Trace dans la conversation et information de l'agent si un run est actif.
    const [conv] = await this.db.select().from(conversations).where(eq(conversations.workspaceId, a.workspaceId));
    if (conv) {
      const [m] = await this.db.insert(messages).values({ conversationId: conv.id, role: 'system', text: `[Plateforme] ${detail}` }).returning({ id: messages.id });
      await this.events.emit(a.workspaceId, 'message.created', { messageId: m.id, role: 'assistant', text: `[Plateforme] ${detail}`, attachmentIds: [] });
      const [activeRun] = await this.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(and(eq(agentRuns.workspaceId, a.workspaceId), eq(agentRuns.status, 'running')));
      if (activeRun) await this.db.execute(sql`select pg_notify('cap_run_control', ${JSON.stringify({ runId: activeRun.id, action: 'steer', messageId: m.id })})`);
    }
    return { status };
  }

  async ciStatus(workspaceId: string, ref: string): Promise<string> {
    const t = await this.target(workspaceId);
    const checks = await this.git.ciStatus(t.conn, t.repo.fullName, ref);
    if (checks.length === 0) return `Aucun pipeline/check pour ${ref}.`;
    return checks.map((c) => `- ${c.name} : ${c.status}${c.url ? ` (${c.url})` : ''}`).join('\n');
  }

  /** Expire les approbations en attente dépassées. */
  async expireApprovals(): Promise<void> {
    const expired = await this.db
      .update(gitApprovalRequests)
      .set({ status: 'expired' })
      .where(and(sql`${gitApprovalRequests.status} in ('pending','approved')`, sql`${gitApprovalRequests.expiresAt} < now()`))
      .returning();
    for (const a of expired) {
      await this.db.update(gitOperations).set({ status: 'rejected', error: 'Approbation expirée', finishedAt: new Date() }).where(eq(gitOperations.approvalId, a.id));
      await this.events.emit(a.workspaceId, 'approval.resolved', { approvalId: a.id, decision: 'expired' });
    }
  }
}

class UncertainError extends Error {}

function labelOf(action: string): string {
  return (
    {
      push: 'Push',
      create_pull_request: 'Pull request',
      create_merge_request: 'Merge request',
      merge: 'Fusion',
      delete_remote_branch: 'Suppression de branche',
    } as Record<string, string>
  )[action] ?? action;
}
