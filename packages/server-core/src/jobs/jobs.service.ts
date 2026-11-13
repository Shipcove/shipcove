import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { jobs, type Database, type DbOrTx } from '@cap/database';
import { DB } from '../tokens.js';
import { PgNotifier } from '../events/pg-notifier.js';

export interface EnqueueOptions {
  /** Empêche les doublons tant qu'un job identique est en attente / en cours. */
  dedupeKey?: string;
  runAt?: Date;
  delayMs?: number;
  priority?: number;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: string;
  queue: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/**
 * File de jobs durable sur PostgreSQL (ADR 0003).
 * - `enqueue` peut participer à une transaction métier (outbox implicite).
 * - `claim` utilise `FOR UPDATE SKIP LOCKED` et pose un lease (`locked_until`).
 * - Un job dont le lease expire (worker disparu) redevient éligible.
 */
export class JobFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobFailedError';
  }
}
export class JobTimeoutError extends Error {
  constructor(jobId: string) {
    super(`Délai dépassé pour le job ${jobId}`);
    this.name = 'JobTimeoutError';
  }
}

@Injectable()
export class JobsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly notifier: PgNotifier,
  ) {}

  async enqueue(queue: string, payload: unknown, opts: EnqueueOptions = {}, tx?: DbOrTx): Promise<string | null> {
    const exec = tx ?? this.db;
    const runAt = opts.runAt ?? new Date(Date.now() + (opts.delayMs ?? 0));
    const rows = await exec
      .insert(jobs)
      .values({
        queue,
        payload: payload as object,
        dedupeKey: opts.dedupeKey ?? null,
        runAt,
        priority: opts.priority ?? 0,
        maxAttempts: opts.maxAttempts ?? 8,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    if (rows.length > 0) {
      await exec.execute(sql`select pg_notify('cap_jobs', ${queue})`);
    }
    return rows[0]?.id ?? null;
  }

  async claim(queues: string[], workerId: string, leaseMs: number, limit = 1): Promise<ClaimedJob[]> {
    if (queues.length === 0) return [];
    const res = await this.db.execute<{
      id: string;
      queue: string;
      payload: unknown;
      attempts: number;
      max_attempts: number;
    }>(sql`
      with candidates as (
        select id from jobs
        where (
          (status = 'pending' and run_at <= now())
          or (status = 'running' and locked_until < now())
        )
        and queue in (${sql.join(queues.map((q) => sql`${q}`), sql`, `)})
        order by priority desc, run_at
        limit ${limit}
        for update skip locked
      )
      update jobs j set
        status = 'running',
        locked_by = ${workerId},
        locked_until = now() + (${leaseMs} * interval '1 millisecond'),
        attempts = j.attempts + 1
      from candidates c
      where j.id = c.id
      returning j.id, j.queue, j.payload, j.attempts, j.max_attempts
    `);
    return res.rows.map((r) => ({
      id: r.id,
      queue: r.queue,
      payload: r.payload,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
    }));
  }

  async extend(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const res = await this.db.execute(sql`
      update jobs set locked_until = now() + (${leaseMs} * interval '1 millisecond')
      where id = ${jobId} and locked_by = ${workerId} and status = 'running'`);
    return (res.rowCount ?? 0) > 0;
  }

  async complete(jobId: string, workerId: string, result?: unknown): Promise<void> {
    await this.db.execute(sql`
      update jobs set status = 'succeeded', finished_at = now(), locked_until = null,
        result = ${result === undefined ? null : JSON.stringify(result)}::jsonb
      where id = ${jobId} and locked_by = ${workerId}`);
    await this.db.execute(sql`select pg_notify('cap_job_done', ${jobId})`);
  }

  /**
   * Attend la fin d'un job (succès → résultat, échec définitif → erreur) avec délai maximal.
   * Utilisé par l'API pour les opérations synchrones exécutées par un worker dans une sandbox.
   */
  async waitForResult<T = unknown>(jobId: string, timeoutMs: number): Promise<T> {
    const read = async () => {
      const res = await this.db.execute<{ status: string; result: unknown; last_error: string | null }>(
        sql`select status, result, last_error from jobs where id = ${jobId}`,
      );
      return res.rows[0];
    };
    return new Promise<T>((resolve, reject) => {
      let done = false;
      let unsubscribe: (() => void) | undefined;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        unsubscribe?.();
        fn();
      };
      const check = async () => {
        const row = await read().catch(() => undefined);
        if (!row) return;
        if (row.status === 'succeeded') finish(() => resolve(row.result as T));
        else if (row.status === 'dead' || row.status === 'cancelled' || row.status === 'failed')
          finish(() => reject(new JobFailedError(row.last_error ?? 'job en échec')));
      };
      const timer = setTimeout(() => finish(() => reject(new JobTimeoutError(jobId))), timeoutMs);
      // Filet de sécurité si une notification est perdue.
      const poll = setInterval(() => void check(), 1000);
      void this.notifier
        .on('cap_job_done', (payload) => {
          if (!payload || payload === jobId) void check();
        })
        .then((u) => {
          unsubscribe = u;
          if (done) u();
          void check();
        });
    });
  }

  async failPermanently(jobId: string, workerId: string, error: string): Promise<void> {
    await this.db.execute(sql`
      update jobs set status = 'dead', last_error = ${error.slice(0, 4000)}, finished_at = now(), locked_until = null
      where id = ${jobId} and locked_by = ${workerId}`);
    await this.db.execute(sql`select pg_notify('cap_job_done', ${jobId})`);
  }

  /** Échec : retry avec backoff exponentiel plafonné, ou `dead` après maxAttempts. */
  async fail(job: ClaimedJob, workerId: string, error: string, retryable = true): Promise<void> {
    const dead = !retryable || job.attempts >= job.maxAttempts;
    const backoffMs = Math.min(5 * 60_000, 1000 * 2 ** Math.min(job.attempts, 12));
    await this.db.execute(sql`
      update jobs set
        status = ${dead ? 'dead' : 'pending'},
        last_error = ${error.slice(0, 4000)},
        run_at = now() + (${backoffMs} * interval '1 millisecond'),
        locked_by = null,
        locked_until = null,
        finished_at = ${dead ? sql`now()` : sql`null`}
      where id = ${job.id} and locked_by = ${workerId}`);
    if (dead) await this.db.execute(sql`select pg_notify('cap_job_done', ${job.id})`);
  }

  async stats(): Promise<{ pending: number; running: number; dead: number }> {
    const res = await this.db.execute<{ status: string; n: number }>(
      sql`select status, count(*)::int as n from jobs where status in ('pending','running','dead') group by status`,
    );
    const out = { pending: 0, running: 0, dead: 0 };
    for (const r of res.rows) (out as Record<string, number>)[r.status] = r.n;
    return out;
  }
}
