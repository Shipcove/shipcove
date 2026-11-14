/**
 * Contrat d'un harness agentique (SPEC §22). Les types publics de l'application ne dépendent
 * d'aucun type propre à Pi : l'adaptateur `PiAgentRuntime` traduit le protocole de Pi.
 */
export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type RuntimeEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; error: string | null }
  | { type: 'assistant_start'; messageKey: string }
  | { type: 'text_delta'; messageKey: string; delta: string }
  | { type: 'thinking_delta'; messageKey: string; delta: string }
  | {
      type: 'assistant_end';
      messageKey: string;
      text: string;
      thinking: string;
      stopReason: string | null;
      errorMessage: string | null;
      model: string | null;
      usage: RuntimeUsage | null;
    }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_update'; toolCallId: string; output: string }
  | { type: 'tool_end'; toolCallId: string; toolName: string; output: string; isError: boolean; details: unknown }
  | { type: 'compaction_start'; reason: string }
  | { type: 'compaction_end'; tokensBefore: number | null; error: string | null }
  | { type: 'retry'; attempt: number; maxAttempts: number; error: string }
  | { type: 'process_exit'; code: number | null; stderr: string };

/** Requête de l'extension « platform bridge » (dialogue bloquant côté agent). */
export interface BridgeRequest {
  kind: 'checkpoint' | 'rpc';
  payload: unknown;
}

export interface RuntimeImage {
  data: string;
  mimeType: string;
}

export interface SessionStats {
  contextTokens: number | null;
  contextWindow: number | null;
  totalTokens: number | null;
}

export interface AgentRuntime {
  /** Démarre le harness (session reprise si un fichier de session existe). */
  initialize(): Promise<void>;
  prompt(text: string, images?: RuntimeImage[]): Promise<void>;
  /** Message pendant un run : avant le prochain appel LLM (`steer`) ou à la fin (`follow_up`). */
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  setModel(provider: string, modelId: string): Promise<void>;
  /** Niveau de raisonnement (off, minimal, low, medium, high, xhigh). */
  setThinkingLevel(level: string): Promise<void>;
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  sessionStats(): Promise<SessionStats>;
  sessionFile(): Promise<string | null>;
  onEvent(listener: (e: RuntimeEvent) => void): () => void;
  /** Gestionnaire des requêtes de l'extension plateforme ; renvoie la réponse (JSON). */
  setBridgeHandler(handler: (req: BridgeRequest) => Promise<string>): void;
  close(): Promise<void>;
}
