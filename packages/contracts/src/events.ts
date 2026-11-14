/**
 * Contrat des événements SSE agentiques — version 1.
 *
 * - `id` : entier monotone **par workspace**, persisté (table `agent_events`) ; utilisé
 *   comme `id:` SSE et repris via l'en-tête `Last-Event-ID`.
 * - Les événements de flux à haute fréquence (`message.delta`, `tool.output`) sont aussi
 *   persistés afin qu'une reconnexion rejoue exactement ce qui a été émis.
 * - Si `Last-Event-ID` désigne un événement purgé par la rétention, le serveur émet d'abord
 *   `stream.resync` ; le client doit recharger la conversation (`GET /conversation`) puis
 *   reprendre à `data.fromId`.
 * - Une reconnexion ne relance jamais Pi : le flux est lu depuis la base.
 */
import type { ToolImageDto } from './workspaces.js';
export const EVENT_SCHEMA_VERSION = 1 as const;

export interface EventEnvelope<T extends AgentEventType = AgentEventType> {
  v: typeof EVENT_SCHEMA_VERSION;
  id: number;
  workspaceId: string;
  runId: string | null;
  type: T;
  ts: string;
  data: AgentEventDataMap[T];
}

export interface AgentEventDataMap {
  'stream.resync': { fromId: number; reason: 'expired' | 'gap' };
  'run.queued': { runId: string };
  'run.started': { runId: string; model: string | null };
  'run.completed': { runId: string };
  'run.failed': { runId: string; error: string; retryable: boolean };
  'run.interrupted': { runId: string; reason: string };
  'message.created': { messageId: string; role: 'user' | 'assistant' | 'system'; text: string; attachmentIds: string[]; meta?: Record<string, unknown> | null };
  'message.delta': { messageId: string; delta: string };
  'thinking.delta': { messageId: string; delta: string };
  'message.completed': {
    messageId: string;
    text: string;
    stopReason: string | null;
  };
  'tool.started': { toolCallId: string; messageId: string | null; toolName: string; args: unknown };
  /** `output` = sortie accumulée tronquée (remplace l'affichage précédent). */
  'tool.output': { toolCallId: string; output: string; truncated: boolean };
  'tool.completed': {
    toolCallId: string;
    isError: boolean;
    output: string;
    truncated: boolean;
    durationMs: number;
    filesTouched: string[];
    images?: ToolImageDto[];
  };
  'file.changed': { paths: string[]; generation: number };
  'checkpoint.started': { generation: number };
  'checkpoint.completed': { generation: number; changedFiles: number; bytesUploaded: number };
  'checkpoint.failed': { error: string; willRetry: boolean };
  'approval.required': { approvalId: string; action: GitActionKind; summary: string };
  'approval.resolved': { approvalId: string; decision: 'approved' | 'rejected' | 'expired' };
  'git.operation': { operationId: string; action: GitActionKind; status: string; detail: string | null };
  'quota.paused': { window: '5h' | '7d' | 'team_5h' | 'team_7d' | 'disabled'; resetsAt: string | null };
  'quota.resumed': Record<string, never>;
  /** Pourcentages uniquement : remplissage du contexte (les quotas se relisent via GET /usage). */
  'usage.updated': { contextPercent?: number | null };
  'workspace.status': { status: string; syncState: string; detail: string | null };
  'compaction.started': { reason: string };
  'compaction.completed': Record<string, never>;
  'model.changed': { modelId: string; modelName: string };
  /** File d'attente : messages envoyés pendant une génération, traités chacun par un run à la fin du run courant. */
  'queue.updated': { messages: Array<{ messageId: string; text: string }> };
}

export type AgentEventType = keyof AgentEventDataMap;

export type GitActionKind =
  | 'push'
  | 'create_pull_request'
  | 'create_merge_request'
  | 'merge'
  | 'delete_remote_branch';

export const AGENT_EVENT_TYPES = [
  'stream.resync',
  'run.queued',
  'run.started',
  'run.completed',
  'run.failed',
  'run.interrupted',
  'message.created',
  'message.delta',
  'thinking.delta',
  'message.completed',
  'tool.started',
  'tool.output',
  'tool.completed',
  'file.changed',
  'checkpoint.started',
  'checkpoint.completed',
  'checkpoint.failed',
  'approval.required',
  'approval.resolved',
  'git.operation',
  'quota.paused',
  'quota.resumed',
  'usage.updated',
  'workspace.status',
  'compaction.started',
  'compaction.completed',
  'model.changed',
  'queue.updated',
] as const satisfies readonly AgentEventType[];
