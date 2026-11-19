/**
 * Plugin Pi « subagent » — sous-agents au contexte isolé.
 *
 * Outil natif `subagent` : Pi confie de 1 à 4 tâches à des sous-agents. Chacun est un processus
 * `pi --mode json` séparé, dans la même sandbox et le même dossier, avec son propre contexte :
 * l'agent principal ne reçoit que leurs comptes rendus, ce qui économise son contexte.
 *
 * - `explore` : lecture seule (read, grep, find, ls) ; plusieurs en parallèle.
 * - `work` : peut modifier des fichiers et lancer des commandes ; un seul à la fois.
 *
 * Les sous-agents passent par la même gateway que Pi (mêmes quotas, même jeton de run) et ne
 * chargent aucune extension de la plateforme : ni outils de plateforme, ni sous-agents à leur tour.
 * En mode Plan (`CAP_SUBAGENT_READONLY=1`), seuls les explorateurs sont autorisés.
 * La progression (statut, étapes) est transmise à l'interface par les mises à jour de l'outil.
 */
import { spawn } from 'node:child_process';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import { applyEvent, finish, forUi, initialState, resultText, schedule, TOOLS, type SubagentMode, type SubagentState } from './subagent-core.js';

const TIMEOUT_MS = 20 * 60_000;
const UPDATE_EVERY_MS = 300;

const SUBAGENT_PROMPT =
  'Tu es un sous-agent lancé par l’agent principal pour une tâche précise. Tu ne parles pas à l’utilisateur : ' +
  'ta dernière réponse est transmise telle quelle à l’agent principal. Travaille de façon autonome, sans poser de question. ' +
  'Termine par un compte rendu factuel et concis : ce que tu as trouvé ou fait, les fichiers concernés (chemins exacts), ' +
  'les points d’attention. Pas de formule de politesse.';

const Task = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 80, description: 'Titre court affiché à l’utilisateur (« Cartographier l’API »)' }),
  prompt: Type.String({ minLength: 1, maxLength: 20_000, description: 'Consigne complète et autonome : le sous-agent ne voit pas la conversation' }),
  mode: Type.Optional(Type.Union([Type.Literal('explore'), Type.Literal('work')], { description: 'explore (défaut) : lecture seule ; work : peut modifier des fichiers et lancer des commandes' })),
});

export default function subagentPlugin(pi: ExtensionAPI) {
  // Un sous-agent ne lance pas de sous-agent (pas de récursion).
  if (process.env.CAP_SUBAGENT_DEPTH) return;
  const readOnly = process.env.CAP_SUBAGENT_READONLY === '1';

  pi.registerTool({
    name: 'subagent',
    label: 'Sous-agents',
    description:
      'Delegates 1 to 4 tasks to sub-agents with their own isolated context. Each one works in the same workspace and returns a written report; ' +
      'only the reports come back to you, which saves your context. Mode "explore" (default) is read-only and runs in parallel; ' +
      `mode "work" can edit files and run commands, one at a time.${readOnly ? ' In the current Plan mode, only "explore" is allowed.' : ''}`,
    promptSnippet: 'Déléguer des recherches ou des sous-tâches à des sous-agents au contexte isolé',
    promptGuidelines: [
      'Use subagent for broad exploration of a large codebase (finding where something is implemented, mapping a module, reviewing many files) or for independent sub-tasks; give each sub-agent a complete, self-contained prompt with the exact goal and the expected report.',
      'Prefer several "explore" sub-agents in parallel for independent questions. Use "work" only for a well-delimited change; you remain responsible for checking its result.',
      'Do not use subagent for simple tasks you can do in a few tool calls yourself.',
    ],
    parameters: Type.Object({
      tasks: Type.Array(Task, { minItems: 1, maxItems: 4, description: 'Tâches confiées, une par sous-agent' }),
    }),
    async execute(_id, p, signal, onUpdate, ctx) {
      // Même modèle que l'agent principal (choisi par la plateforme via RPC, pas en ligne de commande).
      const model = ctx?.model ? ['--provider', ctx.model.provider, '--model', ctx.model.id] : [];
      const modes: SubagentMode[] = p.tasks.map((t) => (readOnly ? 'explore' : (t.mode ?? 'explore')));
      const states: SubagentState[] = p.tasks.map((t, i) => initialState(t.title, modes[i]));
      let last = 0;
      let pending: ReturnType<typeof setTimeout> | null = null;
      const push = (force = false) => {
        if (!onUpdate) return;
        const send = () => {
          last = Date.now();
          pending = null;
          const running = states.filter((s) => s.status === 'running').length;
          const done = states.filter((s) => ['completed', 'failed', 'aborted'].includes(s.status)).length;
          onUpdate({ content: [{ type: 'text' as const, text: `Sous-agents : ${done}/${states.length} terminé(s), ${running} en cours` }], details: forUi(states) });
        };
        if (force || Date.now() - last >= UPDATE_EVERY_MS) send();
        else pending ??= setTimeout(send, UPDATE_EVERY_MS);
      };

      for (const wave of schedule(modes)) {
        if (signal?.aborted) break;
        await Promise.all(wave.map((i) => runOne(states[i], p.tasks[i].prompt, model, signal, push)));
      }
      if (pending) clearTimeout(pending);
      for (const s of states) if (s.status === 'queued') finish(s, null, true, '');
      push(true);
      return { content: [{ type: 'text' as const, text: resultText(states) }], details: forUi(states) };
    },
  });
}

/** Lance un sous-agent et suit son flux d'événements jusqu'à la fin. */
function runOne(state: SubagentState, prompt: string, model: string[], signal: AbortSignal | undefined, push: (force?: boolean) => void): Promise<void> {
  return new Promise((resolve) => {
    state.status = 'running';
    state.startedAt = Date.now();
    push(true);
    const args = ['--mode', 'json', '-p', '--no-session', ...model, '--tools', TOOLS[state.mode].join(','), '--append-system-prompt', SUBAGENT_PROMPT, `Task: ${prompt}`];
    const proc = spawn('pi', args, {
      cwd: process.cwd(),
      env: { ...process.env, CAP_SUBAGENT_DEPTH: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buffer = '';
    let stderr = '';
    let aborted = false;
    const kill = () => {
      aborted = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => {
      state.error = 'délai dépassé (20 min)';
      kill();
    }, TIMEOUT_MS);
    if (signal?.aborted) kill();
    else signal?.addEventListener('abort', kill, { once: true });

    proc.stdout.on('data', (d: Buffer) => {
      buffer += d.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const l of lines) if (applyEvent(state, l)) push();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-4000);
    });
    let ended = false;
    const done = (code: number | null) => {
      // `error` puis `close` peuvent se suivre : une seule fin.
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      if (buffer.trim()) applyEvent(state, buffer);
      // Délai dépassé : échec, pas une interruption par l'utilisateur.
      finish(state, code, aborted && !state.error, stderr);
      if (state.error === 'délai dépassé (20 min)') state.status = 'failed';
      push(true);
      resolve();
    };
    proc.on('close', done);
    proc.on('error', (err) => {
      state.error = `lancement impossible : ${err.message}`;
      done(1);
    });
  });
}
