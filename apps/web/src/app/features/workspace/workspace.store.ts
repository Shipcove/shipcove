import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  ApprovalDto,
  ConversationDto,
  EventEnvelope,
  MessageDto,
  ModelDto,
  RunDto,
  ToolCallDto,
  UsageSummaryDto,
  WorkspaceDto,
} from '@cap/contracts';
import { Api, idempotencyKey } from '../../core/api.service';
import { SseService, type SseHandle } from '../../core/sse.service';
import { ToastService } from '../../core/toast.service';

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
  private readonly api = inject(Api);
  private readonly sse = inject(SseService);
  private readonly toast = inject(ToastService);

  readonly workspace = signal<WorkspaceDto | null>(null);
  readonly messages = signal<MessageDto[]>([]);
  readonly runs = signal<RunDto[]>([]);
  readonly models = signal<ModelDto[]>([]);
  readonly approvals = signal<ApprovalDto[]>([]);
  readonly usage = signal<UsageSummaryDto | null>(null);
  readonly config = signal<PlatformConfig | null>(null);
  readonly context = signal<{ tokens: number | null; contextWindow: number | null }>({ tokens: null, contextWindow: null });
  readonly streamState = signal<'open' | 'reconnecting' | 'closed'>('closed');
  readonly statusDetail = signal<string | null>(null);
  readonly quotaPaused = signal<{ window: string; resetsAt: string | null } | null>(null);
  /** Incrémenté à chaque changement de fichiers (rafraîchit le panneau Modifications). */
  readonly filesVersion = signal(0);
  readonly lastEventId = signal(0);

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
    void this.api.get<ModelDto[]>('/models', { teamId: ws.teamId }).then((m) => this.models.set(m));
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
    this.lastEventId.set(c.lastEventId);
    this.context.set({ tokens: c.context.tokens, contextWindow: c.context.contextWindow });
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

  async send(text: string, attachmentIds: string[], delivery: 'new_run' | 'steer' | 'follow_up' = 'new_run'): Promise<void> {
    const ws = this.workspace()!;
    await this.api.post(`/workspaces/${ws.id}/messages`, { text, attachmentIds, delivery, modelId: ws.modelId ?? undefined }, { 'Idempotency-Key': idempotencyKey() });
  }

  async interrupt(): Promise<void> {
    const run = this.activeRun();
    if (run) await this.api.post(`/workspaces/${this.workspace()!.id}/runs/${run.id}/interrupt`);
  }

  async resume(): Promise<void> {
    const run = this.runs().find((r) => r.status === 'paused_quota');
    if (run) await this.api.post(`/workspaces/${this.workspace()!.id}/runs/${run.id}/resume`);
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
        this.messages.update((l) => [...l, emptyMessage(id, d['role'] as 'user' | 'assistant', d['text'] as string, e.runId, e.ts)]);
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
          usage: d['usage'] ? { ...(d['usage'] as object), credits: '0', providerCostUsd: null, estimated: false } as MessageDto['usage'] : null,
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
        void this.refreshUsage();
        this.bumpFiles();
        return;
      }
      case 'quota.paused':
        this.quotaPaused.set({ window: d['window'] as string, resetsAt: d['resetsAt'] as string | null });
        this.runs.update((l) => l.map((r) => (r.id === e.runId ? { ...r, status: 'paused_quota' } : r)));
        return;
      case 'quota.resumed':
        this.quotaPaused.set(null);
        return;
      case 'usage.updated':
        if (d['contextTokens'] !== null) this.context.set({ tokens: d['contextTokens'] as number, contextWindow: d['contextWindow'] as number });
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

function emptyMessage(id: string, role: 'user' | 'assistant', text: string, runId: string | null, ts: string): MessageDto {
  return { id, conversationId: '', runId, role, authorId: null, text, thinking: null, attachments: [], toolCalls: [], model: null, usage: null, stopReason: null, createdAt: ts, completedAt: null };
}
