import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  ApprovalDto,
  AttachmentDto,
  ConversationDto,
  EventEnvelope,
  MessageDto,
  ModelDto,
  RunDto,
  ToolCallDto,
  UsageSummaryDto,
  WorkspaceDto,
} from '@cap/contracts';
import { Api, ApiError, idempotencyKey } from '../../core/api.service';
import { SseService, type SseHandle } from '../../core/sse.service';
import { ToastService } from '../../core/toast.service';
import { ConversationsService } from '../../core/conversations.service';

export interface PlatformConfig {
  editor: { manualEditingEnabled: boolean };
  previews: { enabled: boolean; maxPortsPerWorkspace: number };
  attachments: { maxFileMb: number; maxFilesPerMessage: number; allowArchives: boolean };
  sandbox: { idleTimeoutMinutes: number };
  quotas: { enabled: boolean };
}

/**
 * État d'un workspace ouvert : conversation, runs, outils, synchronisation, crédits.
 * Alimenté par un chargement initial puis par le flux SSE (reprise via Last-Event-ID).
 */
@Injectable()
export class WorkspaceStore {
  protected readonly api = inject(Api);
  private readonly sse = inject(SseService);
  protected readonly toast = inject(ToastService);
  protected readonly conversations = inject(ConversationsService);

  /** Brouillon (page d'accueil) : la conversation n'existe pas encore. */
  readonly draft: boolean = false;
  readonly workspace = signal<WorkspaceDto | null>(null);
  readonly messages = signal<MessageDto[]>([]);
  readonly runs = signal<RunDto[]>([]);
  readonly models = signal<ModelDto[]>([]);
  readonly approvals = signal<ApprovalDto[]>([]);
  readonly usage = signal<UsageSummaryDto | null>(null);
  readonly config = signal<PlatformConfig | null>(null);
  /** Remplissage de la fenêtre de contexte (%). */
  readonly contextPercent = signal<number | null>(null);
  readonly streamState = signal<'open' | 'reconnecting' | 'closed'>('closed');
  readonly statusDetail = signal<string | null>(null);
  readonly quotaPaused = signal<{ window: string; resetsAt: string | null } | null>(null);
  /** Incrémenté à chaque changement de fichiers (rafraîchit le panneau Modifications). */
  readonly filesVersion = signal(0);
  readonly lastEventId = signal(0);
  /** Messages envoyés pendant une génération : chacun lancera un run à la fin du run courant. */
  /** Compaction du contexte en cours (manuelle ou automatique). */
  readonly compacting = signal(false);
  readonly queued = signal<Array<{ messageId: string; text: string }>>([]);

  readonly activeRun = computed(() => this.runs().find((r) => ['queued', 'running', 'interrupting', 'paused_quota'].includes(r.status)) ?? null);
  readonly isOwner = computed(() => this.workspace()?.access === 'owner');
  readonly pendingApprovals = computed(() => this.approvals().filter((a) => a.status === 'pending'));
  readonly currentModel = computed<ModelDto | null>(() => {
    const id = this.workspace()?.modelId;
    return this.models().find((m) => m.id === id) ?? this.models().find((m) => m.isDefault) ?? this.models()[0] ?? null;
  });

  private handle: SseHandle | null = null;
  private filesTimer: ReturnType<typeof setTimeout> | null = null;

  async open(workspaceId: string): Promise<void> {
    this.close();
    const ws = await this.api.get<WorkspaceDto>(`/workspaces/${workspaceId}`);
    this.workspace.set(ws);
    await this.loadConversation();
    void this.api.get<ModelDto[]>('/models').then((m) => this.models.set(m));
    void this.api.get<PlatformConfig>('/platform/config').then((c) => this.config.set(c));
    if (ws.access === 'owner') {
      void this.loadApprovals();
      void this.refreshUsage();
    }
    this.handle = this.sse.connect(workspaceId, this.lastEventId(), (e) => this.apply(e), (s) => this.streamState.set(s));
  }

  close(): void {
    this.handle?.close();
    this.handle = null;
    this.streamState.set('closed');
  }

  async loadConversation(): Promise<void> {
    const ws = this.workspace();
    if (!ws) return;
    const c = await this.api.get<ConversationDto>(`/workspaces/${ws.id}/conversation`);
    this.messages.set(c.messages);
    this.runs.set(c.runs);
    this.queued.set(c.queued ?? []);
    this.lastEventId.set(c.lastEventId);
    this.contextPercent.set(c.context.percent);
    const paused = c.runs.find((r) => r.status === 'paused_quota');
    this.quotaPaused.set(paused ? { window: paused.pausedReason ?? 'quota', resetsAt: null } : null);
  }

  async loadApprovals(): Promise<void> {
    const ws = this.workspace();
    if (ws?.access !== 'owner') return;
    this.approvals.set(await this.api.get<ApprovalDto[]>(`/workspaces/${ws.id}/git/approvals`));
  }

  async refreshUsage(): Promise<void> {
    this.usage.set(await this.api.get<UsageSummaryDto>('/usage').catch(() => null));
  }

  async refreshWorkspace(): Promise<void> {
    const ws = this.workspace();
    if (ws) this.workspace.set(await this.api.get<WorkspaceDto>(`/workspaces/${ws.id}`));
  }

  /* ------------------------------ Commandes ------------------------------ */

  async send(text: string, attachmentIds: string[], delivery: 'new_run' | 'steer' | 'follow_up' = 'new_run', answersTo?: string, command?: 'compact'): Promise<void> {
    const ws = this.workspace()!;
    await this.api.post(`/workspaces/${ws.id}/messages`, { text, attachmentIds, delivery, modelId: ws.modelId ?? undefined, answersTo, command }, { 'Idempotency-Key': idempotencyKey() });
  }

  /** File d'attente : retrait ou modification d'un message pas encore transmis (mise à jour locale immédiate, SSE ensuite). */
  async removeQueued(messageId: string): Promise<void> {
    await this.api.delete(`/workspaces/${this.workspace()!.id}/messages/${messageId}`);
    this.queued.update((l) => l.filter((q) => q.messageId !== messageId));
  }

  async editQueued(messageId: string, text: string): Promise<void> {
    await this.api.patch(`/workspaces/${this.workspace()!.id}/messages/${messageId}`, { text });
    this.queued.update((l) => l.map((q) => (q.messageId === messageId ? { ...q, text } : q)));
  }

  /** Retour en arrière des fichiers : état d'avant un run, ou génération explicite (annulation). */
  async rewind(target: { runId: string } | { generation: number }): Promise<void> {
    await this.api.post(`/workspaces/${this.workspace()!.id}/rewind`, target);
    this.bumpFiles();
  }

  /**
   * Arrêt : le bouton passe aussitôt à « Arrêt en cours » (la fin effective arrive par SSE).
   * Si le serveur ne connaît plus de run actif (déjà terminé, événement manqué), l'état local
   * est resynchronisé au lieu d'afficher une erreur.
   */
  async interrupt(): Promise<void> {
    const run = this.activeRun();
    if (!run || run.status === 'interrupting') return;
    const setStatus = (status: RunDto['status']) => this.runs.update((l) => l.map((r) => (r.id === run.id ? { ...r, status } : r)));
    setStatus('interrupting');
    try {
      await this.api.post(`/workspaces/${this.workspace()!.id}/runs/${run.id}/interrupt`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await this.loadConversation();
        return;
      }
      setStatus(run.status);
      throw err;
    }
  }

  async resume(): Promise<void> {
    const run = this.runs().find((r) => r.status === 'paused_quota');
    if (run) await this.api.post(`/workspaces/${this.workspace()!.id}/runs/${run.id}/resume`);
  }

  /** Pièces jointes du prochain message (inspectées par le serveur). */
  async uploadAttachments(files: File[]): Promise<AttachmentDto[]> {
    const form = new FormData();
    for (const f of files) form.append('files', f, f.name);
    return this.api.upload<AttachmentDto[]>(`/workspaces/${this.workspace()!.id}/attachments`, form);
  }

  async removeAttachment(id: string): Promise<void> {
    await this.api.delete(`/workspaces/${this.workspace()!.id}/attachments/${id}`).catch(() => undefined);
  }

  async setModel(modelId: string): Promise<void> {
    await this.update({ modelId });
  }

  /** Préférences du workspace (modèle, effort, mode) : appliquées au prochain run. */
  async update(patch: Partial<Pick<WorkspaceDto, 'modelId' | 'thinkingLevel' | 'agentMode' | 'name'>>): Promise<void> {
    const ws = await this.api.patch<WorkspaceDto>(`/workspaces/${this.workspace()!.id}`, patch);
    this.workspace.set(ws);
  }

  async start(): Promise<void> {
    await this.api.post(`/workspaces/${this.workspace()!.id}/start`);
  }

  async stop(): Promise<void> {
    await this.api.post(`/workspaces/${this.workspace()!.id}/stop`);
  }

  async decide(approvalId: string, decision: 'approve' | 'reject'): Promise<void> {
    await this.api.post(`/approvals/${approvalId}/decision`, { decision }, { 'Idempotency-Key': idempotencyKey() });
    await this.loadApprovals();
  }

  /* -------------------------- Application des événements -------------------------- */

  private apply(e: EventEnvelope): void {
    this.lastEventId.set(e.id);
    const d = e.data as never as Record<string, unknown>;
    switch (e.type) {
      case 'stream.resync':
        void this.loadConversation();
        return;
      case 'message.created': {
        const id = d['messageId'] as string;
        if (this.messages().some((m) => m.id === id)) return;
        this.messages.update((l) => [
          ...l,
          {
            ...emptyMessage(id, d['role'] as 'user' | 'assistant' | 'system', d['text'] as string, e.runId, e.ts),
            meta: (d['meta'] as Record<string, unknown> | undefined) ?? null,
            attachments: (d['attachments'] as AttachmentDto[] | undefined) ?? [],
          },
        ]);
        return;
      }
      case 'message.delta':
        this.patchMessage(d['messageId'] as string, (m) => ({ ...m, text: m.text + (d['delta'] as string) }));
        return;
      case 'thinking.delta':
        this.patchMessage(d['messageId'] as string, (m) => ({ ...m, thinking: (m.thinking ?? '') + (d['delta'] as string) }));
        return;
      case 'message.completed':
        this.patchMessage(d['messageId'] as string, (m) => ({
          ...m,
          text: d['text'] as string,
          stopReason: d['stopReason'] as string | null,
          completedAt: e.ts,
        }));
        return;
      case 'tool.started': {
        const call: ToolCallDto = {
          id: d['toolCallId'] as string,
          runId: e.runId ?? '',
          messageId: (d['messageId'] as string) ?? null,
          toolName: d['toolName'] as string,
          args: d['args'],
          status: 'running',
          output: '',
          outputTruncated: false,
          isError: false,
          filesTouched: [],
          images: [],
          files: [],
          startedAt: e.ts,
          completedAt: null,
          durationMs: null,
        };
        const target = call.messageId ?? this.messages().filter((m) => m.role === 'assistant').at(-1)?.id;
        if (target) this.patchMessage(target, (m) => (m.toolCalls.some((t) => t.id === call.id) ? m : { ...m, toolCalls: [...m.toolCalls, call] }));
        return;
      }
      case 'tool.output':
        this.patchTool(d['toolCallId'] as string, (t) => ({ ...t, output: d['output'] as string, outputTruncated: d['truncated'] as boolean }));
        return;
      case 'tool.completed':
        this.patchTool(d['toolCallId'] as string, (t) => ({
          ...t,
          status: d['isError'] ? 'failed' : 'completed',
          isError: d['isError'] as boolean,
          output: d['output'] as string,
          outputTruncated: d['truncated'] as boolean,
          durationMs: d['durationMs'] as number,
          filesTouched: d['filesTouched'] as string[],
          images: (d['images'] as ToolCallDto['images'] | undefined) ?? t.images ?? [],
          files: (d['files'] as ToolCallDto['files'] | undefined) ?? t.files ?? [],
          completedAt: e.ts,
        }));
        return;
      case 'file.changed':
      case 'checkpoint.completed':
        this.bumpFiles();
        this.workspace.update((w) => (w ? { ...w, syncState: 'synced', lastCheckpointAt: e.ts } : w));
        return;
      case 'checkpoint.failed':
        this.workspace.update((w) => (w ? { ...w, syncState: 'unsynced' } : w));
        return;
      case 'run.queued':
      case 'run.started': {
        const runId = d['runId'] as string;
        this.quotaPaused.set(null);
        this.runs.update((l) => {
          const exists = l.find((r) => r.id === runId);
          if (exists) return l.map((r) => (r.id === runId ? { ...r, status: e.type === 'run.started' ? 'running' : 'queued' } : r));
          return [...l, { id: runId, workspaceId: e.workspaceId, status: e.type === 'run.started' ? 'running' : 'queued', modelId: null, modelName: null, agentMode: this.workspace()?.agentMode ?? 'autonomous', startedAt: e.ts, endedAt: null, error: null, pausedReason: null }];
        });
        return;
      }
      case 'run.completed':
      case 'run.failed':
      case 'run.interrupted': {
        const status = e.type === 'run.completed' ? 'completed' : e.type === 'run.failed' ? 'failed' : 'interrupted';
        this.runs.update((l) => l.map((r) => (r.id === d['runId'] ? { ...r, status, endedAt: e.ts, error: (d['error'] as string) ?? (d['reason'] as string) ?? null } : r)));
        if (e.type === 'run.failed') this.toast.show(`Échec du run : ${d['error']}`, 'error');
        this.compacting.set(false);
        void this.refreshUsage();
        this.bumpFiles();
        return;
      }
      case 'compaction.started':
        this.compacting.set(true);
        return;
      case 'compaction.completed':
        // Succès comme échec sont signalés par le marqueur inscrit dans le fil.
        this.compacting.set(false);
        return;
      case 'queue.updated':
        this.queued.set((d['messages'] as Array<{ messageId: string; text: string }>) ?? []);
        return;
      case 'quota.paused':
        this.quotaPaused.set({ window: d['window'] as string, resetsAt: d['resetsAt'] as string | null });
        this.runs.update((l) => l.map((r) => (r.id === e.runId ? { ...r, status: 'paused_quota' } : r)));
        return;
      case 'quota.resumed':
        this.quotaPaused.set(null);
        return;
      case 'usage.updated':
        // `null` après une compaction : taille inconnue jusqu'à la prochaine réponse du modèle.
        if (typeof d['contextPercent'] === 'number' || d['contextPercent'] === null) this.contextPercent.set(d['contextPercent'] as number | null);
        void this.refreshUsage();
        return;
      case 'approval.required':
        this.toast.show(`Approbation requise : ${d['summary']}`, 'info', 10_000);
        void this.loadApprovals();
        return;
      case 'approval.resolved':
        void this.loadApprovals();
        return;
      case 'git.operation':
        this.toast.show(String(d['detail'] ?? ''), d['status'] === 'succeeded' ? 'success' : d['status'] === 'failed' ? 'error' : 'info', 10_000);
        void this.loadApprovals();
        return;
      case 'workspace.status':
        this.workspace.update((w) => (w ? { ...w, status: d['status'] as WorkspaceDto['status'], syncState: d['syncState'] as WorkspaceDto['syncState'] } : w));
        this.statusDetail.set((d['detail'] as string) ?? null);
        return;
      case 'workspace.renamed': {
        const changes = { name: d['name'] as string, titleSource: d['titleSource'] as WorkspaceDto['titleSource'] };
        this.workspace.update((w) => (w ? { ...w, ...changes } : w));
        this.conversations.patch(this.workspace()!.id, changes);
        return;
      }
      case 'workspace.repository': {
        // Dépôt cloné par Pi et rattaché : en-tête, barre latérale et panneaux Git sans rechargement.
        const changes = { repository: d['repository'] as WorkspaceDto['repository'], branch: d['branch'] as string };
        this.workspace.update((w) => (w ? { ...w, ...changes } : w));
        this.conversations.patch(e.workspaceId, changes);
        this.bumpFiles();
        return;
      }
      case 'workspace.branch': {
        // Pi (git switch) ou l'utilisateur a changé de branche : en-tête, barre latérale, onglet Git.
        const changes = { branch: d['branch'] as string };
        this.workspace.update((w) => (w ? { ...w, ...changes } : w));
        this.conversations.patch(e.workspaceId, changes);
        return;
      }
      case 'model.changed':
        this.workspace.update((w) => (w ? { ...w, modelId: d['modelId'] as string } : w));
        return;
      default:
        return;
    }
  }

  private patchMessage(id: string, fn: (m: MessageDto) => MessageDto): void {
    this.messages.update((l) => l.map((m) => (m.id === id ? fn(m) : m)));
  }

  private patchTool(toolCallId: string, fn: (t: ToolCallDto) => ToolCallDto): void {
    this.messages.update((l) => l.map((m) => (m.toolCalls.some((t) => t.id === toolCallId) ? { ...m, toolCalls: m.toolCalls.map((t) => (t.id === toolCallId ? fn(t) : t)) } : m)));
  }

  private bumpFiles(): void {
    if (this.filesTimer) clearTimeout(this.filesTimer);
    this.filesTimer = setTimeout(() => this.filesVersion.update((v) => v + 1), 400);
  }
}

function emptyMessage(id: string, role: 'user' | 'assistant' | 'system', text: string, runId: string | null, ts: string): MessageDto {
  return { id, conversationId: '', runId, role, authorId: null, text, thinking: null, attachments: [], toolCalls: [], model: null, stopReason: null, meta: null, createdAt: ts, completedAt: null };
}
