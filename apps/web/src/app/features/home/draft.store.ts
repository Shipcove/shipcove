import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { AttachmentDto, ModelDto, UsageSummaryDto, WorkspaceDto } from '@cap/contracts';
import { ApiError, idempotencyKey } from '../../core/api.service';
import type { RepoChoice } from '../../shared/repo-picker';
import { WorkspaceStore, type PlatformConfig } from '../workspace/workspace.store';

const MODEL_KEY = 'cap.home.modelId';
const EFFORT_KEY = 'cap.home.thinkingLevel';
const MODE_KEY = 'cap.home.agentMode';

/**
 * Conversation en brouillon (page d'accueil), pour la même zone de saisie que dans une
 * conversation : modèle, effort et mode gardés localement, fichiers conservés dans le
 * navigateur. Au premier envoi : création de la conversation avec ces réglages, envoi des
 * fichiers (inspectés par le serveur), puis du message. Rien n'est créé tant qu'on n'envoie pas.
 */
@Injectable()
export class DraftWorkspaceStore extends WorkspaceStore {
  override readonly draft = true;
  private readonly router = inject(Router);
  /** Dépôt choisi sous la zone de saisie. */
  readonly repository = signal<RepoChoice | null>(null);
  private readonly files = new Map<string, File>();
  private seq = 0;

  async init(): Promise<void> {
    this.workspace.set(draftWorkspace(read(MODEL_KEY), (read(EFFORT_KEY) as WorkspaceDto['thinkingLevel']) ?? 'medium', (read(MODE_KEY) as WorkspaceDto['agentMode']) ?? 'autonomous'));
    const [models, config, usage] = await Promise.all([
      this.api.get<ModelDto[]>('/models').catch(() => [] as ModelDto[]),
      this.api.get<PlatformConfig>('/platform/config').catch(() => null),
      this.api.get<UsageSummaryDto>('/usage').catch(() => null),
    ]);
    const usable = models.filter((m) => m.available);
    this.models.set(usable);
    this.config.set(config);
    this.usage.set(usage);
    // Modèle mémorisé s'il est toujours proposé, sinon le modèle par défaut.
    const remembered = usable.find((m) => m.id === this.workspace()?.modelId);
    this.workspace.update((w) => (w ? { ...w, modelId: remembered?.id ?? usable.find((m) => m.isDefault)?.id ?? usable[0]?.id ?? null } : w));
  }

  override async update(patch: Partial<Pick<WorkspaceDto, 'modelId' | 'thinkingLevel' | 'agentMode' | 'name'>>): Promise<void> {
    this.workspace.update((w) => (w ? { ...w, ...patch } : w));
    if (patch.modelId) write(MODEL_KEY, patch.modelId);
    if (patch.thinkingLevel) write(EFFORT_KEY, patch.thinkingLevel);
    if (patch.agentMode) write(MODE_KEY, patch.agentMode);
  }

  /** Fichiers gardés localement jusqu'à l'envoi (le serveur les inspectera alors). */
  override async uploadAttachments(files: File[]): Promise<AttachmentDto[]> {
    return files.map((f) => {
      const id = `draft-${++this.seq}`;
      this.files.set(id, f);
      return {
        id,
        fileName: f.name,
        mimeType: f.type || 'application/octet-stream',
        size: f.size,
        kind: f.type.startsWith('image/') ? 'image' : f.type.startsWith('text/') ? 'text' : 'binary',
        status: 'ready',
        rejectionReason: null,
        createdAt: new Date().toISOString(),
      } satisfies AttachmentDto;
    });
  }

  override async removeAttachment(id: string): Promise<void> {
    this.files.delete(id);
  }

  override async refreshUsage(): Promise<void> {
    this.usage.set(await this.api.get<UsageSummaryDto>('/usage').catch(() => null));
  }

  /** Premier envoi : la conversation est créée avec les réglages du brouillon. */
  override async send(text: string, attachmentIds: string[]): Promise<void> {
    const draft = this.workspace()!;
    const repo = this.repository();
    const ws = await this.api.post<WorkspaceDto>('/workspaces', {
      ...(draft.modelId ? { modelId: draft.modelId } : {}),
      thinkingLevel: draft.thinkingLevel,
      agentMode: draft.agentMode,
      ...(repo ? { repository: { gitConnectionId: repo.gitConnectionId, fullName: repo.fullName } } : {}),
    });
    this.conversations.upsert(ws);
    let ids: string[] = [];
    const files = attachmentIds.map((id) => this.files.get(id)).filter((f): f is File => !!f);
    if (files.length) {
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      try {
        const res = await this.api.upload<AttachmentDto[]>(`/workspaces/${ws.id}/attachments`, form);
        for (const a of res.filter((x) => x.status === 'rejected')) this.toast.show(`${a.fileName} refusé : ${a.rejectionReason}`, 'error', 10_000);
        ids = res.filter((a) => a.status === 'ready').map((a) => a.id);
      } catch (err) {
        this.toast.show(`Pièces jointes non envoyées : ${err instanceof ApiError ? err.message : 'erreur'}`, 'error', 10_000);
      }
    }
    await this.api.post(`/workspaces/${ws.id}/messages`, { text, attachmentIds: ids, delivery: 'new_run', modelId: draft.modelId ?? undefined }, { 'Idempotency-Key': idempotencyKey() });
    this.files.clear();
    await this.router.navigate(['/workspaces', ws.id]);
  }
}

function draftWorkspace(modelId: string | null, thinkingLevel: WorkspaceDto['thinkingLevel'], agentMode: WorkspaceDto['agentMode']): WorkspaceDto {
  return {
    id: '',
    ownerId: '',
    name: 'Nouvelle conversation',
    titleSource: 'auto',
    repository: null,
    status: 'ready',
    syncState: 'synced',
    branch: null,
    modelId,
    thinkingLevel,
    agentMode,
    conversationId: '',
    activeRunId: null,
    activeRunStatus: null,
    lastActivityAt: null,
    lastCheckpointAt: null,
    createdAt: new Date().toISOString(),
    archivedAt: null,
    access: 'owner',
  };
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* préférence non conservée */
  }
}
