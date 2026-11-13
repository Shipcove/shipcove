import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { SecretProvider } from '@cap/secrets';
import { agentRuns, sandboxInstances, serviceInstances, workspaces, type Database } from '@cap/database';
import { DB, ENV, QuotaService, SECRETS, SettingsService, sha256Hex, type NormalizedUsage } from '@cap/server-core';
import type { WorkerEnv } from '../env.js';
import { SandboxManager } from '../sandbox/sandbox-manager.service.js';
import { CheckpointService } from '../sandbox/checkpoint.service.js';
import { RunOrchestrator } from '../runs/run-orchestrator.service.js';
import { GitBrokerService } from '../git/git-broker.service.js';
import { RetentionService } from './retention.service.js';

interface Task {
  name: string;
  everyMs: number;
  /** Une seule instance exécute la tâche à la fois (verrou consultatif). */
  exclusive: boolean;
  fn: () => Promise<unknown>;
}

/** Tâches périodiques coordonnées entre instances (PostgreSQL advisory locks). */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Maintenance');
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: WorkerEnv,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly settings: SettingsService,
    private readonly sandboxes: SandboxManager,
    private readonly checkpoints: CheckpointService,
    private readonly runs: RunOrchestrator,
    private readonly git: GitBrokerService,
    private readonly quotas: QuotaService,
    private readonly retention: RetentionService,
  ) {}

  private tasks(): Task[] {
    return [
      { name: 'heartbeat', everyMs: 15_000, exclusive: false, fn: () => this.heartbeat() },
      { name: 'leases', everyMs: 30_000, exclusive: true, fn: () => this.sandboxes.renewLeases() },
      { name: 'stale-runs', everyMs: 30_000, exclusive: true, fn: () => this.runs.recoverStaleRuns() },
      { name: 'approvals', everyMs: 60_000, exclusive: true, fn: () => this.git.expireApprovals() },
      { name: 'reservations', everyMs: 60_000, exclusive: true, fn: () => this.quotas.expireStaleReservations() },
      { name: 'idle-reaper', everyMs: 60_000, exclusive: true, fn: () => this.reapIdle() },
      { name: 'unsynced', everyMs: 60_000, exclusive: true, fn: () => this.retryUnsynced() },
      { name: 'llm-reconcile', everyMs: 5 * 60_000, exclusive: true, fn: () => this.reconcileUsage() },
      { name: 'sandbox-reconcile', everyMs: 10 * 60_000, exclusive: true, fn: () => this.sandboxes.reconcile() },
      { name: 'retention', everyMs: 60 * 60_000, exclusive: true, fn: () => this.retention.runAll() },
    ];
  }

  onApplicationBootstrap(): void {
    for (const t of this.tasks()) {
      const tick = () => void this.runTask(t);
      this.timers.push(setInterval(tick, t.everyMs));
      setTimeout(tick, 2000 + Math.random() * 3000);
    }
  }

  onApplicationShutdown(): void {
    for (const t of this.timers) clearInterval(t);
  }

  private async runTask(t: Task): Promise<void> {
    if (this.running.has(t.name)) return;
    this.running.add(t.name);
    const lockId = Number.parseInt(sha256Hex(`cap-task:${t.name}`).slice(0, 12), 16);
    const client = t.exclusive ? await this.db.$client.connect() : null;
    try {
      if (client) {
        const r = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [lockId]);
        if (!r.rows[0].ok) return;
      }
      await t.fn();
    } catch (err) {
      this.logger.warn(`${t.name} : ${(err as Error).message}`);
    } finally {
      if (client) {
        await client.query('select pg_advisory_unlock($1)', [lockId]).catch(() => undefined);
        client.release();
      }
      this.running.delete(t.name);
    }
  }

  private async heartbeat(): Promise<void> {
    await this.db
      .insert(serviceInstances)
      .values({ id: this.env.INSTANCE_ID, kind: 'worker', hostname: process.env.HOSTNAME ?? null, version: '0.1.0' })
      .onConflictDoUpdate({ target: serviceInstances.id, set: { heartbeatAt: new Date() } });
  }

  /**
   * Destruction après inactivité (15 min par défaut). Une page ouverte ne compte pas :
   * seules l'activité de Pi (outils, appels LLM), les sauvegardes éditeur et les runs actifs comptent.
   * Les runs dépassant la durée maximale sont interrompus.
   */
  private async reapIdle(): Promise<void> {
    const cfg = await this.settings.section('sandbox');
    const overdue = await this.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.status, 'running'), sql`${agentRuns.startedAt} < now() - (${cfg.maxRunMinutes} * interval '1 minute')`));
    for (const r of overdue) {
      await this.db.update(agentRuns).set({ status: 'interrupting' }).where(and(eq(agentRuns.id, r.id), eq(agentRuns.status, 'running')));
      await this.db.execute(sql`select pg_notify('cap_run_control', ${JSON.stringify({ runId: r.id, action: 'interrupt' })})`);
    }
    const idle = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .innerJoin(sandboxInstances, and(eq(sandboxInstances.workspaceId, workspaces.id), eq(sandboxInstances.status, 'running')))
      .where(
        and(
          eq(workspaces.status, 'running'),
          sql`coalesce(${workspaces.lastActivityAt}, ${sandboxInstances.createdAt}) < now() - (${cfg.idleTimeoutMinutes} * interval '1 minute')`,
          sql`not exists (select 1 from agent_runs r where r.workspace_id = ${workspaces.id} and r.status in ('queued','running','interrupting'))`,
        ),
      );
    for (const w of idle) {
      const r = await this.sandboxes.stop(w.id, 'inactivité');
      this.logger.log(`Inactivité : ${w.id} → ${r.detail}`);
    }
  }

  private async retryUnsynced(): Promise<void> {
    const rows = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .innerJoin(sandboxInstances, and(eq(sandboxInstances.workspaceId, workspaces.id), eq(sandboxInstances.status, 'running')))
      .where(eq(workspaces.syncState, 'unsynced'));
    for (const w of rows) {
      const sb = await this.sandboxes.getActive(w.id).catch(() => null);
      if (!sb) continue;
      await this.checkpoints.run({ workspaceId: w.id, fencingToken: sb.fencingToken, provider: this.sandboxes.provider, handle: sb.handle, reason: 'retry' }).catch(() => undefined);
    }
  }

  /**
   * Réconciliation des usages LLM inconnus via les journaux de LiteLLM. Aucune consommation
   * n'est inventée : sans donnée après 1 h, la politique d'administration s'applique et
   * l'écriture est marquée `estimated`.
   */
  private async reconcileUsage(): Promise<void> {
    const pending = await this.quotas.pendingReconciliation(100);
    if (pending.length === 0) return;
    const key = await this.secrets.readKey(this.env.LITELLM_MASTER_KEY_REF, 'masterKey').catch(() => undefined);
    const policy = (await this.settings.section('quotas')).unknownUsagePolicy;
    for (const r of pending) {
      let usage: NormalizedUsage | null = null;
      let cost: string | null = null;
      if (key && r.litellmCallId) {
        try {
          const res = await fetch(`${this.env.LITELLM_URL}/spend/logs?request_id=${encodeURIComponent(r.litellmCallId)}`, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            const rows = (await res.json()) as Array<{ prompt_tokens?: number; completion_tokens?: number; spend?: number }>;
            const row = Array.isArray(rows) ? rows[0] : null;
            if (row && (row.prompt_tokens || row.completion_tokens)) {
              usage = { inputTokens: row.prompt_tokens ?? 0, outputTokens: row.completion_tokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
              cost = row.spend !== undefined ? String(row.spend) : null;
            }
          }
        } catch {
          /* nouvelle tentative au prochain passage */
        }
      }
      if (usage) {
        await this.quotas.settle(r.id, usage, { providerCostUsd: cost, estimated: false });
        continue;
      }
      if (Date.now() - r.createdAt.getTime() > 3600_000) {
        if (policy === 'charge_estimate_input') {
          // Débit borné à la seule estimation d'entrée (le prompt a bien été envoyé), marqué « estimé ».
          await this.quotas.settle(r.id, { inputTokens: r.estimatedInputTokens ?? 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { estimated: true });
        } else {
          await this.quotas.release(r.id, 'usage inconnu : non facturé (politique)');
        }
      }
    }
  }
}
