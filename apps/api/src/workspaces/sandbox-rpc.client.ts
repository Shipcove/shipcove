import { Inject, Injectable } from '@nestjs/common';
import { AppError, ENV, JobFailedError, JobTimeoutError, JobsService } from '@cap/server-core';
import type { ApiEnv } from '../env.js';

/**
 * Délégation d'opérations sandbox au worker (l'API n'a aucun accès au moteur de conteneurs).
 * Opérations fixes et paramétrées : aucun shell arbitraire n'est exposé aux utilisateurs.
 */
@Injectable()
export class SandboxRpcClient {
  constructor(
    private readonly jobs: JobsService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  async call<T>(payload: Record<string, unknown>, timeoutMs = this.env.SANDBOX_RPC_TIMEOUT_MS): Promise<T> {
    const id = await this.jobs.enqueue('sandbox.rpc', payload, { maxAttempts: 1, priority: 10 });
    if (!id) throw new AppError('conflict', 'Opération déjà en cours');
    try {
      return await this.jobs.waitForResult<T>(id, timeoutMs);
    } catch (err) {
      if (err instanceof JobTimeoutError) throw new AppError('workspace_busy', 'La sandbox ne répond pas dans les délais');
      if (err instanceof JobFailedError) throw new AppError('conflict', err.message);
      throw err;
    }
  }

  /** Mise en file sans attente (démarrage / arrêt suivis via SSE). */
  async fire(payload: Record<string, unknown>, dedupeKey?: string): Promise<void> {
    await this.jobs.enqueue('sandbox.rpc', payload, { maxAttempts: 1, priority: 10, dedupeKey });
  }
}
