import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ENV, JobsService, PgNotifier, redactString, type ClaimedJob } from '@cap/server-core';
import type { WorkerEnv } from '../env.js';

export type JobHandler = (payload: unknown, job: ClaimedJob) => Promise<unknown>;

export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

interface QueueConfig {
  handler: JobHandler;
  concurrency: number;
  leaseMs: number;
}

/**
 * Consommateur de la file de jobs PostgreSQL. Plusieurs workers peuvent tourner en parallèle :
 * `FOR UPDATE SKIP LOCKED` garantit qu'un job n'est exécuté que par un seul worker à la fois,
 * et le lease est prolongé tant que le handler s'exécute.
 */
@Injectable()
export class JobRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('JobRunner');
  private readonly queues = new Map<string, QueueConfig>();
  private readonly active = new Map<string, number>();
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    @Inject(ENV) private readonly env: WorkerEnv,
    private readonly jobs: JobsService,
    private readonly notifier: PgNotifier,
  ) {}

  register(queue: string, handler: JobHandler, opts: { concurrency?: number; leaseMs?: number } = {}): void {
    this.queues.set(queue, { handler, concurrency: opts.concurrency ?? this.env.JOB_CONCURRENCY, leaseMs: opts.leaseMs ?? 120_000 });
    this.active.set(queue, 0);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.notifier.on('cap_jobs', () => void this.poll());
    this.timer = setInterval(() => void this.poll(), 2000);
    void this.poll();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    const deadline = Date.now() + 25_000;
    while ([...this.active.values()].some((n) => n > 0) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  }

  private async poll(): Promise<void> {
    if (this.stopping || this.polling) return;
    this.polling = true;
    try {
      for (const [queue, cfg] of this.queues) {
        const free = cfg.concurrency - (this.active.get(queue) ?? 0);
        if (free <= 0) continue;
        const claimed = await this.jobs.claim([queue], this.env.INSTANCE_ID, cfg.leaseMs, free);
        for (const job of claimed) void this.execute(job, cfg);
      }
    } catch (err) {
      this.logger.error(`poll: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private async execute(job: ClaimedJob, cfg: QueueConfig): Promise<void> {
    this.active.set(job.queue, (this.active.get(job.queue) ?? 0) + 1);
    const heartbeat = setInterval(
      () => void this.jobs.extend(job.id, this.env.INSTANCE_ID, cfg.leaseMs).catch((e: Error) => this.logger.warn(`bail ${job.queue}#${job.id} : ${e.message}`)),
      Math.max(5000, cfg.leaseMs / 3),
    );
    try {
      const result = await cfg.handler(job.payload, job);
      await this.jobs.complete(job.id, this.env.INSTANCE_ID, result);
    } catch (err) {
      const msg = redactString((err as Error).message ?? String(err));
      this.logger.warn(`job ${job.queue}#${job.id} (tentative ${job.attempts}) : ${msg}`);
      if (err instanceof PermanentJobError) await this.jobs.failPermanently(job.id, this.env.INSTANCE_ID, msg);
      else await this.jobs.fail(job, this.env.INSTANCE_ID, msg);
    } finally {
      clearInterval(heartbeat);
      this.active.set(job.queue, (this.active.get(job.queue) ?? 1) - 1);
      setImmediate(() => void this.poll());
    }
  }
}
