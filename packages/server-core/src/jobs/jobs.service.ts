import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { jobs, type Database, type DbOrTx } from '@cap/database';
import { DB } from '../tokens.js';

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
@Injectable()
export class JobsService {
  constructor(@Inject(DB) private readonly db: Database) {}

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

  async complete(jobId: string, workerId: string): Promise<void> {
    await this.db.execute(sql`
      update jobs set status = 'succeeded', finished_at = now(), locked_until = null
      where id = ${jobId} and locked_by = ${workerId}`);
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
