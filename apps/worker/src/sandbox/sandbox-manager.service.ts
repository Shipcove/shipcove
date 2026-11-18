import { Inject, Injectable, Logger } from '@nestjs/common';
import { PassThrough } from 'node:stream';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import tar from 'tar-stream';
import {
  gitConnections,
  gitForges,
  llmModels,
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
import { PI_PLUGINS, buildModelsJson, buildSettingsJson, type PiModelConfig } from '@cap/agent-runtime';
import { AppError, DB, ENV, EventsService, GitProviderClient, SettingsService, modelAllowedFor, randomToken, sha256Hex } from '@cap/server-core';
import { isUniqueViolation } from '@cap/server-core';
import { LeaseService } from '@cap/storage';
import type { WorkerEnv } from '../env.js';
import { CheckpointService } from './checkpoint.service.js';
import { GIT_HOOKS_DIR, coAuthorTrailer, gitHookFiles } from './git-hooks.js';
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
/** Magasin de confiance des outils de la sandbox : système + autorité des forges (ADR 0013). */
const CA_FILE = '/run/cap/forge-ca.pem';
const CA_BUNDLE = '/run/cap/ca-bundle.pem';
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
    private readonly git: GitProviderClient,
  ) {
    // La gateway (LLM + Git en lecture) est jointe directement ; tout le reste passe par le proxy d'egress.
    const noProxyHosts = [new URL(env.GATEWAY_INTERNAL_URL).hostname];
    this.provider =
      env.SANDBOX_PROVIDER === 'kubernetes'
        ? new KubernetesSandboxProvider({ namespace: env.K8S_NAMESPACE, egressProxyUrl: env.EGRESS_PROXY_URL, noProxyHosts, runtimeClassName: env.K8S_RUNTIME_CLASS, inCluster: true })
        : new DockerSandboxProvider({ socketPath: env.DOCKER_SOCKET, guard: env.DOCKER_GUARD_URL && env.DOCKER_GUARD_TOKEN ? { url: env.DOCKER_GUARD_URL, token: env.DOCKER_GUARD_TOKEN } : undefined, network: env.SANDBOX_NETWORK, egressProxyUrl: env.EGRESS_PROXY_URL, noProxyHosts, runtime: env.SANDBOX_RUNTIME });
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

  /** Image du dépôt de la conversation si elle est autorisée (active), sinon l'image par défaut. */
  async imageFor(workspaceId: string): Promise<typeof sandboxImages.$inferSelect | null> {
    const [p] = await this.db
      .select({ imageId: repositories.sandboxImageId })
      .from(workspaces)
      .innerJoin(repositories, eq(repositories.id, workspaces.repositoryId))
      .where(eq(workspaces.id, workspaceId));
    if (p?.imageId) {
      const [img] = await this.db.select().from(sandboxImages).where(and(eq(sandboxImages.id, p.imageId), eq(sandboxImages.status, 'active')));
      if (img) return img;
    }
    const [def] = await this.db.select().from(sandboxImages).where(and(eq(sandboxImages.isDefault, true), eq(sandboxImages.status, 'active')));
    return def ?? null;
  }

  /**
   * Image du dépôt modifiée : la sandbox active (autre image) est arrêtée proprement (checkpoint)
   * pour être recréée avec la bonne image au démarrage suivant.
   */
  async ensureImage(workspaceId: string): Promise<boolean> {
    const [live] = await this.db
      .select()
      .from(sandboxInstances)
      .where(and(eq(sandboxInstances.workspaceId, workspaceId), eq(sandboxInstances.status, 'running')));
    if (!live) return false;
    const desired = await this.imageFor(workspaceId);
    if ((desired?.id ?? null) === (live.imageId ?? null)) return false;
    await this.stop(workspaceId, 'changement d’image');
    return true;
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

    const image = await this.imageFor(ws.id);
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
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError('workspace_busy', 'Sandbox déjà en cours de démarrage');
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

  /**
   * Accès aux forges depuis la sandbox (ADR 0013) : git, gh et glab présentent le jeton de run,
   * que la gateway remplace par le jeton OAuth de l'utilisateur. Le magasin de confiance inclut
   * l'autorité des forges de l'installation.
   */
  forgeEnv(sb: ActiveSandbox): Record<string, string> {
    return {
      GH_TOKEN: sb.runToken,
      GITHUB_TOKEN: sb.runToken,
      GH_ENTERPRISE_TOKEN: sb.runToken,
      GITLAB_TOKEN: sb.runToken,
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
      GLAB_CHECK_UPDATE: 'false',
      GIT_TERMINAL_PROMPT: '0',
      SSL_CERT_FILE: CA_BUNDLE,
      GIT_SSL_CAINFO: CA_BUNDLE,
      CURL_CA_BUNDLE: CA_BUNDLE,
      REQUESTS_CA_BUNDLE: CA_BUNDLE,
      NODE_EXTRA_CA_CERTS: CA_FILE,
    };
  }

  private forgeCa: { at: number; pem: string } | null = null;
  private readonly plugins = new Map<string, string[]>();

  /** Plugins Pi présents dans l'image de cette sandbox (une image dérivée ou ancienne peut ne pas les avoir). */
  async availablePlugins(sb: ActiveSandbox): Promise<string[]> {
    const hit = this.plugins.get(sb.instanceId);
    if (hit) return hit;
    const r = await execCollect(this.provider, sb.handle, ['sh', '-c', PI_PLUGINS.map((p) => `[ -f '${p}' ] && echo '${p}'`).join('; ') + '; true'], { timeoutMs: 15_000 });
    const found = r.stdout.toString('utf8').split('\n').filter((l) => (PI_PLUGINS as readonly string[]).includes(l));
    if (this.plugins.size > 500) this.plugins.clear();
    this.plugins.set(sb.instanceId, found);
    return found;
  }

  /** Certificat public de l'autorité des forges, servi par la gateway. */
  private async forgeCaPem(): Promise<string | null> {
    if (this.forgeCa && Date.now() - this.forgeCa.at < 3_600_000) return this.forgeCa.pem;
    try {
      const res = await fetch(`${this.env.GATEWAY_INTERNAL_URL.replace(/\/$/, '')}/forge/ca.pem`, { signal: AbortSignal.timeout(10_000) });
      const pem = await res.text();
      if (!res.ok || !pem.includes('BEGIN CERTIFICATE')) throw new Error(`HTTP ${res.status}`);
      this.forgeCa = { at: Date.now(), pem };
      return pem;
    } catch (err) {
      this.logger.warn(`Autorité des forges indisponible : ${(err as Error).message}`);
      return this.forgeCa?.pem ?? null;
    }
  }

  /** Configuration de glab pour les GitLab auto-hébergés de l'utilisateur (protocole, jeton de run). */
  private async glabConfig(sb: ActiveSandbox, userId: string): Promise<string> {
    const rows = await this.db
      .select({ host: gitConnections.host, provider: gitConnections.provider })
      .from(gitConnections)
      .where(and(eq(gitConnections.userId, userId), isNull(gitConnections.revokedAt)));
    const forges = await this.db.select({ host: gitForges.host, provider: gitForges.provider }).from(gitForges).where(eq(gitForges.enabled, true));
    const hosts = new Map<string, string>();
    for (const r of [...rows, ...forges]) {
      if (r.provider !== 'gitlab_self_managed') continue;
      const origin = await this.git.webOrigin(r.provider, r.host).catch(() => `https://${r.host}`);
      hosts.set(r.host.toLowerCase(), origin.startsWith('http:') ? 'http' : 'https');
    }
    const lines = ['git_protocol: https', 'check_update: false', 'no_prompt: true', 'hosts:', '  gitlab.com:', `    token: ${sb.runToken}`, '    api_protocol: https'];
    for (const [host, proto] of hosts) {
      lines.push(`  ${JSON.stringify(host)}:`, `    token: ${sb.runToken}`, `    api_protocol: ${proto}`, `    git_protocol: ${proto === 'http' ? 'http' : 'https'}`, `    api_host: ${JSON.stringify(host)}`);
    }
    return lines.join('\n') + '\n';
  }

  /** Remote `origin` vers la vraie forge (et non plus le proxy de lecture), pour git, gh et glab. */
  private async alignOrigin(sb: ActiveSandbox, ws: typeof workspaces.$inferSelect): Promise<void> {
    if (!ws.repositoryId) return;
    const [repo] = await this.db.select().from(repositories).where(eq(repositories.id, ws.repositoryId));
    if (!repo) return;
    const proxied = `${this.env.GATEWAY_INTERNAL_URL.replace(/\/$/, '')}/git/${repo.id}.git`;
    const cur = await execCollect(this.provider, sb.handle, ['git', '-C', '/workspace', 'remote', 'get-url', 'origin'], { timeoutMs: 15_000 });
    if (cur.exitCode !== 0 || cur.stdout.toString('utf8').trim() !== proxied) return;
    await execCollect(this.provider, sb.handle, ['git', '-C', '/workspace', 'remote', 'set-url', 'origin', repo.cloneUrl], { timeoutMs: 15_000 });
  }

  /**
   * Régénère la configuration de Pi avant chaque run (modèles, skills, outils MCP) : une sandbox
   * restée active entre deux runs applique ainsi immédiatement révocations et désactivations.
   * Le répertoire des skills est vidé d'abord (un skill retiré ne doit pas subsister).
   */
  async refreshAgentConfig(sb: ActiveSandbox): Promise<void> {
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, sb.workspaceId));
    const rm = await this.provider.exec(sb.handle, ['rm', '-rf', '--', '/home/agent/.pi/agent/skills']);
    const code = await rm.wait();
    if (code !== 0) throw new Error(`Nettoyage des skills impossible (code ${code})`);
    await this.configure(sb, ws);
    await this.alignOrigin(sb, ws).catch((err) => this.logger.warn(`Remote origin : ${(err as Error).message}`));
  }

  /** Écrit la configuration de Pi, Git et des skills dans la sandbox. */
  private async configure(sb: ActiveSandbox, ws: typeof workspaces.$inferSelect): Promise<void> {
    const models = await this.db
      .select()
      .from(llmModels)
      .where(and(eq(llmModels.enabled, true), isNull(llmModels.deletedAt)));
    const allowed = models.filter((m) => modelAllowedFor(m, ws.ownerId));
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
    const trailer = await this.commitTrailer();
    const gitconfig = [
      '[user]',
      `\tname = ${owner.name.replace(/[\n\r]/g, ' ')}`,
      `\temail = ${owner.email}`,
      `[http "${gw}/git/"]`,
      `\textraHeader = Authorization: Bearer ${sb.runToken}`,
      // Hooks de la plateforme (mention de co-auteur), relayés vers ceux du dépôt.
      '[core]',
      `\thooksPath = ${GIT_HOOKS_DIR}`,
      // Forges (ADR 0013) : le jeton de run, remplacé par la gateway par le jeton OAuth.
      '[credential]',
      '\thelper =',
      `\thelper = "!f() { test \\"$1\\" = get || exit 0; echo username=x-access-token; echo password=${sb.runToken}; }; f"`,
      '',
    ].join('\n');
    const caPem = await this.forgeCaPem();
    const files: Array<{ path: string; content: string | Buffer; mode?: number }> = [
      { path: 'home/agent/.pi/agent/models.json', content: buildModelsJson(`${gw}/llm/v1`, piModels) },
      { path: 'home/agent/.pi/agent/settings.json', content: buildSettingsJson(def?.litellmModel ?? '') },
      { path: 'home/agent/.gitconfig', content: gitconfig, mode: 0o600 },
      ...gitHookFiles(trailer),
      { path: 'home/agent/.config/glab-cli/config.yml', content: await this.glabConfig(sb, ws.ownerId), mode: 0o600 },
      { path: CA_FILE.slice(1), content: caPem ?? '', mode: 0o644 },
      ...(await this.skills.files(ws)),
    ];
    await this.writeFiles(sb.handle, files);
    const bundle = await execCollect(this.provider, sb.handle, ['sh', '-c', `cat /etc/ssl/certs/ca-certificates.crt ${CA_FILE} > ${CA_BUNDLE}.tmp && mv ${CA_BUNDLE}.tmp ${CA_BUNDLE}`], { timeoutMs: 15_000 });
    if (bundle.exitCode !== 0) this.logger.warn(`Magasin de confiance de la sandbox : ${bundle.stderr.toString('utf8').slice(0, 200)}`);
    await this.skills.writeMcpConfig(this, sb, ws);
  }

  /** Écrit des fichiers via un flux tar (sans shell ni interpolation). */
  /** Mention de co-auteur ajoutée aux commits de la sandbox (réglage `git.coAuthorEmail`). */
  async commitTrailer(): Promise<string | null> {
    return coAuthorTrailer((await this.settings.section('git')).coAuthorEmail);
  }

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
    if (!ws.repositoryId) return; // conversation sans dépôt : répertoire vide
    const [repo] = await this.db.select().from(repositories).where(eq(repositories.id, ws.repositoryId));
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
    await this.alignOrigin(sb, ws).catch((err) => this.logger.warn(`Remote origin : ${(err as Error).message}`));
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
    const [ws] = await this.db.select({ ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, workspaceId));
    const token = `cap_rt_${randomToken(32)}`;
    await this.db.insert(runTokens).values({
      tokenHash: sha256Hex(token),
      workspaceId,
      userId: ws.ownerId,
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
