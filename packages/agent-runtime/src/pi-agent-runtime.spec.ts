import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PiAgentRuntime } from './pi-agent-runtime.js';
import type { RuntimeEvent } from './agent-runtime.js';
import { attachJsonlReader } from './jsonl.js';

/** Faux processus Pi : répond aux commandes et émet des événements RPC. */
function fakePi() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exit!: (c: number) => void;
  const exited = new Promise<number>((r) => (exit = r));
  const received: Array<Record<string, unknown>> = [];
  attachJsonlReader(stdin, (line) => {
    const cmd = JSON.parse(line) as Record<string, unknown>;
    received.push(cmd);
    if (cmd.type === 'extension_ui_response') return;
    stdout.write(`${JSON.stringify({ id: cmd.id, type: 'response', command: cmd.type, success: true, data: cmd.type === 'get_state' ? { sessionFile: '/s.jsonl' } : undefined })}\n`);
  });
  return { io: { stdin, stdout, stderr, wait: () => exited, kill: async () => exit(137) }, stdout, received, exit };
}

describe('PiAgentRuntime', () => {
  it('traduit les événements et ne coupe les lignes que sur LF', async () => {
    const pi = fakePi();
    const rt = new PiAgentRuntime(pi.io);
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    await rt.initialize();
    await rt.prompt('bonjour');
    // U+2028 à l'intérieur d'une chaîne JSON ne doit pas couper le message.
    pi.stdout.write(`${JSON.stringify({ type: 'message_start', message: { role: 'assistant' } })}\n`);
    pi.stdout.write(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a b' } })}\n`);
    pi.stdout.write(
      `${JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'a b' }], stopReason: 'stop', usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0 } } })}\n`,
    );
    pi.stdout.write(`${JSON.stringify({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } })}\n`);
    pi.stdout.write(`${JSON.stringify({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => e.type)).toEqual(['assistant_start', 'text_delta', 'assistant_end', 'tool_start', 'tool_end']);
    expect(events[1]).toMatchObject({ delta: 'a b' });
    expect(events[2]).toMatchObject({ usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } });
  });

  it('relaie les requêtes de l’extension plateforme et annule les autres dialogues', async () => {
    const pi = fakePi();
    const rt = new PiAgentRuntime(pi.io);
    await rt.initialize();
    rt.setBridgeHandler(async (req) => JSON.stringify({ ok: true, kind: req.kind }));
    pi.stdout.write(`${JSON.stringify({ type: 'extension_ui_request', id: 'u1', method: 'input', title: '__cap_checkpoint__', placeholder: '{"toolCallId":"t1"}' })}\n`);
    pi.stdout.write(`${JSON.stringify({ type: 'extension_ui_request', id: 'u2', method: 'confirm', title: 'Dangerous?' })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    const responses = pi.received.filter((r) => r.type === 'extension_ui_response');
    expect(responses).toContainEqual({ type: 'extension_ui_response', id: 'u1', value: JSON.stringify({ ok: true, kind: 'checkpoint' }) });
    expect(responses).toContainEqual({ type: 'extension_ui_response', id: 'u2', cancelled: true });
  });

  it('compaction : instructions transmises, résumé et erreur remontés', async () => {
    const pi = fakePi();
    const rt = new PiAgentRuntime(pi.io);
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    await rt.initialize();
    await rt.compact('garde les décisions');
    expect(pi.received.find((c) => c.type === 'compact')).toMatchObject({ customInstructions: 'garde les décisions' });
    pi.stdout.write(`${JSON.stringify({ type: 'compaction_start', reason: 'manual' })}\n`);
    pi.stdout.write(`${JSON.stringify({ type: 'compaction_end', result: { tokensBefore: 12000, summary: 'Résumé' } })}\n`);
    pi.stdout.write(`${JSON.stringify({ type: 'compaction_end', result: null, errorMessage: 'rien à compacter' })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([
      { type: 'compaction_start', reason: 'manual' },
      { type: 'compaction_end', tokensBefore: 12000, summary: 'Résumé', error: null, willRetry: false },
      { type: 'compaction_end', tokensBefore: null, summary: null, error: 'rien à compacter', willRetry: false },
    ]);
  });

  it('rejette les commandes en attente si le processus meurt', async () => {
    const pi = fakePi();
    const rt = new PiAgentRuntime(pi.io);
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    await rt.initialize();
    pi.exit(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(events.at(-1)).toMatchObject({ type: 'process_exit', code: 1 });
    await expect(rt.prompt('x')).rejects.toThrow(/fermé/);
  });

  it('signale la fin du processus même si son attente échoue (flux d’exécution coupé)', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const rt = new PiAgentRuntime({ stdin, stdout, stderr, wait: () => Promise.reject(new Error('flux coupé')), kill: async () => undefined });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    // Avant le correctif : rejet non géré et aucune fin signalée (le run restait en attente).
    await expect(rt.initialize()).rejects.toThrow(/processus terminé \(code -1\)/);
    expect(events).toContainEqual({ type: 'process_exit', code: -1, stderr: '' });
  });
});


describe('PiAgentRuntime : sandbox arrêtée sous l’agent', () => {
  it('terminate() rejette les requêtes en cours et émet process_exit même si le flux ne se ferme jamais', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    // Conteneur tué : le flux d'exécution reste ouvert, aucune réponse, `wait()` ne rend jamais la main.
    attachJsonlReader(stdin, (line) => {
      const cmd = JSON.parse(line) as Record<string, unknown>;
      if (cmd.type === 'get_state') stdout.write(`${JSON.stringify({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: {} })}\n`);
    });
    let killed = false;
    const rt = new PiAgentRuntime({ stdin, stdout, stderr, wait: () => new Promise<number>(() => undefined), kill: async () => void (killed = true) });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e) => events.push(e));
    await rt.initialize();
    const compaction = rt.compact('résumé');
    rt.terminate('sandbox arrêtée');
    rt.terminate('deuxième appel ignoré');
    await expect(compaction).rejects.toThrow(/sandbox arrêtée/);
    expect(events.filter((e) => e.type === 'process_exit')).toEqual([{ type: 'process_exit', code: -1, stderr: 'sandbox arrêtée' }]);
    expect(killed).toBe(true);
    await expect(rt.sessionStats()).rejects.toThrow();
  });
});
