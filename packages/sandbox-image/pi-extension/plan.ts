/**
 * Plugin Pi « plan » — liste de tâches d'une tâche complexe.
 *
 * Outil natif `update_plan` : Pi envoie la liste COMPLÈTE des tâches avec leur statut (à faire, en
 * cours, terminée) à chaque mise à jour. La plateforme affiche le dernier plan dans le volet « Plan »
 * de la conversation (tâche en cours signalée, tâches terminées barrées). Aucun état côté plugin :
 * le plan est l'argument du dernier appel.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';

const Item = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 300, description: 'Tâche, formulée à l’impératif (« Ajouter la route /health »)' }),
  status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')], {
    description: 'pending : à faire ; in_progress : en cours (une seule à la fois) ; completed : terminée',
  }),
});

export default function planPlugin(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'update_plan',
    label: 'Plan',
    description:
      'Creates or updates the task plan shown to the user in the conversation’s Plan panel. Always send the FULL list of tasks with their status ' +
      '(pending, in_progress, completed); it replaces the previous plan.',
    promptSnippet: 'Afficher et tenir à jour le plan d’une tâche complexe (volet « Plan »)',
    promptGuidelines: [
      'For a complex task (3 or more distinct steps, or several files or components to change), call update_plan BEFORE starting, with concrete, verifiable tasks. Skip it for simple or single-step requests and for questions.',
      'Keep exactly one task in_progress while you work. Mark a task completed as soon as it is actually done (not before its checks pass), then set the next one in_progress, calling update_plan each time.',
      'If the scope changes, update the plan: add, reword or remove tasks. Before ending your answer, make sure the plan reflects what was actually done.',
    ],
    parameters: Type.Object({
      items: Type.Array(Item, { minItems: 1, maxItems: 30, description: 'Toutes les tâches, dans l’ordre' }),
    }),
    async execute(_id, p) {
      const done = p.items.filter((i) => i.status === 'completed').length;
      const current = p.items.find((i) => i.status === 'in_progress');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Plan mis à jour : ${done}/${p.items.length} tâche${p.items.length > 1 ? 's' : ''} terminée${done > 1 ? 's' : ''}${current ? ` ; en cours : ${current.content}` : ''}.`,
          },
        ],
        details: { total: p.items.length, done },
      };
    },
  });
}
