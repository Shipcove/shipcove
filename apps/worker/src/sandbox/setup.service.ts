import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { workspaces, type Database } from '@cap/database';
import { execCollect } from '@cap/sandbox';
import { DB, SettingsService } from '@cap/server-core';
import { CheckpointService } from './checkpoint.service.js';
import { SandboxManager, type ActiveSandbox } from './sandbox-manager.service.js';

export interface SetupResult {
  ran: boolean;
  ok: boolean;
  exitCode: number | null;
  /** Fin de la sortie, pour l'utilisateur et pour Pi. */
  output: string;
  durationMs: number;
}

const OUTPUT_LIMIT = 20_000;

/**
 * Script de démarrage des sandboxes, unique pour toute la plateforme (Administration → Sandboxes &
 * previews) : registres de paquets, miroirs, outils… Exécuté dans `/workspace`, une fois par
 * sandbox (avec ou sans dépôt) et à chaque modification du script ou de l'image : il doit donc être
 * idempotent. Ce qu'il produit dans `/workspace` est conservé par le checkpoint qui suit ; le reste
 * (`~/.npmrc`, `~/.config/pip`, outils globaux) vit avec la sandbox et est refait à la suivante.
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

  /** Empreinte de la préparation attendue (script + image de la sandbox), `null` sans script. */
  async expected(sb: ActiveSandbox): Promise<{ hash: string; script: string } | null> {
    const { startupScript } = await this.settings.section('sandbox');
    if (!startupScript.trim()) return null;
    const image = (await this.sandboxes.imageFor(sb.workspaceId))?.id ?? 'default';
    return { script: startupScript, hash: createHash('sha256').update(`${image}\n${startupScript}`).digest('hex') };
  }

  async needed(sb: ActiveSandbox): Promise<boolean> {
    const exp = await this.expected(sb);
    if (!exp) return false;
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, sb.workspaceId));
    return !(ws.setupHash === exp.hash && ws.setupInstanceId === sb.instanceId && ws.setupStatus === 'succeeded');
  }

  async run(sb: ActiveSandbox): Promise<SetupResult> {
    const exp = await this.expected(sb);
    if (!exp) return { ran: false, ok: true, exitCode: null, output: '', durationMs: 0 };
    const { setupTimeoutMinutes } = await this.settings.section('sandbox');
    await this.db.update(workspaces).set({ setupStatus: 'running' }).where(eq(workspaces.id, sb.workspaceId));
    const started = Date.now();
    await this.sandboxes.writeFiles(sb.handle, [{ path: 'run/cap/setup.sh', content: exp.script, mode: 0o755 }]);
    let exitCode: number | null = null;
    let raw = '';
    try {
      const r = await execCollect(this.sandboxes.provider, sb.handle, ['bash', '-e', '-o', 'pipefail', '/run/cap/setup.sh'], {
        env: { ...this.sandboxes.forgeEnv(sb), HOME: '/home/agent', CI: '1' },
        workdir: '/workspace',
        timeoutMs: setupTimeoutMinutes * 60_000,
        maxBytes: 2_000_000,
      });
      exitCode = r.exitCode;
      raw = `${r.stdout.toString('utf8')}${r.stderr.toString('utf8')}`;
    } catch (err) {
      raw = `Démarrage interrompu : ${(err as Error).message}`;
    }
    const ok = exitCode === 0;
    const output = raw.length > OUTPUT_LIMIT ? `[…]\n${raw.slice(-OUTPUT_LIMIT)}` : raw;
    // Résultat conservé (fichiers produits dans /workspace).
    await this.checkpoints
      .run({ workspaceId: sb.workspaceId, fencingToken: sb.fencingToken, provider: this.sandboxes.provider, handle: sb.handle, reason: 'setup', triggerKey: `setup:${sb.instanceId}:${exp.hash}:${started}` })
      .catch((e: Error) => this.logger.warn(`Checkpoint après le script de démarrage : ${e.message}`));
    await this.db
      .update(workspaces)
      .set({ setupHash: exp.hash, setupInstanceId: sb.instanceId, setupStatus: ok ? 'succeeded' : 'failed', setupAt: new Date() })
      .where(eq(workspaces.id, sb.workspaceId));
    return { ran: true, ok, exitCode, output, durationMs: Date.now() - started };
  }
}
