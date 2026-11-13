import { Inject, Injectable, Logger } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import tar from 'tar-stream';
import {
  llmModels,
  projects,
  repositories,
  runTokens,
  sandboxImages,
  sandboxInstances,
  users,
  workspaces,
  type Database,
} from '@cap/database';
import {
  DockerSandboxProvider,
  KubernetesSandboxProvider,
  execCollect,
  type SandboxHandle,
  type SandboxProvider,
} from '@cap/sandbox';
import { buildModelsJson, buildSettingsJson, type PiModelConfig } from '@cap/agent-runtime';
import { AppError, DB, ENV, EventsService, SettingsService, randomToken, sha256Hex } from '@cap/server-core';
import { LeaseService } from '@cap/storage';
import type { WorkerEnv } from '../env.js';
import { CheckpointService } from './checkpoint.service.js';
import { SkillsMaterializer } from '../mcp/skills-materializer.service.js';

export interface ActiveSandbox {
  instanceId: string;
  workspaceId: string;
  handle: SandboxHandle;
  fencingToken: number;
  /** Jeton de run (clair) : uniquement en mémoire du worker et dans la sandbox. */
  runToken: string;
}

const LEASE_TTL_MS = 10 * 60_000;
const RUN_TOKEN_TTL_MS = 24 * 3600_000;

/**
 * Cycle de vie des sandboxes (SPEC §10–§11) :
 * démarrage = lease exclusif (fencing) → conteneur durci → restauration vérifiée du dernier
 * checkpoint → initialisation éventuelle (clone / vierge) → configuration de Pi.
 * arrêt = checkpoint final ; en cas d'échec la destruction est refusée (pas de perte d'écriture).
 */
@Injectable()
export class SandboxManager {
  private readonly logger = new Logger('SandboxManager');
  readonly provider: SandboxProvider;
  /** Sandboxes connues de ce processus (le jeton de run n'est jamais persisté en clair). */
  private readonly cache = new Map<string, ActiveSandbox>();
  private readonly starting = new Map<string, Promise<ActiveSandbox>>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: WorkerEnv,
    private readonly settings: SettingsService,
    private readonly checkpoints: CheckpointService,
    private readonly events: EventsService,
    private readonly skills: SkillsMaterializer,
  ) {
    this.provider =
      env.SANDBOX_PROVIDER === 'kubernetes'
        ? new KubernetesSandboxProvider({ namespace: env.K8S_NAMESPACE, egressProxyUrl: env.EGRESS_PROXY_URL, runtimeClassName: env.K8S_RUNTIME_CLASS, inCluster: true })
        : new DockerSandboxProvider({ socketPath: env.DOCKER_SOCKET, network: env.SANDBOX_NETWORK, egressProxyUrl: env.EGRESS_PROXY_URL, runtime: env.SANDBOX_RUNTIME });
  }

  get leases(): LeaseService {
    return new LeaseService(this.db);
  }

  /** Renvoie la sandbox active du workspace, en la démarrant si nécessaire (idempotent). */
  async ensureRunning(workspaceId: string): Promise<ActiveSandbox> {
    const cached = this.cache.get(workspaceId);
    if (cached) {
      const info = await this.provider.inspect(cached.handle).catch(() => null);
      const [lease] = await this.db.execute<{ fencing_token: number }>(sql`select fencing_token from workspace_leases where workspace_id = ${workspaceId}`).then((r) => r.rows);
      if (info?.state === 'running' && Number(lease?.fencing_token) === cached.fencingToken) return cached;
      this.cache.delete(workspaceId);
    }
    const inflight = this.starting.get(workspaceId);
    if (inflight) return inflight;
    const p = this.startOrAdopt(workspaceId).finally(() => this.starting.delete(workspaceId));
    this.starting.set(workspaceId, p);
    return p;
  }

  /** Sandbox active si elle existe (sans démarrage). */
  async getActive(workspaceId: string): Promise<ActiveSandbox | null> {
    const [inst] = await this.db
      .select()
      .from(sandboxInstances)
      .where(and(eq(sandboxInstances.workspaceId, workspaceId), eq(sandboxInstances.status, 'running')));
    if (!inst) return null;
    return this.ensureRunning(workspaceId);
  }

  private async startOrAdopt(workspaceId: string): Promise<ActiveSandbox> {
    const [ws] = await this.db.select().from(workspaces).where(and(eq(workspaces.id, workspaceId), isNull(workspaces.deletedAt)));
    if (!ws) throw new AppError('not_found', 'Workspace introuvable');
    if (ws.status === 'archived') throw new AppError('conflict', 'Workspace archivé');

    // Sandbox déjà active (démarrée par un autre worker) : adoption avec un nouveau jeton de run.
    const [live] = await this.db
      .select()
      .from(sandboxInstances)
      .where(and(eq(sandboxInstances.workspaceId, workspaceId), inArray(sandboxInstances.status, ['creating', 'restoring', 'running', 'stopping'])));
    if (live) {
      if (live.status !== 'running') {
        // Un démarrage est en cours ailleurs : attente bornée.
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          const [s] = await this.db.select().from(sandboxInstances).where(eq(sandboxInstances.id, live.id));
          if (s.status === 'running') return this.adopt(s);
          if (s.status === 'destroyed' || s.status === 'failed') return this.startOrAdopt(workspaceId);
        }
        throw new AppError('workspace_busy', 'Démarrage de la sandbox en cours');
      }
      const info = await this.provider.inspect({ provider: live.provider, externalId: live.externalId!, internalHost: live.internalHost });
      if (info.state === 'running') return this.adopt(live);
      // La sandbox a disparu (crash hôte) : on la déclare détruite. L'état durable reste en S3.
      await this.markDestroyed(live.id, 'disparue');
    }
    return this.start(ws);
  }

  private async adopt(inst: typeof sandboxInstances.$inferSelect): Promise<ActiveSandbox> {
    const lease = await this.leases.current(inst.workspaceId);
    if (!lease || Number(lease.fencingToken) !== Number(inst.leaseToken)) {
      throw new AppError('workspace_busy', 'Lease du workspace incohérent');
    }
    const handle = { provider: inst.provider, externalId: inst.externalId!, internalHost: inst.internalHost };
    const runToken = await this.mintRunToken(inst.workspaceId, inst.id);
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, inst.workspaceId));
    const active: ActiveSandbox = { instanceId: inst.id, workspaceId: inst.workspaceId, handle, fencingToken: Number(inst.leaseToken), runToken };
    await this.configure(active, ws);
    this.cache.set(inst.workspaceId, active);
    return active;
  }

  private async start(ws: typeof workspaces.$inferSelect): Promise<ActiveSandbox> {
    const cfg = await this.settings.section('sandbox');
    // Limites du nombre de sandboxes (distinctes des quotas de crédits).
    const [{ mine }] = await this.db
      .select({ mine: count() })
      .from(sandboxInstances)
      .where(and(eq(sandboxInstances.ownerId, ws.ownerId), inArray(sandboxInstances.status, ['creating', 'restoring', 'running'])));
    if (mine >= cfg.maxActiveSandboxesPerUser) {
      throw new AppError('workspace_busy', `Limite de ${cfg.maxActiveSandboxesPerUser} sandbox(es) active(s) atteinte : arrêtez un autre workspace`);
    }
    const [{ total }] = await this.db
      .select({ total: count() })
      .from(sandboxInstances)
      .where(inArray(sandboxInstances.status, ['creating', 'restoring', 'running']));
    if (total >= cfg.maxActiveSandboxesTotal) throw new AppError('workspace_busy', 'Capacité de la plateforme atteinte, réessayez plus tard');

    const [image] = await this.db.select().from(sandboxImages).where(and(eq(sandboxImages.isDefault, true), eq(sandboxImages.status, 'active')));
    const imageRef = image ? (image.digest ? `${image.reference}@${image.digest}` : image.reference) : this.env.SANDBOX_IMAGE;

    // Instance + lease exclusif (fencing token) dans une même transaction logique.
    const [inst] = await this.db
      .insert(sandboxInstances)
      .values({
        workspaceId: ws.id,
        ownerId: ws.ownerId,
        provider: this.provider.kind,
        imageId: image?.id ?? null,
        status: 'creating',
        workerId: this.env.INSTANCE_ID,
        resources: { cpu: cfg.cpu, memoryMb: cfg.memoryMb, diskMb: cfg.diskMb, pidsLimit: cfg.pidsLimit },
      })
      .returning()
      .catch((err: { code?: string }) => {
        if (err.code === '23505') throw new AppError('workspace_busy', 'Sandbox déjà en cours de démarrage');
        throw err;
      });
    const lease = await this.leases.acquire(ws.id, `sandbox:${inst.id}`, LEASE_TTL_MS);
    if (!lease) {
      await this.markDestroyed(inst.id, 'lease indisponible');
      throw new AppError('workspace_busy', 'Workspace verrouillé par une autre sandbox');
    }
    await this.db.update(sandboxInstances).set({ leaseToken: lease.fencingToken }).where(eq(sandboxInstances.id, inst.id));
    await this.setStatus(ws.id, 'starting', 'Création de la sandbox');

    let handle: SandboxHandle | null = null;
    try {
      handle = await this.provider.create({
        instanceId: inst.id,
        workspaceId: ws.id,
        ownerId: ws.ownerId,
        image: imageRef,
        resources: { cpu: cfg.cpu, memoryMb: cfg.memoryMb, diskMb: cfg.diskMb, pidsLimit: cfg.pidsLimit },
        env: { CAP_WORKSPACE_ID: ws.id, TERM: 'dumb', HOME: '/home/agent' },
      });
      handle = await this.provider.start(handle);
      await this.db
        .update(sandboxInstances)
        .set({ externalId: handle.externalId, internalHost: handle.internalHost, status: 'restoring' })
        .where(eq(sandboxInstances.id, inst.id));

      await this.setStatus(ws.id, 'starting', 'Restauration du dernier checkpoint');
      const restored = await this.checkpoints.storage.restore({ workspaceId: ws.id, fencingToken: lease.fencingToken, provider: this.provider, handle });
      const runToken = await this.mintRunToken(ws.id, inst.id);
      const active: ActiveSandbox = { instanceId: inst.id, workspaceId: ws.id, handle, fencingToken: lease.fencingToken, runToken };
      await this.configure(active, ws);

      if (!ws.initialized && restored.generation === 0) {
        await this.setStatus(ws.id, 'starting', 'Initialisation du workspace');
        await this.initialize(active, ws);
        const ck = await this.checkpoints.run({ workspaceId: ws.id, fencingToken: lease.fencingToken, provider: this.provider, handle, reason: 'init', triggerKey: 'init' });
        await this.db.update(workspaces).set({ initialized: true, baselineGeneration: ck.generation }).where(eq(workspaces.id, ws.id));
      }
      await this.db.update(sandboxInstances).set({ status: 'running', lastActivityAt: new Date() }).where(eq(sandboxInstances.id, inst.id));
      await this.db.update(workspaces).set({ lastActivityAt: new Date() }).where(eq(workspaces.id, ws.id));
      await this.setStatus(ws.id, 'running', null);
      this.cache.set(ws.id, active);
      this.logger.log(`Sandbox ${inst.id} active pour ${ws.id} (génération ${restored.generation}, ${restored.files} fichiers restaurés)`);
      return active;
    } catch (err) {
      this.logger.error(`Démarrage ${ws.id} : ${(err as Error).message}`);
      if (handle) await this.provider.destroy(handle).catch(() => undefined);
      await this.markDestroyed(inst.id, `échec : ${(err as Error).message}`.slice(0, 500));
      await this.leases.release(lease);
      await this.setStatus(ws.id, 'error', `Démarrage impossible : ${(err as Error).message}`.slice(0, 300));
      throw err;
    }
  }

  /** Écrit la configuration de Pi, Git et des skills dans la sandbox (régénérée à chaque démarrage). */
  private async configure(sb: ActiveSandbox, ws: typeof workspaces.$inferSelect): Promise<void> {
    const models = await this.db
      .select()
      .from(llmModels)
      .where(and(eq(llmModels.enabled, true), isNull(llmModels.deletedAt)));
    const allowed = models.filter((m) => m.allowedTeamIds.length === 0 || m.allowedTeamIds.includes(ws.teamId));
    const def = allowed.find((m) => m.id === ws.modelId) ?? allowed.find((m) => m.isDefault) ?? allowed[0];
    const piModels: PiModelConfig[] = allowed.map((m) => ({
      id: m.litellmModel,
      name: m.displayName,
      contextWindow: m.contextWindow,
      maxTokens: m.maxOutputTokens,
      reasoning: m.supportsReasoning,
      input: m.supportsImages ? ['text', 'image'] : ['text'],
    }));
    const [owner] = await this.db.select({ name: users.displayName, email: users.email }).from(users).where(eq(users.id, ws.ownerId));
    const gw = this.env.GATEWAY_INTERNAL_URL.replace(/\/$/, '');
    const gitconfig = [
      '[user]',
      `\tname = ${owner.name.replace(/[\n\r]/g, ' ')}`,
      `\temail = ${owner.email}`,
      `[http "${gw}/git/"]`,
      `\textraHeader = Authorization: Bearer ${sb.runToken}`,
      '',
    ].join('\n');
    const files: Array<{ path: string; content: string; mode?: number }> = [
      { path: 'home/agent/.pi/agent/models.json', content: buildModelsJson(`${gw}/llm/v1`, piModels) },
      { path: 'home/agent/.pi/agent/settings.json', content: buildSettingsJson(def?.litellmModel ?? '') },
      { path: 'home/agent/.gitconfig', content: gitconfig, mode: 0o600 },
      ...(await this.skills.files(ws)),
    ];
    await this.writeFiles(sb.handle, files);
    await this.skills.writeMcpConfig(this, sb, ws);
  }

  /** Écrit des fichiers via un flux tar (sans shell ni interpolation). */
  async writeFiles(handle: SandboxHandle, files: Array<{ path: string; content: string | Buffer; mode?: number }>): Promise<void> {
    const pack = tar.pack();
    const proc = await this.provider.exec(handle, ['tar', '-x', '-f', '-', '-C', '/', '--no-same-owner'], { stdin: pack.pipe(new PassThrough()) });
    proc.stdout.resume();
    const err: Buffer[] = [];
    proc.stderr.on('data', (c: Buffer) => err.push(c));
    for (const f of files) {
      const body = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
      await new Promise<void>((resolve, reject) => pack.entry({ name: f.path, mode: f.mode ?? 0o644, size: body.length }, body, (e) => (e ? reject(e) : resolve())));
    }
    pack.finalize();
    const code = await proc.wait();
    if (code !== 0) throw new Error(`Écriture de fichiers dans la sandbox impossible : ${Buffer.concat(err).toString().slice(0, 300)}`);
  }

  /** Premier démarrage : clone via le proxy Git en lecture (credential côté serveur) ou répertoire vierge. */
  private async initialize(sb: ActiveSandbox, ws: typeof workspaces.$inferSelect): Promise<void> {
    const [p] = await this.db.select().from(projects).where(eq(projects.id, ws.projectId));
    if (!p.repositoryId) return; // projet vierge : répertoire vide
    const [repo] = await this.db.select().from(repositories).where(eq(repositories.id, p.repositoryId));
    const url = `${this.env.GATEWAY_INTERNAL_URL.replace(/\/$/, '')}/git/${repo.id}.git`;
    const branch = ws.branch ?? repo.defaultBranch;
    const r = await execCollect(this.provider, sb.handle, ['git', 'clone', '--branch', branch, '--', url, '/workspace'], {
      timeoutMs: 15 * 60_000,
      env: { GIT_TERMINAL_PROMPT: '0' },
      workdir: '/',
    });
    if (r.exitCode !== 0) {
      // Dépôt vide (aucune branche) : init locale avec le remote configuré.
      const msg = r.stderr.toString('utf8');
      if (/Remote branch .* not found|empty repository/i.test(msg)) {
        await execCollect(this.provider, sb.handle, ['bash', '-c', `git init -q -b ${JSON.stringify(branch)} /workspace && git -C /workspace remote add origin ${JSON.stringify(url)}`]);
      } else {
        throw new Error(`Clonage impossible : ${msg.replace(/Bearer \S+/g, 'Bearer [REDACTED]').slice(0, 500)}`);
      }
    }
    if (!ws.branch) await this.db.update(workspaces).set({ branch }).where(eq(workspaces.id, ws.id));
  }

  /**
   * Arrêt : checkpoint final puis destruction. Si la persistance échoue et que la sandbox
   * contient des écritures non sauvegardées, la destruction normale est refusée.
   */
  async stop(workspaceId: string, reason: string, opts: { force?: boolean } = {}): Promise<{ stopped: boolean; detail: string }> {
    const [inst] = await this.db
      .select()
      .from(sandboxInstances)
      .where(and(eq(sandboxInstances.workspaceId, workspaceId), inArray(sandboxInstances.status, ['running', 'creating', 'restoring'])));
    if (!inst) {
      this.cache.delete(workspaceId);
      return { stopped: true, detail: 'aucune sandbox active' };
    }
    const handle = { provider: inst.provider, externalId: inst.externalId!, internalHost: inst.internalHost };
    await this.db.update(sandboxInstances).set({ status: 'stopping' }).where(eq(sandboxInstances.id, inst.id));
    await this.setStatus(workspaceId, 'stopping', reason);
    if (inst.status === 'running') {
      try {
        await this.checkpoints.run({ workspaceId, fencingToken: Number(inst.leaseToken), provider: this.provider, handle, reason: `stop:${reason}` });
      } catch (err) {
        if (!opts.force) {
          await this.db.update(sandboxInstances).set({ status: 'running' }).where(eq(sandboxInstances.id, inst.id));
          await this.setStatus(workspaceId, 'running', 'Arrêt reporté : checkpoint final en échec');
          return { stopped: false, detail: `checkpoint final en échec : ${(err as Error).message}` };
        }
        this.logger.warn(`Arrêt forcé de ${workspaceId} malgré l'échec du checkpoint final`);
      }
    }
    await this.provider.destroy(handle).catch((e) => this.logger.warn(`destroy: ${(e as Error).message}`));
    await this.markDestroyed(inst.id, reason);
    await this.db.update(runTokens).set({ revokedAt: new Date() }).where(and(eq(runTokens.sandboxInstanceId, inst.id), isNull(runTokens.revokedAt)));
    const lease = await this.leases.current(workspaceId);
    if (lease && lease.holder === `sandbox:${inst.id}`) {
      await this.leases.release({ workspaceId, holder: lease.holder, fencingToken: lease.fencingToken, expiresAt: new Date() });
    }
    this.cache.delete(workspaceId);
    await this.setStatus(workspaceId, 'ready', null);
    return { stopped: true, detail: 'sandbox détruite, état sauvegardé' };
  }

  /** Renouvelle les leases des sandboxes actives (appelé périodiquement). */
  async renewLeases(): Promise<void> {
    const rows = await this.db.select().from(sandboxInstances).where(eq(sandboxInstances.status, 'running'));
    for (const inst of rows) {
      const lease = await this.leases.current(inst.workspaceId);
      if (lease?.holder === `sandbox:${inst.id}` && Number(lease.fencingToken) === Number(inst.leaseToken)) {
        await this.leases.renew({ workspaceId: inst.workspaceId, holder: lease.holder, fencingToken: Number(lease.fencingToken), expiresAt: new Date() }, LEASE_TTL_MS);
      }
    }
  }

  async touch(workspaceId: string): Promise<void> {
    await this.db.update(workspaces).set({ lastActivityAt: new Date() }).where(eq(workspaces.id, workspaceId));
    await this.db
      .update(sandboxInstances)
      .set({ lastActivityAt: new Date() })
      .where(and(eq(sandboxInstances.workspaceId, workspaceId), eq(sandboxInstances.status, 'running')));
  }

  private async mintRunToken(workspaceId: string, instanceId: string): Promise<string> {
    const [ws] = await this.db.select({ ownerId: workspaces.ownerId, teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, workspaceId));
    const token = `cap_rt_${randomToken(32)}`;
    await this.db.insert(runTokens).values({
      tokenHash: sha256Hex(token),
      workspaceId,
      userId: ws.ownerId,
      teamId: ws.teamId,
      sandboxInstanceId: instanceId,
      expiresAt: new Date(Date.now() + RUN_TOKEN_TTL_MS),
    });
    return token;
  }

  private async markDestroyed(instanceId: string, reason: string): Promise<void> {
    await this.db.update(sandboxInstances).set({ status: 'destroyed', destroyedAt: new Date(), destroyReason: reason }).where(eq(sandboxInstances.id, instanceId));
  }

  async setStatus(workspaceId: string, status: 'ready' | 'starting' | 'running' | 'stopping' | 'error', detail: string | null): Promise<void> {
    const [w] = await this.db
      .update(workspaces)
      .set({ status, statusDetail: detail, updatedAt: new Date() })
      .where(eq(workspaces.id, workspaceId))
      .returning({ syncState: workspaces.syncState });
    if (w) await this.events.emit(workspaceId, 'workspace.status', { status, syncState: w.syncState, detail });
  }

  /** Réconciliation après redémarrage : sandboxes orphelines côté moteur ou côté base. */
  async reconcile(): Promise<void> {
    const engine = await this.provider.list().catch(() => []);
    const live = await this.db.select().from(sandboxInstances).where(inArray(sandboxInstances.status, ['creating', 'restoring', 'running', 'stopping']));
    const liveIds = new Set(live.map((l) => l.id));
    for (const c of engine) {
      if (c.instanceId && !liveIds.has(c.instanceId)) {
        this.logger.warn(`Sandbox orpheline ${c.externalId} détruite`);
        await this.provider.destroy({ provider: this.provider.kind, externalId: c.externalId, internalHost: null }).catch(() => undefined);
      }
    }
    const engineIds = new Set(engine.map((c) => c.instanceId));
    for (const l of live) {
      const stale = Date.now() - l.createdAt.getTime() > 120_000;
      if (!engineIds.has(l.id) && stale) {
        await this.markDestroyed(l.id, 'absente du moteur');
        await this.setStatus(l.workspaceId, 'ready', 'Sandbox perdue ; état restauré au prochain démarrage');
      }
    }
  }

  async latestInstances(limit = 100) {
    return this.db.select().from(sandboxInstances).orderBy(desc(sandboxInstances.createdAt)).limit(limit);
  }
}
