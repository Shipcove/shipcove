import { z } from 'zod';

/**
 * Cycle de vie logique d'un workspace (indépendant de la sandbox, éphémère).
 * - `ready`     : état durable restauré au prochain démarrage (veille logique).
 * - `starting`  : lease pris, sandbox en création / restauration.
 * - `running`   : sandbox active.
 * - `stopping`  : checkpoint final puis destruction de la sandbox.
 * - `archived`  : lecture seule, aucune sandbox.
 */
export const WorkspaceStatusSchema = z.enum(['ready', 'starting', 'running', 'stopping', 'archived', 'error']);
export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;

export const SyncStateSchema = z.enum(['synced', 'syncing', 'unsynced']);
export type SyncState = z.infer<typeof SyncStateSchema>;

export const RunStatusSchema = z.enum([
  'queued',
  'running',
  'paused_quota',
  'interrupting',
  'completed',
  'failed',
  'interrupted',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'paused_quota', 'interrupting'];

export const CreateWorkspaceSchema = z.object({
  projectId: z.uuid(),
  name: z.string().min(1).max(120),
  /** Branche à cloner si le projet a un dépôt (défaut : branche par défaut). */
  branch: z.string().min(1).max(255).optional(),
  modelId: z.uuid().optional(),
});
export type CreateWorkspace = z.infer<typeof CreateWorkspaceSchema>;

export const UpdateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  modelId: z.uuid().optional(),
});

export interface WorkspaceDto {
  id: string;
  projectId: string;
  projectName: string;
  teamId: string;
  ownerId: string;
  name: string;
  status: WorkspaceStatus;
  syncState: SyncState;
  branch: string | null;
  modelId: string | null;
  conversationId: string;
  activeRunId: string | null;
  activeRunStatus: RunStatus | null;
  lastActivityAt: string | null;
  lastCheckpointAt: string | null;
  createdAt: string;
  archivedAt: string | null;
  /** Le demandeur est-il propriétaire (sinon accès en lecture via partage) ? */
  access: 'owner' | 'shared_read';
}

export const SendMessageSchema = z.object({
  text: z.string().min(1).max(100_000),
  attachmentIds: z.array(z.uuid()).max(20).default([]),
  /** Modèle pour ce run (sinon celui du workspace). */
  modelId: z.uuid().optional(),
  /** Pendant un run actif : `steer` (avant le prochain appel LLM) ou `follow_up`. */
  delivery: z.enum(['new_run', 'steer', 'follow_up']).default('new_run'),
});
export type SendMessage = z.infer<typeof SendMessageSchema>;

export interface MessageDto {
  id: string;
  conversationId: string;
  runId: string | null;
  role: 'user' | 'assistant' | 'system';
  authorId: string | null;
  text: string;
  thinking: string | null;
  attachments: AttachmentDto[];
  toolCalls: ToolCallDto[];
  model: string | null;
  usage: UsageDto | null;
  stopReason: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ToolCallDto {
  id: string;
  runId: string;
  messageId: string | null;
  toolName: string;
  args: unknown;
  status: 'running' | 'completed' | 'failed' | 'blocked';
  output: string;
  outputTruncated: boolean;
  isError: boolean;
  filesTouched: string[];
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface UsageDto {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  credits: string;
  providerCostUsd: string | null;
  estimated: boolean;
}

export interface AttachmentDto {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'text' | 'archive' | 'binary';
  status: 'pending' | 'ready' | 'rejected';
  rejectionReason: string | null;
  createdAt: string;
}

export interface RunDto {
  id: string;
  workspaceId: string;
  status: RunStatus;
  modelId: string | null;
  modelName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
  pausedReason: string | null;
}

export interface ConversationDto {
  id: string;
  workspaceId: string;
  ownerId: string;
  messages: MessageDto[];
  runs: RunDto[];
  /** Dernier id d'événement SSE persisté (pour reprendre le flux). */
  lastEventId: number;
  context: { tokens: number | null; contextWindow: number | null; percent: number | null };
}

export const CreateShareSchema = z.object({ userId: z.uuid() });
export interface ConversationShareDto {
  id: string;
  conversationId: string;
  user: { id: string; username: string; displayName: string };
  permission: 'READ';
  createdAt: string;
  revokedAt: string | null;
}

/* ---------- Fichiers / diff ---------- */

export interface FileEntryDto {
  path: string;
  type: 'file' | 'dir' | 'symlink';
  size: number;
}

export interface FileContentDto {
  path: string;
  /** Contenu UTF-8 ; `null` si binaire ou trop volumineux. */
  content: string | null;
  binary: boolean;
  size: number;
  /** sha256 du contenu, utilisé comme ETag. */
  etag: string;
  source: 'sandbox' | 'snapshot';
}

export const WriteFileSchema = z.object({
  path: z.string().min(1).max(4096),
  content: z.string().max(5_000_000),
});

export const ChangeScopeSchema = z.enum(['conversation', 'last_run', 'git_head']);
export type ChangeScope = z.infer<typeof ChangeScopeSchema>;

export interface FileChangeDto {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface ChangesResponse {
  scope: ChangeScope;
  baseLabel: string;
  files: FileChangeDto[];
}

export interface FileDiffDto {
  path: string;
  scope: ChangeScope;
  original: string | null;
  modified: string | null;
  binary: boolean;
  /** Patch unifié (format git). */
  patch: string;
}

/* ---------- Previews ---------- */

export interface PreviewPortDto {
  id: string;
  port: number;
  label: string | null;
  url: string;
  createdAt: string;
}
export const OpenPreviewSchema = z.object({
  port: z.number().int().min(1024).max(65535),
  label: z.string().max(80).optional(),
});
