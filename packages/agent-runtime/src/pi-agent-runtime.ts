import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { AgentRuntime, BridgeRequest, RuntimeEvent, RuntimeImage, RuntimeUsage, SessionStats } from './agent-runtime.js';
import { attachJsonlReader } from './jsonl.js';

/** Processus Pi (`pi --mode rpc`) déjà lancé, vu par ses flux standards. */
export interface PiProcessIo {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  wait(): Promise<number>;
  kill(): Promise<void>;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class PiRpcError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(`Pi ${command}: ${message}`);
    this.name = 'PiRpcError';
  }
}

const OUTPUT_LIMIT = 200_000;

/**
 * Adaptateur Pi en mode RPC (docs/rpc.md de Pi). Traduit les événements de Pi en
 * `RuntimeEvent` neutres et relaie les dialogues de l'extension plateforme.
 */
export class PiAgentRuntime implements AgentRuntime {
  private readonly listeners = new Set<(e: RuntimeEvent) => void>();
  private readonly pending = new Map<string, Pending>();
  private bridgeHandler: ((req: BridgeRequest) => Promise<string>) | null = null;
  private stderrTail = '';
  private messageSeq = 0;
  private currentMessageKey: string | null = null;
  private closed = false;
  private exitedOnce = false;

  constructor(private readonly io: PiProcessIo) {}

  async initialize(): Promise<void> {
    attachJsonlReader(this.io.stdout, (line) => this.onLine(line));
    this.io.stderr.on('data', (c: Buffer) => {
      this.stderrTail = (this.stderrTail + c.toString('utf8')).slice(-8000);
    });
    // Fin du processus, y compris si l'attente échoue (flux d'exécution coupé) : sinon le run attendrait.
    void this.io.wait().catch(() => -1).then((code) => this.exited(code, `processus terminé (code ${code})`, this.stderrTail));
    // Vérifie que Pi répond et que la session est chargée.
    await this.send('get_state', {}, 60_000);
  }

  onEvent(listener: (e: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setBridgeHandler(handler: (req: BridgeRequest) => Promise<string>): void {
    this.bridgeHandler = handler;
  }

  async prompt(text: string, images: RuntimeImage[] = []): Promise<void> {
    await this.send('prompt', {
      message: text,
      ...(images.length ? { images: images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType })) } : {}),
    });
  }

  async steer(text: string): Promise<void> {
    await this.send('steer', { message: text });
  }

  async followUp(text: string): Promise<void> {
    await this.send('follow_up', { message: text });
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.send('set_model', { provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.send('set_thinking_level', { level });
  }

  async abort(): Promise<void> {
    await this.send('abort', {}, 15_000).catch(() => undefined);
  }

  async compact(instructions?: string): Promise<void> {
    await this.send('compact', instructions ? { customInstructions: instructions } : {}, 600_000);
  }

  async sessionStats(): Promise<SessionStats> {
    const d = (await this.send('get_session_stats', {})) as {
      tokens?: { total?: number };
      contextUsage?: { tokens: number | null; contextWindow: number | null };
    };
    return {
      contextTokens: d?.contextUsage?.tokens ?? null,
      contextWindow: d?.contextUsage?.contextWindow ?? null,
      totalTokens: d?.tokens?.total ?? null,
    };
  }

  async sessionFile(): Promise<string | null> {
    const d = (await this.send('get_state', {})) as { sessionFile?: string };
    return d?.sessionFile ?? null;
  }

  /**
   * Fin de l'agent constatée de l'extérieur (sandbox arrêtée, conteneur tué) : le flux d'exécution
   * peut ne jamais se fermer, `wait()` ne rendrait alors jamais la main. Les requêtes en cours sont
   * rejetées, `process_exit` est émis, puis le processus est tué au mieux.
   */
  terminate(reason: string): void {
    this.exited(-1, reason, reason);
    void this.io.kill().catch(() => undefined);
  }

  private exited(code: number | null, reason: string, stderr: string): void {
    if (this.exitedOnce) return;
    this.exitedOnce = true;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new PiRpcError('process', reason));
    }
    this.pending.clear();
    this.emit({ type: 'process_exit', code, stderr });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.io.stdin.end();
    } catch {
      /* déjà fermé */
    }
    const exited = await Promise.race([this.io.wait().then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 5000))]);
    if (!exited) await this.io.kill();
  }

  /* ------------------------------------------------------------------ */

  private send(type: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new PiRpcError(type, 'runtime fermé'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PiRpcError(type, 'délai de réponse dépassé'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.io.stdin.write(`${JSON.stringify({ id, type, ...params })}\n`);
    });
  }

  private write(obj: unknown): void {
    if (!this.closed) this.io.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private emit(e: RuntimeEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* un listener défaillant n'interrompt pas le flux */
      }
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // ligne non JSON (ne devrait pas arriver en mode RPC)
    }
    switch (msg.type) {
      case 'response': {
        const id = msg.id as string | undefined;
        if (!id) return;
        const p = this.pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (msg.success) p.resolve(msg.data);
        else p.reject(new PiRpcError(String(msg.command), String(msg.error ?? 'échec')));
        return;
      }
      case 'extension_ui_request':
        void this.onUiRequest(msg);
        return;
      default:
        this.translate(msg);
    }
  }

  private async onUiRequest(msg: Record<string, unknown>): Promise<void> {
    const id = msg.id as string;
    const method = msg.method as string;
    const title = msg.title as string | undefined;
    // Méthodes « fire-and-forget » (notify, setStatus…) : ignorées.
    if (!['select', 'confirm', 'input', 'editor'].includes(method)) return;
    if (method === 'input' && (title === '__cap_checkpoint__' || title === '__cap_rpc__') && this.bridgeHandler) {
      let payload: unknown = null;
      try {
        payload = JSON.parse((msg.placeholder as string) ?? 'null');
      } catch {
        payload = null;
      }
      try {
        const value = await this.bridgeHandler({ kind: title === '__cap_checkpoint__' ? 'checkpoint' : 'rpc', payload });
        this.write({ type: 'extension_ui_response', id, value });
      } catch (err) {
        this.write({
          type: 'extension_ui_response',
          id,
          value: JSON.stringify({ ok: false, text: `Erreur plateforme : ${(err as Error).message}` }),
        });
      }
      return;
    }
    // Aucun humain n'est en ligne de commande : tout autre dialogue est annulé (Pi est autonome).
    this.write({ type: 'extension_ui_response', id, cancelled: true });
  }

  private translate(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'agent_start':
        this.emit({ type: 'agent_start' });
        return;
      case 'agent_end': {
        const messages = (msg.messages as Array<Record<string, unknown>>) ?? [];
        const last = [...messages].reverse().find((m) => m.role === 'assistant');
        const err = last && last.stopReason === 'error' ? String(last.errorMessage ?? 'erreur du modèle') : null;
        this.emit({ type: 'agent_end', error: err });
        return;
      }
      case 'message_start': {
        const m = msg.message as Record<string, unknown> | undefined;
        if (m?.role === 'assistant') {
          this.currentMessageKey = `m${++this.messageSeq}`;
          this.emit({ type: 'assistant_start', messageKey: this.currentMessageKey });
        }
        return;
      }
      case 'message_update': {
        const ev = msg.assistantMessageEvent as Record<string, unknown> | undefined;
        if (!ev || !this.currentMessageKey) return;
        if (ev.type === 'text_delta') this.emit({ type: 'text_delta', messageKey: this.currentMessageKey, delta: String(ev.delta ?? '') });
        else if (ev.type === 'thinking_delta')
          this.emit({ type: 'thinking_delta', messageKey: this.currentMessageKey, delta: String(ev.delta ?? '') });
        return;
      }
      case 'message_end': {
        const m = msg.message as Record<string, unknown> | undefined;
        if (m?.role !== 'assistant' || !this.currentMessageKey) return;
        const content = (m.content as Array<Record<string, unknown>>) ?? [];
        const usage = m.usage as Record<string, number> | undefined;
        this.emit({
          type: 'assistant_end',
          messageKey: this.currentMessageKey,
          text: content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join(''),
          thinking: content.filter((c) => c.type === 'thinking').map((c) => String(c.thinking ?? '')).join(''),
          stopReason: (m.stopReason as string) ?? null,
          errorMessage: (m.errorMessage as string) ?? null,
          model: (m.model as string) ?? null,
          usage: usage ? toUsage(usage) : null,
        });
        this.currentMessageKey = null;
        return;
      }
      case 'tool_execution_start':
        this.emit({ type: 'tool_start', toolCallId: String(msg.toolCallId), toolName: String(msg.toolName), args: msg.args });
        return;
      case 'tool_execution_update':
        this.emit({ type: 'tool_update', toolCallId: String(msg.toolCallId), output: limit(contentText(msg.partialResult)), details: (msg.partialResult as { details?: unknown } | undefined)?.details ?? null });
        return;
      case 'tool_execution_end': {
        const result = msg.result as Record<string, unknown> | undefined;
        this.emit({
          type: 'tool_end',
          toolCallId: String(msg.toolCallId),
          toolName: String(msg.toolName),
          output: limit(contentText(result)),
          isError: !!msg.isError,
          details: result?.details ?? null,
        });
        return;
      }
      case 'compaction_start':
        this.emit({ type: 'compaction_start', reason: String(msg.reason ?? 'manual') });
        return;
      case 'compaction_end': {
        const r = msg.result as { tokensBefore?: number; summary?: unknown } | null;
        this.emit({
          type: 'compaction_end',
          tokensBefore: r?.tokensBefore ?? null,
          summary: typeof r?.summary === 'string' ? r.summary : null,
          error: (msg.errorMessage as string) ?? null,
          willRetry: msg.willRetry === true,
        });
        return;
      }
      case 'queue_update':
        this.emit({
          type: 'queue',
          followUp: ((msg.followUp as unknown[]) ?? []).map(String),
          steering: ((msg.steering as unknown[]) ?? []).map(String),
        });
        return;
      case 'auto_retry_start':
        this.emit({ type: 'retry', attempt: Number(msg.attempt), maxAttempts: Number(msg.maxAttempts), error: String(msg.errorMessage ?? '') });
        return;
      default:
        return;
    }
  }
}

function toUsage(u: Record<string, number>): RuntimeUsage {
  return {
    inputTokens: Number(u.input ?? 0),
    outputTokens: Number(u.output ?? 0),
    cacheReadTokens: Number(u.cacheRead ?? 0),
    cacheWriteTokens: Number(u.cacheWrite ?? 0),
  };
}

function contentText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function limit(s: string): string {
  return s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT / 2)}\n…[sortie tronquée]…\n${s.slice(-OUTPUT_LIMIT / 2)}` : s;
}
