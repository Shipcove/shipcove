import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  agentRuns,
  attachments,
  conversations,
  llmModels,
  llmRequests,
  messages,
  toolCalls,
  workspaces,
  type Database,
} from '@cap/database';
import { PI_PROVIDER, PI_TOKEN_ENV, PLAN_MODE_PROMPT, PLAN_MODE_TOOLS, PiAgentRuntime, piCommand, type RuntimeEvent, type RuntimeImage } from '@cap/agent-runtime';
import { DB, ENV, EnvironmentService, EventsService, NotificationService, modelAllowedFor, ObjectStorage, PgNotifier, QuotaService, RunQueueService, StreamScrubber, redactString, scrubDeep, scrubSecrets, type NewEvent } from '@cap/server-core';
import { toUserPath } from '@cap/storage';
import { execCollect } from '@cap/sandbox';
import { SKILLS_DIR, expandSkillCommands } from './skill-expansion.js';
import type { WorkerEnv } from '../env.js';
import { JobRunner } from '../jobs/job-runner.service.js';
import { CheckpointService } from '../sandbox/checkpoint.service.js';
import { SandboxManager, type ActiveSandbox } from '../sandbox/sandbox-manager.service.js';
import { SetupService } from '../sandbox/setup.service.js';
import { NO_REPOSITORY_PROMPT, RepositoryAttachService } from '../sandbox/repository-attach.service.js';
import { ScreenshotsService } from '../sandbox/screenshots.service.js';

/** Outils après lesquels on recherche de nouvelles captures d'écran. */
const SCREENSHOT_TOOLS = new Set(['bash', 'browser_screenshot']);
import { ServicesService } from '../sandbox/services.service.js';
import { BridgeRpcService } from './bridge-rpc.service.js';

const RUN_LEASE_MS = 60_000;
const FLUSH_MS = 100;
const TOOL_OUTPUT_SSE_LIMIT = 20_000;

interface RunContext {
  runId: string;
  workspaceId: string;
  conversationId: string;
  userId: string;
  sandbox: ActiveSandbox;
  runtime: PiAgentRuntime;
  /** messageKey Pi → id du message en base. */
  messageIds: Map<string, string>;
  texts: Map<string, string>;
  lastAssistantMessageId: string | null;
  toolStarts: Map<string, number>;
  toolFiles: Map<string, string[]>;
  /** Appels `bash` qui clonent un dépôt (rattachement automatique, issue #1). */
  cloneCalls?: Set<string>;
  pending: NewEvent[];
  lastToolOutputAt: Map<string, number>;
  done: (result: { error: string | null }) => void;
  finished: Promise<{ error: string | null }>;
  interruptRequested: boolean;
  /** File de traitement : les événements Pi sont appliqués strictement dans l'ordre. */
  queue: Promise<void>;
  /** Valeurs secrètes de l'environnement, masquées dans tout ce qui est persisté ou diffusé. */
  secretValues: string[];
  /** Masquage des flux de texte / raisonnement (secret éventuellement coupé entre fragments). */
  scrubbers: Map<string, StreamScrubber>;
  /** Marqueur de compaction déjà inscrit dans le fil pour ce run. */
  compactionMarked?: boolean;
}

/**
 * Orchestrateur des runs Pi (SPEC §7) :
 * - réclamation atomique du run (`queued → running`) : jamais deux exécutions d'un même run ;
 * - Pi lancé dans la sandbox en mode RPC, session reprise depuis `/workspace-state` ;
 * - événements traduits, persistés (agent_events, messages, tool_calls) et diffusés en SSE ;
 * - checkpoint bloquant après chaque outil (extension) + checkpoint indépendant sur fin d'outil ;
 * - interruption, steering, pause quota et reprise.
 */
/** Commande shell qui clone un dépôt (git, gh, glab). */
const CLONE_RE = /\b(?:git|gh\s+repo|glab\s+repo)\s+clone\b/;

@Injectable()
export class RunOrchestrator implements OnApplicationBootstrap {
  private readonly logger = new Logger('Runs');
  private readonly active = new Map<string, RunContext>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: WorkerEnv,
    private readonly jobs: JobRunner,
    private readonly sandboxes: SandboxManager,
    private readonly checkpoints: CheckpointService,
    private readonly events: EventsService,
    private readonly notifier: PgNotifier,
    private readonly notifications: NotificationService,
    private readonly quotas: QuotaService,
    private readonly storage: ObjectStorage,
    private readonly bridge: BridgeRpcService,
    private readonly runQueue: RunQueueService,
    private readonly environment: EnvironmentService,
    private readonly setup: SetupService,
    private readonly repoAttach: RepositoryAttachService,
    private readonly screenshots: ScreenshotsService,
    private readonly services: ServicesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.jobs.register('run.start', (p) => this.execute((p as { runId: string }).runId), { concurrency: this.env.RUN_CONCURRENCY, leaseMs: RUN_LEASE_MS });
    await this.notifier.on('cap_run_control', (payload) => void this.onControl(payload));
  }

  /* ------------------------------ Contrôle ----------------------------- */

  private async onControl(payload: string): Promise<void> {
    if (!payload) {
      // Reconnexion LISTEN : relire l'état des runs actifs locaux.
      for (const ctx of this.active.values()) await this.checkInterrupt(ctx);
      return;
    }
    let msg: { runId: string; action: 'interrupt' | 'steer' | 'follow_up'; messageId?: string };
    try {
      msg = JSON.parse(payload);
    } catch {
      return;
    }
    const ctx = this.active.get(msg.runId);
    if (!ctx) return;
    if (msg.action === 'interrupt') {
      ctx.interruptRequested = true;
      await ctx.runtime.abort();
      return;
    }
    // Les messages « à la suite » passent par la file durable (RunQueueService), pas par Pi.
    if (msg.action === 'steer' && msg.messageId) {
      const [m] = await this.db.select().from(messages).where(eq(messages.id, msg.messageId));
      if (!m) return;
      const text = await this.expandSkills(ctx.workspaceId, ctx.runId, m.text).catch(() => m.text);
      await ctx.runtime.steer(text).catch((e) => this.logger.warn(`steer: ${e.message}`));
    }
  }

  private async checkInterrupt(ctx: RunContext): Promise<void> {
    const [r] = await this.db.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, ctx.runId));
    if (r?.status === 'interrupting' && !ctx.interruptRequested) {
      ctx.interruptRequested = true;
      await ctx.runtime.abort();
    }
  }

  /* ------------------------------ Exécution ---------------------------- */

  async execute(runId: string): Promise<{ status: string }> {
    // Réclamation atomique : seul le premier worker passe ; une reconnexion ou un rejeu du job
    // ne peut pas relancer un run déjà démarré.
    const claimed = await this.db
      .update(agentRuns)
      .set({ status: 'running', workerId: this.env.INSTANCE_ID, leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS), startedAt: sql`coalesce(${agentRuns.startedAt}, now())` })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, 'queued')))
      .returning();
    if (claimed.length === 0) return { status: 'skipped' };
    const run = claimed[0];
    if (run.pausedReason === 'resuming') await this.db.update(agentRuns).set({ pausedReason: null }).where(eq(agentRuns.id, runId));
    const [ws] = await this.db.select().from(workspaces).where(eq(workspaces.id, run.workspaceId));
    const [conv] = await this.db.select().from(conversations).where(eq(conversations.id, run.conversationId));
    await this.events.emit(ws.id, 'run.started', { runId, model: null }, runId);

    let sandbox: ActiveSandbox;
    try {
      // Image du dépôt modifiée depuis le démarrage de la sandbox : recréation (après checkpoint).
      await this.sandboxes.ensureImage(ws.id);
      sandbox = await this.sandboxes.ensureRunning(ws.id);
      await this.sandboxes.refreshAgentConfig(sandbox);
    } catch (err) {
      await this.finish(runId, ws.id, 'failed', `Sandbox indisponible : ${(err as Error).message}`);
      return { status: 'failed' };
    }
    let setupNote: string | null = null;
    // Catalogue des services d'appui que Pi peut lancer lui-même (rien ne démarre sans sa demande).
    await this.services.writeCatalog(sandbox).catch((e: Error) => this.logger.warn(`Catalogue des services : ${e.message}`));
    // Script de préparation du dépôt : nouvelle sandbox ou script modifié.
    if (await this.setup.needed(sandbox)) {
      await this.systemMessage(ws.id, conv.id, runId, 'Préparation de l’environnement du dépôt…', { kind: 'setup', status: 'running' });
      const r = await this.setup.run(sandbox, await this.environment.forWorkspace(ws.id, { fresh: true }));
      const seconds = Math.round(r.durationMs / 1000);
      await this.systemMessage(
        ws.id,
        conv.id,
        runId,
        r.ok ? `Environnement préparé (${seconds} s)` : `La préparation de l’environnement a échoué (code ${r.exitCode ?? 'inconnu'}, ${seconds} s)`,
        { kind: 'setup', status: r.ok ? 'succeeded' : 'failed', exitCode: r.exitCode, durationMs: r.durationMs, output: r.output },
      );
      if (!r.ok) setupNote = `[Note de la plateforme : le script de préparation du dépôt a échoué (code ${r.exitCode ?? 'inconnu'}). Fin de sa sortie :\n${r.output.slice(-3000)}\nTiens-en compte : des dépendances peuvent manquer.]`;
    }
    const startGen = await this.checkpoints.storage.currentGeneration(ws.id);
    await this.db.update(agentRuns).set({ startGeneration: startGen }).where(eq(agentRuns.id, runId));

    // Modèle du run.
    const modelId = run.modelId ?? ws.modelId;
    // Sans modèle choisi : le modèle par défaut s'il est accessible à l'utilisateur, sinon le premier accessible.
    const [model] = modelId
      ? await this.db.select().from(llmModels).where(eq(llmModels.id, modelId))
      : (await this.db.select().from(llmModels).where(and(eq(llmModels.enabled, true), isNull(llmModels.deletedAt))).orderBy(desc(llmModels.isDefault), llmModels.displayName)).filter((m) => modelAllowedFor(m, ws.ownerId));
    if (!model) {
      await this.finish(runId, ws.id, 'failed', 'Aucun modèle disponible : configurez un modèle dans l’administration');
      return { status: 'failed' };
    }

    // Un seul Pi par workspace : on termine d'éventuels processus orphelins (worker disparu).
    await this.sandboxes.provider.exec(sandbox.handle, ['pkill', '-f', 'pi --mode rpc']).then((p) => p.wait()).catch(() => undefined);
    // Mode Plan : liste blanche d'outils en lecture seule appliquée par Pi lui-même.
    const planMode = run.agentMode === 'plan';
    const command = piCommand({
      sessionFile: conv.piSessionPath,
      skillDirs: [],
      plugins: await this.sandboxes.availablePlugins(sandbox),
      ...(planMode ? { tools: PLAN_MODE_TOOLS } : {}),
      appendSystemPrompt: [planMode ? PLAN_MODE_PROMPT : null, ws.repositoryId ? null : NO_REPOSITORY_PROMPT].filter(Boolean).join('\n\n') || undefined,
    });
    // Variables et secrets du dépôt : processus de Pi (donc ses commandes) uniquement,
    // jamais écrits sur disque par la plateforme. Les variables de la plateforme l'emportent.
    const environment = await this.environment.forWorkspace(ws.id, { fresh: true });
    const proc = await this.sandboxes.provider.exec(sandbox.handle, command, {
      interactive: true,
      env: { ...environment.vars, ...this.sandboxes.forgeEnv(sandbox), [PI_TOKEN_ENV]: sandbox.runToken, HOME: '/home/agent', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
      workdir: '/workspace',
    });
    const runtime = new PiAgentRuntime({ stdin: proc.stdin!, stdout: proc.stdout, stderr: proc.stderr, wait: () => proc.wait(), kill: () => proc.kill() });
    let done!: (r: { error: string | null }) => void;
    const finished = new Promise<{ error: string | null }>((r) => (done = r));
    const ctx: RunContext = {
      runId,
      workspaceId: ws.id,
      conversationId: conv.id,
      userId: run.userId,
      sandbox,
      runtime,
      messageIds: new Map(),
      texts: new Map(),
      lastAssistantMessageId: null,
      toolStarts: new Map(),
      toolFiles: new Map(),
      pending: [],
      lastToolOutputAt: new Map(),
      done,
      finished,
      interruptRequested: false,
      queue: Promise.resolve(),
      secretValues: environment.secretValues,
      scrubbers: new Map(),
    };
    this.active.set(runId, ctx);
    const flusher = setInterval(() => void this.flush(ctx), FLUSH_MS);
    const heartbeat = setInterval(() => void this.heartbeat(ctx), RUN_LEASE_MS / 4);

    let outcome: { error: string | null } = { error: null };
    try {
      // Traitement séquentiel : un delta ne doit jamais précéder l'insertion de son message.
      runtime.onEvent((e) => {
        ctx.queue = ctx.queue.then(() => this.onRuntimeEvent(ctx, e));
      });
      runtime.setBridgeHandler((req) => this.bridge.handle(ctx, req));
      await runtime.initialize();
      await runtime.setModel(PI_PROVIDER, model.litellmModel).catch((e) => {
        throw new Error(`Modèle ${model.litellmModel} indisponible dans Pi : ${e.message}`);
      });
      // Effort : niveau de raisonnement, uniquement pour les modèles qui le supportent.
      const level = model.supportsReasoning ? (run.thinkingLevel ?? ws.thinkingLevel) : 'off';
      await runtime.setThinkingLevel(level).catch((e) => this.logger.warn(`thinking level ${level} : ${e.message}`));
      await this.events.emit(ws.id, 'model.changed', { modelId: model.id, modelName: model.displayName }, runId);
      const compact = await this.compactRequest(run);
      if (compact) {
        // `/compact` : compaction du contexte de Pi, sans nouveau tour de l'agent.
        let error: string | null = null;
        await runtime.compact(compact.instructions || undefined).catch((e: Error) => (error = redactString(e.message)));
        await ctx.queue;
        if (!ctx.compactionMarked) await this.compactionMarker(ctx, { tokensBefore: null, summary: null, error: error ?? 'La compaction n’a pas abouti' });
        outcome = { error };
      } else {
        const { text, images } = await this.promptFor(run);
        // Dépôt rattaché et remonté à la racine depuis le dernier run : Pi doit connaître les nouveaux chemins.
        const repoNote = await this.repoAttach.pendingAgentNote(ws.id).catch(() => null);
        await runtime.prompt([setupNote, repoNote, text].filter(Boolean).join('\n\n'), images);
        outcome = await finished;
      }
    } catch (err) {
      outcome = { error: redactString((err as Error).message) };
    } finally {
      clearInterval(heartbeat);
      clearInterval(flusher);
      // Tous les événements reçus sont appliqués avant la clôture du run.
      await ctx.queue;
      await this.flush(ctx);
      // Session Pi et contexte pour la reprise après destruction de la sandbox.
      const sessionFile = await runtime.sessionFile().catch(() => null);
      const stats = await runtime.sessionStats().catch(() => null);
      await this.db
        .update(conversations)
        .set({
          ...(sessionFile ? { piSessionPath: sessionFile } : {}),
          ...(stats ? { contextTokens: stats.contextTokens, contextWindow: stats.contextWindow } : {}),
          updatedAt: new Date(),
        })
        .where(eq(conversations.id, conv.id));
      await runtime.close();
      this.active.delete(runId);
    }

    // Conversation sans dépôt où Pi en a cloné un : rattachement (Pi est arrêté, le dépôt peut être remonté à la racine).
    await this.repoAttach.tryAttach(sandbox, { runId, allowMove: true });

    // Checkpoint de fin de run (capture aussi les écritures de processus de fond).
    await this.checkpoints
      .run({ workspaceId: ws.id, fencingToken: sandbox.fencingToken, provider: this.sandboxes.provider, handle: sandbox.handle, reason: 'run_end', triggerKey: `run_end:${runId}`, runId })
      .catch(() => undefined);
    await this.sandboxes.touch(ws.id);

    // Issue du run.
    const [current] = await this.db.select({ status: agentRuns.status }).from(agentRuns).where(eq(agentRuns.id, runId));
    if (ctx.interruptRequested || current?.status === 'interrupting') {
      await this.finish(runId, ws.id, 'interrupted', 'Interrompu par l’utilisateur');
      return { status: 'interrupted' };
    }
    const quotaReject = await this.recentQuotaRejection(runId);
    if (quotaReject) {
      // Fenêtre réellement en cause : celle du refus de réservation par la passerelle (une
      // réservation peut dépasser le reste disponible sans que la fenêtre soit à zéro).
      const check = await this.quotas.canProceed(run.userId);
      const window = quotaReject.window ?? check.window ?? 'disabled';
      await this.db.update(agentRuns).set({ status: 'paused_quota', pausedReason: window, leaseExpiresAt: null }).where(eq(agentRuns.id, runId));
      await this.events.emit(ws.id, 'quota.paused', { window, resetsAt: check.window === window ? (check.resetsAt?.toISOString() ?? null) : null }, runId);
      await this.notifications.notify({
        userId: run.userId,
        type: 'quota.reached',
        title: 'Quota atteint',
        body: 'L’agent a été suspendu proprement. Vous pourrez reprendre lorsque votre quota sera de nouveau disponible.',
        link: `/workspaces/${ws.id}`,
        dedupeKey: `quota:${runId}`,
      });
      return { status: 'paused_quota' };
    }
    if (outcome.error) {
      await this.finish(runId, ws.id, 'failed', outcome.error);
      return { status: 'failed' };
    }
    await this.finish(runId, ws.id, 'completed', null);
    return { status: 'completed' };
  }

  /** Run déclenché par `/compact` : instructions facultatives (texte après la commande). */
  private async compactRequest(run: typeof agentRuns.$inferSelect): Promise<{ instructions: string } | null> {
    if (!run.triggerMessageId || run.pausedReason === 'resuming') return null;
    const [m] = await this.db.select({ text: messages.text, meta: messages.meta }).from(messages).where(eq(messages.id, run.triggerMessageId));
    if ((m?.meta as { kind?: string } | null)?.kind !== 'compact') return null;
    return { instructions: m.text.replace(/^\s*\/compact\b/, '').trim() };
  }

  /**
   * Marqueur persistant de compaction (manuelle ou automatique) dans le fil : message système
   * `meta.kind = 'compaction'`, avec le résumé produit par Pi s'il est disponible.
   */
  private async compactionMarker(ctx: RunContext, r: { tokensBefore: number | null; summary: string | null; error: string | null }): Promise<void> {
    ctx.compactionMarked = true;
    // Les événements en tampon (dont `compaction.started`) partent avant le marqueur.
    await this.flush(ctx);
    const summary = r.summary ? scrubSecrets(r.summary, ctx.secretValues).slice(0, 50_000) : null;
    const error = r.error ? scrubSecrets(redactString(r.error), ctx.secretValues).slice(0, 2000) : null;
    await this.systemMessage(
      ctx.workspaceId,
      ctx.conversationId,
      ctx.runId,
      error ? `Échec de la compaction du contexte : ${error}` : 'Contexte de la conversation compacté',
      { kind: 'compaction', status: error ? 'failed' : 'succeeded', tokensBefore: r.tokensBefore, summary, error },
    );
    await this.events.emit(ctx.workspaceId, 'compaction.completed', { error, tokensBefore: r.tokensBefore }, ctx.runId);
  }

  private async promptFor(run: typeof agentRuns.$inferSelect): Promise<{ text: string; images: RuntimeImage[] }> {
    if (run.pausedReason === 'resuming' || !run.triggerMessageId) {
      // Reprise après pause quota : relance explicite, sans rejouer d'action externe.
      return {
        text: 'Reprends la tâche là où tu t’es arrêté. Vérifie l’état actuel avant toute action ; ne répète pas une action externe dont le résultat est incertain.',
        images: [],
      };
    }
    const [m] = await this.db.select().from(messages).where(eq(messages.id, run.triggerMessageId));
    const atts = await this.db.select().from(attachments).where(and(eq(attachments.messageId, m.id), eq(attachments.status, 'ready')));
    const images: RuntimeImage[] = [];
    const notes: string[] = [];
    for (const a of atts) {
      if (a.kind === 'image') {
        const buf = await this.storage.getBuffer(this.storage.attachmentsBucket, a.storageKey);
        if (buf) images.push({ data: buf.toString('base64'), mimeType: a.detectedMimeType });
      } else {
        notes.push(`- ${a.fileName} → /workspace/.cap/attachments/${a.id}/${a.fileName}`);
      }
    }
    // Les pièces jointes non-images sont déposées dans la sandbox (hors snapshot Git par .gitignore local).
    if (atts.some((a) => a.kind !== 'image')) {
      const files: Array<{ path: string; content: Buffer }> = [];
      for (const a of atts.filter((x) => x.kind !== 'image')) {
        const buf = await this.storage.getBuffer(this.storage.attachmentsBucket, a.storageKey);
        if (buf) files.push({ path: `workspace/.cap/attachments/${a.id}/${a.fileName}`, content: buf });
      }
      files.push({ path: 'workspace/.cap/.gitignore', content: Buffer.from('*\n') });
      const sb = this.active.get(run.id)?.sandbox ?? (await this.sandboxes.ensureRunning(run.workspaceId));
      await this.sandboxes.writeFiles(sb.handle, files);
    }
    const body = await this.expandSkills(run.workspaceId, run.id, m.text);
    let text = notes.length ? `${body}\n\nFichiers joints disponibles :\n${notes.join('\n')}` : body;
    // Événements de la plateforme survenus depuis le run précédent (ex. retour en arrière des
    // fichiers) : Pi en est informé, sa mémoire de session ne les contient pas.
    const [prev] = await this.db
      .select({ queuedAt: agentRuns.queuedAt })
      .from(agentRuns)
      .where(and(eq(agentRuns.conversationId, run.conversationId), lt(agentRuns.queuedAt, run.queuedAt)))
      .orderBy(desc(agentRuns.queuedAt))
      .limit(1);
    const platformNotes = await this.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, run.conversationId),
          eq(messages.role, 'system'),
          sql`${messages.meta} ->> 'kind' = 'rewind'`,
          ...(prev ? [gt(messages.createdAt, prev.queuedAt)] : []),
        ),
      )
      .orderBy(messages.createdAt);
    if (platformNotes.length) {
      // Formulation fixe : le texte des messages précédents n'est pas réinjecté dans le prompt.
      text = `[Note de la plateforme : depuis ton dernier échange, l’utilisateur a restauré les fichiers du workspace à un état antérieur (${platformNotes.length} fois). Des modifications que tu as faites ont pu être annulées : ne te fie pas à ta mémoire, vérifie l’état actuel des fichiers avant d’agir.]\n\n${text}`;
    }
    return { text, images };
  }

  /**
   * Skills choisis en tête du message (un ou plusieurs blocs dans l'interface) : développés comme
   * le fait Pi (qui n'en traite qu'un, et seulement en tout début de message).
   */
  private async expandSkills(workspaceId: string, runId: string, text: string): Promise<string> {
    if (!text.trimStart().startsWith('/skill:')) return text;
    const sb = this.active.get(runId)?.sandbox ?? (await this.sandboxes.ensureRunning(workspaceId));
    return expandSkillCommands(text, async (name) => {
      const r = await execCollect(this.sandboxes.provider, sb.handle, ['cat', '--', `${SKILLS_DIR}/${name}/SKILL.md`], { timeoutMs: 15_000 });
      return r.exitCode === 0 ? r.stdout.toString('utf8') : null;
    });
  }

  /** Dernier refus de quota du run (10 min), avec la fenêtre en cause. */
  private async recentQuotaRejection(runId: string): Promise<{ window: '5h' | '7d' | 'disabled' | null } | null> {
    const [row] = await this.db
      .select({ error: llmRequests.error })
      .from(llmRequests)
      .where(and(eq(llmRequests.runId, runId), eq(llmRequests.status, 'rejected'), gt(llmRequests.createdAt, sql`now() - interval '10 minutes'`)))
      .orderBy(desc(llmRequests.createdAt))
      .limit(1);
    if (!row) return null;
    const m = /\((5h|7d|disabled)\)/.exec(row.error ?? '');
    return { window: (m?.[1] as '5h' | '7d' | 'disabled' | undefined) ?? null };
  }

  private async finish(runId: string, workspaceId: string, status: 'completed' | 'failed' | 'interrupted', error: string | null): Promise<void> {
    const [run] = await this.db
      .update(agentRuns)
      .set({ status, error, endedAt: new Date(), leaseExpiresAt: null })
      .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ['running', 'interrupting', 'queued'])))
      .returning();
    if (!run) return;
    const ev: NewEvent =
      status === 'completed'
        ? { type: 'run.completed', runId, data: { runId } }
        : status === 'interrupted'
          ? { type: 'run.interrupted', runId, data: { runId, reason: error ?? 'interrompu' } }
          : { type: 'run.failed', runId, data: { runId, error: error ?? 'échec', retryable: true } };
    await this.events.append(workspaceId, [ev]);
    // Messages envoyés pendant ce run : le suivant de la file démarre un nouveau run.
    await this.runQueue.startNext(run.conversationId).catch((e: Error) => this.logger.warn(`file d'attente : ${e.message}`));
    if (status !== 'interrupted') {
      const [w] = await this.db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, workspaceId));
      await this.notifications.notify({
        userId: run.userId,
        type: status === 'completed' ? 'run.completed' : 'run.failed',
        title: status === 'completed' ? `Tâche terminée dans « ${w?.name} »` : `Échec de la tâche dans « ${w?.name} »`,
        body: status === 'completed' ? 'Pi a terminé son exécution.' : (error ?? 'Erreur inconnue').slice(0, 500),
        link: `/workspaces/${workspaceId}`,
        dedupeKey: `run:${runId}`,
      });
    }
  }

  private async heartbeat(ctx: RunContext): Promise<void> {
    await this.db.update(agentRuns).set({ leaseExpiresAt: new Date(Date.now() + RUN_LEASE_MS) }).where(eq(agentRuns.id, ctx.runId));
    await this.checkInterrupt(ctx);
  }

  /* ------------------------ Traduction des événements ------------------ */

  /** Message système de la conversation (préparation, retour en arrière…), diffusé en temps réel. */
  private async systemMessage(workspaceId: string, conversationId: string, runId: string, text: string, meta: Record<string, unknown>): Promise<void> {
    const [m] = await this.db.insert(messages).values({ conversationId, runId, role: 'system', text, meta }).returning({ id: messages.id });
    await this.events.emit(workspaceId, 'message.created', { messageId: m.id, role: 'system', text, attachmentIds: [], meta }, runId);
  }

  private scrubber(ctx: RunContext, key: string): StreamScrubber {
    let sc = ctx.scrubbers.get(key);
    if (!sc) ctx.scrubbers.set(key, (sc = new StreamScrubber(ctx.secretValues)));
    return sc;
  }

  private push(ctx: RunContext, e: NewEvent): void {
    // Fusion des deltas consécutifs d'un même message (moins d'écritures, même contenu).
    const last = ctx.pending.at(-1);
    if (
      last &&
      ((e.type === 'message.delta' && last.type === 'message.delta') || (e.type === 'thinking.delta' && last.type === 'thinking.delta')) &&
      (last.data as { messageId: string }).messageId === (e.data as { messageId: string }).messageId
    ) {
      (last.data as { delta: string }).delta += (e.data as { delta: string }).delta;
      return;
    }
    ctx.pending.push(e);
  }

  private async flush(ctx: RunContext): Promise<void> {
    if (ctx.pending.length === 0) return;
    const batch = ctx.pending.splice(0, ctx.pending.length);
    try {
      await this.events.append(ctx.workspaceId, batch);
      // Texte partiel persisté : un crash conserve ce qui a déjà été diffusé.
      for (const [key, text] of ctx.texts) {
        const id = ctx.messageIds.get(key);
        if (id) await this.db.update(messages).set({ text }).where(eq(messages.id, id));
      }
    } catch (err) {
      this.logger.error(`flush ${ctx.runId}: ${(err as Error).message}`);
      ctx.pending.unshift(...batch);
    }
  }

  private async onRuntimeEvent(ctx: RunContext, e: RuntimeEvent): Promise<void> {
    try {
      switch (e.type) {
        case 'assistant_start': {
          const [m] = await this.db
            .insert(messages)
            .values({ conversationId: ctx.conversationId, runId: ctx.runId, role: 'assistant', text: '' })
            .returning({ id: messages.id });
          ctx.messageIds.set(e.messageKey, m.id);
          ctx.texts.set(e.messageKey, '');
          ctx.lastAssistantMessageId = m.id;
          this.push(ctx, { type: 'message.created', runId: ctx.runId, data: { messageId: m.id, role: 'assistant', text: '', attachmentIds: [] } });
          break;
        }
        case 'text_delta': {
          const id = ctx.messageIds.get(e.messageKey);
          if (!id) break;
          const sc = this.scrubber(ctx, `text:${e.messageKey}`);
          const delta = sc.push(e.delta);
          ctx.texts.set(e.messageKey, sc.current());
          if (delta) this.push(ctx, { type: 'message.delta', runId: ctx.runId, data: { messageId: id, delta } });
          break;
        }
        case 'thinking_delta': {
          const id = ctx.messageIds.get(e.messageKey);
          const delta = this.scrubber(ctx, `thinking:${e.messageKey}`).push(e.delta);
          if (id && delta) this.push(ctx, { type: 'thinking.delta', runId: ctx.runId, data: { messageId: id, delta } });
          break;
        }
        case 'assistant_end': {
          const id = ctx.messageIds.get(e.messageKey);
          if (!id) break;
          ctx.texts.delete(e.messageKey);
          const textEnd = this.scrubber(ctx, `text:${e.messageKey}`).end(e.text);
          const thinkingEnd = this.scrubber(ctx, `thinking:${e.messageKey}`).end(e.thinking ?? '');
          if (textEnd.rest) this.push(ctx, { type: 'message.delta', runId: ctx.runId, data: { messageId: id, delta: textEnd.rest } });
          if (thinkingEnd.rest) this.push(ctx, { type: 'thinking.delta', runId: ctx.runId, data: { messageId: id, delta: thinkingEnd.rest } });
          ctx.scrubbers.delete(`text:${e.messageKey}`);
          ctx.scrubbers.delete(`thinking:${e.messageKey}`);
          await this.db
            .update(messages)
            .set({
              text: textEnd.text,
              thinking: thinkingEnd.text || null,
              stopReason: e.stopReason,
              model: e.model,
              usage: e.usage,
              completedAt: new Date(),
            })
            .where(eq(messages.id, id));
          this.push(ctx, { type: 'message.completed', runId: ctx.runId, data: { messageId: id, text: textEnd.text, stopReason: e.stopReason } });
          if (e.usage) {
            const stats = await ctx.runtime.sessionStats().catch(() => null);
            const percent = stats?.contextTokens && stats.contextWindow ? Math.min(100, Math.round((stats.contextTokens / stats.contextWindow) * 100)) : null;
            this.push(ctx, { type: 'usage.updated', runId: ctx.runId, data: { contextPercent: percent } });
          }
          break;
        }
        case 'tool_start': {
          ctx.toolStarts.set(e.toolCallId, Date.now());
          if (e.toolName === 'bash' && CLONE_RE.test(String((e.args as { command?: unknown } | null)?.command ?? ''))) (ctx.cloneCalls ??= new Set()).add(e.toolCallId);
          await this.db
            .insert(toolCalls)
            .values({ runId: ctx.runId, messageId: ctx.lastAssistantMessageId, externalId: e.toolCallId, toolName: e.toolName, args: scrubDeep(redactArgs(e.args), ctx.secretValues) })
            .onConflictDoNothing();
          this.push(ctx, { type: 'tool.started', runId: ctx.runId, data: { toolCallId: e.toolCallId, messageId: ctx.lastAssistantMessageId, toolName: e.toolName, args: scrubDeep(redactArgs(e.args), ctx.secretValues) } });
          await this.sandboxes.touch(ctx.workspaceId);
          break;
        }
        case 'tool_update': {
          const last = ctx.lastToolOutputAt.get(e.toolCallId) ?? 0;
          if (Date.now() - last < 250) break;
          ctx.lastToolOutputAt.set(e.toolCallId, Date.now());
          const full = scrubSecrets(e.output, ctx.secretValues);
          const out = full.length > TOOL_OUTPUT_SSE_LIMIT ? full.slice(-TOOL_OUTPUT_SSE_LIMIT) : full;
          this.push(ctx, { type: 'tool.output', runId: ctx.runId, data: { toolCallId: e.toolCallId, output: out, truncated: out.length < full.length } });
          break;
        }
        case 'tool_end': {
          const started = ctx.toolStarts.get(e.toolCallId) ?? Date.now();
          const durationMs = Date.now() - started;
          // Checkpoint indépendant de l'extension (défense en profondeur) : idempotent par clé.
          if (!['read', 'grep', 'find', 'ls'].includes(e.toolName) && !ctx.toolFiles.has(e.toolCallId)) {
            await this.checkpointForTool(ctx, e.toolCallId).catch(() => undefined);
          }
          // Dépôt cloné à la racine : rattaché tout de suite (un clone en sous-dossier attend la fin du run).
          if (ctx.cloneCalls?.delete(e.toolCallId) && !e.isError) await this.repoAttach.tryAttach(ctx.sandbox, { runId: ctx.runId, allowMove: false });
          const files = ctx.toolFiles.get(e.toolCallId) ?? [];
          const output = scrubSecrets(e.output, ctx.secretValues);
          // Captures d'écran de Pi (plugin browser ou scripts) : affichées dans la carte de l'outil.
          const images = SCREENSHOT_TOOLS.has(e.toolName)
            ? await this.screenshots.collect(ctx.sandbox, started).catch((err) => {
                this.logger.warn(`captures (${ctx.runId}) : ${(err as Error).message}`);
                return [];
              })
            : [];
          await this.db
            .update(toolCalls)
            .set({
              status: e.isError ? 'failed' : 'completed',
              output,
              outputTruncated: output.includes('[sortie tronquée]'),
              isError: e.isError,
              filesTouched: files,
              images,
              completedAt: new Date(),
              durationMs,
            })
            .where(and(eq(toolCalls.runId, ctx.runId), eq(toolCalls.externalId, e.toolCallId)));
          const out = output.length > TOOL_OUTPUT_SSE_LIMIT ? output.slice(-TOOL_OUTPUT_SSE_LIMIT) : output;
          this.push(ctx, {
            type: 'tool.completed',
            runId: ctx.runId,
            data: { toolCallId: e.toolCallId, isError: e.isError, output: out, truncated: out.length < output.length, durationMs, filesTouched: files, images },
          });
          await this.sandboxes.touch(ctx.workspaceId);
          break;
        }
        case 'queue':
          // File interne de Pi (guidage) : non exposée, la file utilisateur est durable côté plateforme.
          break;
        case 'compaction_start':
          this.push(ctx, { type: 'compaction.started', runId: ctx.runId, data: { reason: e.reason } });
          break;
        case 'compaction_end':
          await this.compactionMarker(ctx, { tokensBefore: e.tokensBefore, summary: e.summary, error: e.error });
          break;
        case 'agent_end':
          ctx.done({ error: e.error });
          break;
        case 'process_exit':
          ctx.done({ error: e.code === 0 ? null : `Pi s’est arrêté (code ${e.code}) : ${redactString(e.stderr.slice(-500))}` });
          break;
        default:
          break;
      }
    } catch (err) {
      this.logger.error(`événement ${e.type} (${ctx.runId}) : ${(err as Error).message}`);
    }
  }

  /** Checkpoint lié à un appel d'outil (appelé par l'extension puis, à défaut, sur fin d'outil). */
  async checkpointForTool(ctx: RunContext, toolCallId: string): Promise<void> {
    const res = await this.checkpoints.run({
      workspaceId: ctx.workspaceId,
      fencingToken: ctx.sandbox.fencingToken,
      provider: this.sandboxes.provider,
      handle: ctx.sandbox.handle,
      reason: 'tool',
      triggerKey: `tool:${ctx.runId}:${toolCallId}`,
      runId: ctx.runId,
    });
    const paths = res.changed.map((c) => toUserPath(c.path)).filter((p): p is string => !!p);
    ctx.toolFiles.set(toolCallId, paths.slice(0, 200));
  }

  /** Runs dont le worker a disparu : interrompus (jamais relancés automatiquement). */
  async recoverStaleRuns(): Promise<number> {
    const stale = await this.db
      .select()
      .from(agentRuns)
      .where(and(inArray(agentRuns.status, ['running', 'interrupting']), sql`${agentRuns.leaseExpiresAt} < now()`))
      .orderBy(desc(agentRuns.queuedAt))
      .limit(50);
    for (const r of stale) {
      if (this.active.has(r.id)) continue;
      await this.finish(r.id, r.workspaceId, 'interrupted', 'Exécution interrompue (instance worker perdue) ; renvoyez votre message pour reprendre');
    }
    return stale.length;
  }

  activeRuns(): string[] {
    return [...this.active.keys()];
  }
}

export type { RunContext };

/** Les arguments d'outils sont expurgés (jetons éventuellement saisis par l'agent). */
function redactArgs(args: unknown): unknown {
  return JSON.parse(redactString(JSON.stringify(args ?? null)));
}
