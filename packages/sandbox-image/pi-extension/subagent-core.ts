/**
 * Cœur du plugin « subagent » : suivi d'un sous-agent à partir du flux d'événements de
 * `pi --mode json`, sans dépendance à Pi (testé à part, `node --test`).
 */

export type SubagentMode = 'explore' | 'work';
export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted';

export interface SubagentStep {
  tool: string;
  summary: string;
  status: 'running' | 'completed' | 'failed';
}

/** État d'un sous-agent, transmis à l'interface (détails de l'appel d'outil). */
export interface SubagentState {
  title: string;
  mode: SubagentMode;
  status: SubagentStatus;
  /** Étapes (appels d'outils), les plus récentes en dernier. */
  steps: SubagentStep[];
  toolCount: number;
  /** Dernier texte de l'agent : son compte rendu une fois terminé. */
  output: string;
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  tokens: number;
}

export interface SubagentDetails {
  kind: 'subagents';
  agents: SubagentState[];
}

/** Outils de Pi par mode : un explorateur ne peut rien modifier ni exécuter. */
export const TOOLS: Record<SubagentMode, string[]> = {
  explore: ['read', 'grep', 'find', 'ls'],
  work: ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'],
};

export const MAX_STEPS_KEPT = 40;
export const MAX_OUTPUT_UI = 12_000;
export const MAX_OUTPUT_LLM = 20_000;

export function initialState(title: string, mode: SubagentMode): SubagentState {
  return { title, mode, status: 'queued', steps: [], toolCount: 0, output: '', error: null, startedAt: null, endedAt: null, tokens: 0 };
}

/** Résumé d'un appel d'outil sur une ligne (commande, chemin, motif…). */
export function stepSummary(tool: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const v = a['command'] ?? a['path'] ?? a['file_path'] ?? a['pattern'] ?? a['query'] ?? a['url'] ?? '';
  const s = String(v).split('\n')[0].trim();
  return (s.length > 160 ? `${s.slice(0, 160)}…` : s) || tool;
}

/** Texte d'un message d'assistant (blocs `text`). */
function assistantText(message: unknown): string {
  const m = message as { role?: string; content?: unknown } | null;
  if (!m || m.role !== 'assistant') return '';
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content
    .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Applique une ligne du flux JSON de Pi à l'état. Renvoie `true` si l'état a changé (à
 * transmettre à l'interface).
 */
export function applyEvent(state: SubagentState, line: string): boolean {
  if (!line.trim()) return false;
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return false;
  }
  switch (e['type']) {
    case 'tool_execution_start': {
      const tool = String(e['toolName'] ?? '?');
      state.steps.push({ tool, summary: stepSummary(tool, e['args']), status: 'running' });
      if (state.steps.length > MAX_STEPS_KEPT) state.steps.splice(0, state.steps.length - MAX_STEPS_KEPT);
      state.toolCount++;
      return true;
    }
    case 'tool_execution_end': {
      const tool = String(e['toolName'] ?? '?');
      for (let i = state.steps.length - 1; i >= 0; i--) {
        if (state.steps[i].tool === tool && state.steps[i].status === 'running') {
          state.steps[i].status = e['isError'] ? 'failed' : 'completed';
          break;
        }
      }
      return true;
    }
    case 'message_end': {
      const msg = e['message'] as { role?: string; usage?: { totalTokens?: number; input?: number; output?: number }; errorMessage?: string; stopReason?: string } | undefined;
      if (msg?.role !== 'assistant') return false;
      const text = assistantText(msg).trim();
      if (text) state.output = text;
      const u = msg.usage;
      if (u) state.tokens = Math.max(state.tokens, u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0));
      if (msg.stopReason === 'error' && msg.errorMessage) state.error = msg.errorMessage;
      return true;
    }
    default:
      return false;
  }
}

/** Fin du processus : statut final. */
export function finish(state: SubagentState, exitCode: number | null, aborted: boolean, stderr: string): void {
  state.endedAt = Date.now();
  for (const s of state.steps) if (s.status === 'running') s.status = aborted ? 'failed' : 'completed';
  if (aborted) state.status = 'aborted';
  else if (exitCode === 0 && !state.error) state.status = 'completed';
  else {
    state.status = 'failed';
    state.error ??= stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) || `code de sortie ${exitCode ?? 'inconnu'}`;
  }
}

/** Copie allégée pour l'interface (sorties tronquées). */
export function forUi(states: SubagentState[]): SubagentDetails {
  return {
    kind: 'subagents',
    agents: states.map((s) => ({ ...s, steps: s.steps.map((x) => ({ ...x })), output: s.output.length > MAX_OUTPUT_UI ? `${s.output.slice(0, MAX_OUTPUT_UI)}…` : s.output })),
  };
}

/** Compte rendu renvoyé à l'agent principal : la sortie de chaque sous-agent. */
export function resultText(states: SubagentState[]): string {
  return states
    .map((s, i) => {
      const head = `## Sous-agent ${i + 1} — ${s.title} (${s.mode === 'explore' ? 'exploration' : 'travail'}, ${s.status}, ${s.toolCount} action${s.toolCount > 1 ? 's' : ''})`;
      const body = s.output ? (s.output.length > MAX_OUTPUT_LLM ? `${s.output.slice(0, MAX_OUTPUT_LLM)}\n[…tronqué]` : s.output) : '(aucune réponse)';
      return `${head}\n\n${body}${s.error ? `\n\nErreur : ${s.error}` : ''}`;
    })
    .join('\n\n');
}

/**
 * Ordre d'exécution : les explorations en parallèle ; les sous-agents qui modifient des fichiers
 * l'un après l'autre (deux écrivains simultanés dans le même dossier se gêneraient).
 */
export function schedule(modes: SubagentMode[]): number[][] {
  const explore = modes.map((m, i) => (m === 'explore' ? i : -1)).filter((i) => i >= 0);
  const work = modes.map((m, i) => (m === 'work' ? i : -1)).filter((i) => i >= 0);
  // Vague 1 : toutes les explorations + le premier travail ; puis un travail par vague.
  const waves: number[][] = [[...explore, ...work.slice(0, 1)]];
  for (const w of work.slice(1)) waves.push([w]);
  return waves.filter((w) => w.length > 0);
}
