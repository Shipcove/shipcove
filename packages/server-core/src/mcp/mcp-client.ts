import type { Readable, Writable } from 'node:stream';

/** Client MCP minimal (JSON-RPC 2.0) : transports Streamable HTTP et stdio. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpCallResult {
  isError: boolean;
  text: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

const CLIENT_INFO = { name: 'shipcove', version: '0.1.0' };

function resultText(result: unknown): McpCallResult {
  const r = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown };
  const parts = (r?.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : `[contenu ${c.type}]`));
  if (parts.length === 0 && r?.structuredContent) parts.push(JSON.stringify(r.structuredContent));
  return { isError: !!r?.isError, text: parts.join('\n').slice(0, 200_000) };
}

/** Transport Streamable HTTP (réponses JSON ou flux SSE). */
export class McpHttpClient {
  private sessionId: string | null = null;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly timeoutMs = 60_000,
  ) {}

  private async rpc(method: string, params: unknown, notification = false): Promise<unknown> {
    const id = notification ? undefined : this.nextId++;
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id !== undefined ? { id } : {}) }),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'error',
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (notification) return undefined;
    if (!res.ok) throw new Error(`MCP ${method} : HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    let msg: JsonRpcResponse | undefined;
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      for (const block of text.split(/\n\n/)) {
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (!data) continue;
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed.id === id) msg = parsed;
      }
    } else {
      msg = (await res.json()) as JsonRpcResponse;
    }
    if (!msg) throw new Error(`MCP ${method} : réponse absente`);
    if (msg.error) throw new Error(`MCP ${method} : ${msg.error.message}`);
    return msg.result;
  }

  async initialize(): Promise<{ serverInfo?: { name: string; version: string } }> {
    const r = (await this.rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO })) as {
      serverInfo?: { name: string; version: string };
    };
    await this.rpc('notifications/initialized', {}, true);
    return r;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const r = (await this.rpc('tools/list', {})) as { tools: McpToolInfo[] };
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return resultText(await this.rpc('tools/call', { name, arguments: args }));
  }
}

/** Transport stdio (JSON-RPC délimité par LF) sur des flux arbitraires (ex. exec dans une sandbox). */
export class McpStdioClient {
  private nextId = 1;
  private buffer = '';
  private readonly waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly stdin: Writable,
    stdout: Readable,
    private readonly timeoutMs = 60_000,
  ) {
    stdout.on('data', (c: Buffer) => {
      this.buffer += c.toString('utf8');
      let idx;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcResponse;
          if (typeof msg.id === 'number' && this.waiting.has(msg.id)) {
            const w = this.waiting.get(msg.id)!;
            this.waiting.delete(msg.id);
            if (msg.error) w.reject(new Error(msg.error.message));
            else w.resolve(msg.result);
          }
        } catch {
          /* journal du serveur sur stdout : ignoré */
        }
      }
    });
  }

  private rpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`MCP ${method} : délai dépassé`));
      }, this.timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO });
    this.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  }

  async listTools(): Promise<McpToolInfo[]> {
    const r = (await this.rpc('tools/list', {})) as { tools: McpToolInfo[] };
    return r.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return resultText(await this.rpc('tools/call', { name, arguments: args }));
  }
}
