import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { repositories, workspaces, type Database } from '@cap/database';
import { execCollect } from '@cap/sandbox';
import { DB, SettingsService, scrubSecrets, type ResolvedEnvironment } from '@cap/server-core';
import { CheckpointService } from './checkpoint.service.js';
import { SandboxManager, type ActiveSandbox } from './sandbox-manager.service.js';

export interface SetupResult {
  ran: boolean;
  ok: boolean;
  exitCode: number | null;
  /** Fin de la sortie (secrets masqués), pour l'utilisateur et pour Pi. */
  output: string;
  durationMs: number;
}

const OUTPUT_LIMIT = 20_000;

/**
 * Script de préparation du dépôt (dépendances, outils) : exécuté dans `/workspace` avec les
 * variables du dépôt, une fois par sandbox et à chaque modification du script (il doit donc
 * être idempotent, comme une étape de CI). Ce qu'il produit dans `/workspace` est conservé par
 * le checkpoint qui suit, sauf les dépendances et caches exclus des checkpoints (node_modules…),
 * qu'il réinstalle à chaque nouvelle sandbox ; le reste vit avec la sandbox.
 */
@Injectable()
export class SetupService {
  private readonly logger = new Logger('Setup');

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly sandboxes: SandboxManager,
    private readonly checkpoints: CheckpointService,
    private readonly settings: SettingsService,
  ) {}

  /** Empreinte de la préparation attendue (script + image), `null` sans script. */
  async expected(workspaceId: string): Promise<{ hash: string; script: string } | null> {
    const [row] = await this.db
      .select({ script: repositories.setupScript, imageId: repositories.sandboxImageId })
      .from(workspaces)
      .innerJoin(repositories, eq(repositories.id, workspaces.repositoryId))
      .where(eq(workspaces.id, workspaceId));
    if (!row?.script?.trim()) return null;
    return { script: row.script, hash: createHash('sha256').update(`${row.imageId ?? 'default'}\n${row.script}`).digest('hex') };
  }

  async needed(sb: ActiveSandbox): Promise<boolean> {
    const exp = await this.expected(sb.workspaceId);
    if (!exp) return false;
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, sb.workspaceId));
    return !(ws.setupHash === exp.hash && ws.setupInstanceId === sb.instanceId && ws.setupStatus === 'succeeded');
  }

  async run(sb: ActiveSandbox, env: ResolvedEnvironment): Promise<SetupResult> {
    const exp = await this.expected(sb.workspaceId);
    if (!exp) return { ran: false, ok: true, exitCode: null, output: '', durationMs: 0 };
    const { setupTimeoutMinutes } = await this.settings.section('sandbox');
    await this.db.update(workspaces).set({ setupStatus: 'running' }).where(eq(workspaces.id, sb.workspaceId));
    const started = Date.now();
    await this.sandboxes.writeFiles(sb.handle, [{ path: 'run/cap/setup.sh', content: exp.script, mode: 0o755 }]);
    let exitCode: number | null = null;
    let raw = '';
    try {
      const r = await execCollect(this.sandboxes.provider, sb.handle, ['bash', '-e', '-o', 'pipefail', '/run/cap/setup.sh'], {
        env: { ...env.vars, ...this.sandboxes.forgeEnv(sb), HOME: '/home/agent', CI: '1' },
        workdir: '/workspace',
        timeoutMs: setupTimeoutMinutes * 60_000,
        maxBytes: 2_000_000,
      });
      exitCode = r.exitCode;
      raw = `${r.stdout.toString('utf8')}${r.stderr.toString('utf8')}`;
    } catch (err) {
      raw = `Préparation interrompue : ${(err as Error).message}`;
    }
    const ok = exitCode === 0;
    const scrubbed = scrubSecrets(raw, env.secretValues);
    const output = scrubbed.length > OUTPUT_LIMIT ? `[…]\n${scrubbed.slice(-OUTPUT_LIMIT)}` : scrubbed;
    // Résultat conservé (dépendances installées dans /workspace).
    await this.checkpoints
      .run({ workspaceId: sb.workspaceId, fencingToken: sb.fencingToken, provider: this.sandboxes.provider, handle: sb.handle, reason: 'setup', triggerKey: `setup:${sb.instanceId}:${exp.hash}:${started}` })
      .catch((e: Error) => this.logger.warn(`Checkpoint après préparation : ${e.message}`));
    await this.db
      .update(workspaces)
      .set({ setupHash: exp.hash, setupInstanceId: sb.instanceId, setupStatus: ok ? 'succeeded' : 'failed', setupAt: new Date() })
      .where(eq(workspaces.id, sb.workspaceId));
    return { ran: true, ok, exitCode, output, durationMs: Date.now() - started };
  }
}
