import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
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
import { DB, ENV, EventsService, NotificationService, ObjectStorage, PgNotifier, QuotaService, redactString, type NewEvent } from '@cap/server-core';
import { toUserPath } from '@cap/storage';
import type { WorkerEnv } from '../env.js';
import { JobRunner } from '../jobs/job-runner.service.js';
import { CheckpointService } from '../sandbox/checkpoint.service.js';
import { SandboxManager, type ActiveSandbox } from '../sandbox/sandbox-manager.service.js';
import { BridgeRpcService } from './bridge-rpc.service.js';

const RUN_LEASE_MS = 60_000;
const FLUSH_MS = 100;
const TOOL_OUTPUT_SSE_LIMIT = 20_000;

interface RunContext {
  runId: string;
  workspaceId: string;
  conversationId: string;
  userId: string;
  teamId: string;
  sandbox: ActiveSandbox;
  runtime: PiAgentRuntime;
  /** messageKey Pi → id du message en base. */
  messageIds: Map<string, string>;
  texts: Map<string, string>;
  lastAssistantMessageId: string | null;
  toolStarts: Map<string, number>;
  toolFiles: Map<string, string[]>;
  pending: NewEvent[];
  lastToolOutputAt: Map<string, number>;
  done: (result: { error: string | null }) => void;
  finished: Promise<{ error: string | null }>;
  interruptRequested: boolean;
  /** File de traitement : les événements Pi sont appliqués strictement dans l'ordre. */
  queue: Promise<void>;
}

/**
 * Orchestrateur des runs Pi (SPEC §7) :
 * - réclamation atomique du run (`queued → running`) : jamais deux exécutions d'un même run ;
 * - Pi lancé dans la sandbox en mode RPC, session reprise depuis `/workspace-state` ;
 * - événements traduits, persistés (agent_events, messages, tool_calls) et diffusés en SSE ;
 * - checkpoint bloquant après chaque outil (extension) + checkpoint indépendant sur fin d'outil ;
 * - interruption, steering, pause quota et reprise.
 */
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
    if ((msg.action === 'steer' || msg.action === 'follow_up') && msg.messageId) {
      const [m] = await this.db.select().from(messages).where(eq(messages.id, msg.messageId));
      if (!m) return;
      if (msg.action === 'steer') await ctx.runtime.steer(m.text).catch((e) => this.logger.warn(`steer: ${e.message}`));
      else await ctx.runtime.followUp(m.text).catch((e) => this.logger.warn(`follow_up: ${e.message}`));
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
      sandbox = await this.sandboxes.ensureRunning(ws.id);
    } catch (err) {
      await this.finish(runId, ws.id, 'failed', `Sandbox indisponible : ${(err as Error).message}`);
      return { status: 'failed' };
    }
    const startGen = await this.checkpoints.storage.currentGeneration(ws.id);
    await this.db.update(agentRuns).set({ startGeneration: startGen }).where(eq(agentRuns.id, runId));

    // Modèle du run.
    const modelId = run.modelId ?? ws.modelId;
    const [model] = modelId
      ? await this.db.select().from(llmModels).where(eq(llmModels.id, modelId))
      : await this.db.select().from(llmModels).where(and(eq(llmModels.isDefault, true), eq(llmModels.enabled, true)));
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
      ...(planMode ? { tools: PLAN_MODE_TOOLS, appendSystemPrompt: PLAN_MODE_PROMPT } : {}),
    });
    const proc = await this.sandboxes.provider.exec(sandbox.handle, command, {
      interactive: true,
      env: { [PI_TOKEN_ENV]: sandbox.runToken, HOME: '/home/agent', PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
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
      teamId: ws.teamId,
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
      const { text, images } = await this.promptFor(run);
      await runtime.prompt(text, images);
      outcome = await finished;
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
      const check = await this.quotas.canProceed(run.userId, ws.teamId);
      await this.db.update(agentRuns).set({ status: 'paused_quota', pausedReason: check.window ?? 'quota', leaseExpiresAt: null }).where(eq(agentRuns.id, runId));
      await this.events.emit(ws.id, 'quota.paused', { window: (check.window ?? '5h') as '5h', resetsAt: check.resetsAt?.toISOString() ?? null }, runId);
      await this.notifications.notify({
        userId: run.userId,
        type: 'quota.reached',
        title: 'Quota de crédits atteint',
        body: 'L’agent a été suspendu proprement. Vous pourrez reprendre lorsque vos crédits seront disponibles.',
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
    const text = notes.length ? `${m.text}\n\nFichiers joints disponibles :\n${notes.join('\n')}` : m.text;
    return { text, images };
  }

  private async recentQuotaRejection(runId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: llmRequests.id })
      .from(llmRequests)
      .where(and(eq(llmRequests.runId, runId), eq(llmRequests.status, 'rejected'), gt(llmRequests.createdAt, sql`now() - interval '10 minutes'`)))
      .limit(1);
    return rows.length > 0;
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
          ctx.texts.set(e.messageKey, (ctx.texts.get(e.messageKey) ?? '') + e.delta);
          this.push(ctx, { type: 'message.delta', runId: ctx.runId, data: { messageId: id, delta: e.delta } });
          break;
        }
        case 'thinking_delta': {
          const id = ctx.messageIds.get(e.messageKey);
          if (id) this.push(ctx, { type: 'thinking.delta', runId: ctx.runId, data: { messageId: id, delta: e.delta } });
          break;
        }
        case 'assistant_end': {
          const id = ctx.messageIds.get(e.messageKey);
          if (!id) break;
          ctx.texts.delete(e.messageKey);
          await this.db
            .update(messages)
            .set({
              text: e.text,
              thinking: e.thinking || null,
              stopReason: e.stopReason,
              model: e.model,
              usage: e.usage,
              completedAt: new Date(),
            })
            .where(eq(messages.id, id));
          this.push(ctx, { type: 'message.completed', runId: ctx.runId, data: { messageId: id, text: e.text, stopReason: e.stopReason, usage: e.usage } });
          if (e.usage) {
            const stats = await ctx.runtime.sessionStats().catch(() => null);
            const windows = await this.quotas.userWindows(ctx.userId).catch(() => []);
            this.push(ctx, {
              type: 'usage.updated',
              runId: ctx.runId,
              data: {
                credits5h: windows.find((w) => w.window === '5h')?.used ?? '0',
                credits7d: windows.find((w) => w.window === '7d')?.used ?? '0',
                contextTokens: stats?.contextTokens ?? null,
                contextWindow: stats?.contextWindow ?? null,
              },
            });
          }
          break;
        }
        case 'tool_start': {
          ctx.toolStarts.set(e.toolCallId, Date.now());
          await this.db
            .insert(toolCalls)
            .values({ runId: ctx.runId, messageId: ctx.lastAssistantMessageId, externalId: e.toolCallId, toolName: e.toolName, args: redactArgs(e.args) })
            .onConflictDoNothing();
          this.push(ctx, { type: 'tool.started', runId: ctx.runId, data: { toolCallId: e.toolCallId, messageId: ctx.lastAssistantMessageId, toolName: e.toolName, args: redactArgs(e.args) } });
          await this.sandboxes.touch(ctx.workspaceId);
          break;
        }
        case 'tool_update': {
          const last = ctx.lastToolOutputAt.get(e.toolCallId) ?? 0;
          if (Date.now() - last < 250) break;
          ctx.lastToolOutputAt.set(e.toolCallId, Date.now());
          const out = e.output.length > TOOL_OUTPUT_SSE_LIMIT ? e.output.slice(-TOOL_OUTPUT_SSE_LIMIT) : e.output;
          this.push(ctx, { type: 'tool.output', runId: ctx.runId, data: { toolCallId: e.toolCallId, output: out, truncated: out.length < e.output.length } });
          break;
        }
        case 'tool_end': {
          const started = ctx.toolStarts.get(e.toolCallId) ?? Date.now();
          const durationMs = Date.now() - started;
          // Checkpoint indépendant de l'extension (défense en profondeur) : idempotent par clé.
          if (!['read', 'grep', 'find', 'ls'].includes(e.toolName) && !ctx.toolFiles.has(e.toolCallId)) {
            await this.checkpointForTool(ctx, e.toolCallId).catch(() => undefined);
          }
          const files = ctx.toolFiles.get(e.toolCallId) ?? [];
          await this.db
            .update(toolCalls)
            .set({
              status: e.isError ? 'failed' : 'completed',
              output: e.output,
              outputTruncated: e.output.includes('[sortie tronquée]'),
              isError: e.isError,
              filesTouched: files,
              completedAt: new Date(),
              durationMs,
            })
            .where(and(eq(toolCalls.runId, ctx.runId), eq(toolCalls.externalId, e.toolCallId)));
          const out = e.output.length > TOOL_OUTPUT_SSE_LIMIT ? e.output.slice(-TOOL_OUTPUT_SSE_LIMIT) : e.output;
          this.push(ctx, {
            type: 'tool.completed',
            runId: ctx.runId,
            data: { toolCallId: e.toolCallId, isError: e.isError, output: out, truncated: out.length < e.output.length, durationMs, filesTouched: files },
          });
          await this.sandboxes.touch(ctx.workspaceId);
          break;
        }
        case 'compaction_start':
          this.push(ctx, { type: 'compaction.started', runId: ctx.runId, data: { reason: e.reason } });
          break;
        case 'compaction_end':
          this.push(ctx, { type: 'compaction.completed', runId: ctx.runId, data: { tokensBefore: e.tokensBefore } });
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
