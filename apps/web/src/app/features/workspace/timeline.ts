import type { MessageDto, ToolCallDto, ToolImageDto } from '@cap/contracts';

/** Étape intermédiaire de Pi : raisonnement ou appel d'outil. */
export type Step = { kind: 'thinking'; key: string; text: string } | { kind: 'tool'; key: string; call: ToolCallDto };

/** Ligne du fil de conversation, dans l'ordre d'affichage. */
export type TimelineRow =
  | { kind: 'message'; key: string; m: MessageDto }
  | { kind: 'text'; key: string; m: MessageDto }
  /** Étapes consécutives (raisonnement, commandes) sans texte du modèle entre elles. */
  | { kind: 'steps'; key: string; steps: Step[] }
  /** Captures d'écran prises pendant le groupe d'étapes précédent : toujours visibles, sous lui. */
  | { kind: 'images'; key: string; images: ToolImageDto[] }
  /** Appel d'outil à garder visible (questions, fichiers, approbations Git) : jamais replié dans un groupe. */
  | { kind: 'interactive'; key: string; call: ToolCallDto }
  | { kind: 'error'; key: string; m: MessageDto };

/** Outils affichés hors des groupes d'étapes : l'utilisateur doit les voir sans rien déplier (formulaires, fichiers, approbations Git). */
const STANDALONE_TOOLS = new Set(['ask_user', 'share_files', 'platform_git_push', 'platform_create_pull_request', 'platform_merge_pull_request', 'platform_delete_remote_branch']);

/**
 * Aplati les messages en lignes et regroupe les raisonnements et appels d'outils consécutifs.
 * Un message texte du modèle, un message utilisateur ou système, un formulaire interactif ou
 * une erreur ferment le groupe courant. Au sein d'un message assistant, l'ordre est celui de
 * l'affichage : raisonnement, texte, puis appels d'outils.
 *
 * La clé d'un groupe est celle de sa première étape : elle reste stable pendant le streaming
 * (les nouvelles étapes s'ajoutent au groupe courant), ce qui préserve son état déplié.
 */
export function buildTimeline(messages: MessageDto[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let group: Step[] | null = null;
  const close = () => {
    if (group?.length) {
      rows.push({ kind: 'steps', key: `steps:${group[0].key}`, steps: group });
      // Captures hors du dépliant : l'utilisateur les voit sans ouvrir le groupe.
      const images = group.flatMap((s) => (s.kind === 'tool' ? (s.call.images ?? []) : []));
      if (images.length) rows.push({ kind: 'images', key: `images:${group[0].key}`, images });
    }
    group = null;
  };
  const push = (s: Step) => (group ??= []).push(s);

  for (const m of messages) {
    if (m.role !== 'assistant') {
      close();
      rows.push({ kind: 'message', key: m.id, m });
      continue;
    }
    if (m.thinking) push({ kind: 'thinking', key: `${m.id}:thinking`, text: m.thinking });
    if (m.text) {
      close();
      rows.push({ kind: 'text', key: `${m.id}:text`, m });
    }
    for (const call of m.toolCalls) {
      if (STANDALONE_TOOLS.has(call.toolName)) {
        close();
        rows.push({ kind: 'interactive', key: call.id, call });
      } else {
        push({ kind: 'tool', key: call.id, call });
      }
    }
    if (m.stopReason === 'error') {
      close();
      rows.push({ kind: 'error', key: `${m.id}:error`, m });
    }
  }
  close();
  return rows;
}

/** Résumé d'un groupe d'étapes (affiché replié). */
export function summarizeSteps(steps: Step[]): { thinking: number; tools: number; failed: number; running: boolean; last: Step } {
  let thinking = 0;
  let tools = 0;
  let failed = 0;
  let running = false;
  for (const s of steps) {
    if (s.kind === 'thinking') thinking++;
    else {
      tools++;
      if (s.call.status === 'failed' || s.call.isError) failed++;
      if (s.call.status === 'running') running = true;
    }
  }
  return { thinking, tools, failed, running, last: steps[steps.length - 1] };
}
