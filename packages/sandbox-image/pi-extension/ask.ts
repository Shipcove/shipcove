/**
 * Plugin Pi « ask » — questions à l'utilisateur.
 *
 * Outil natif `ask_user` : Pi pose une à six questions à choix (unique ou multiple, avec réponse
 * libre « Autre ») quand une décision lui revient vraiment. La plateforme affiche un formulaire
 * dans la conversation ; la validation de l'utilisateur arrive comme son message suivant.
 * L'outil ne bloque pas : Pi termine son tour, la sandbox peut se mettre en veille entre-temps.
 */
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';

const Option = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 120, description: 'Réponse proposée, courte (1 à 6 mots)' }),
  description: Type.Optional(Type.String({ maxLength: 300, description: 'Ce que ce choix implique' })),
});

const Question = Type.Object({
  question: Type.String({ minLength: 3, maxLength: 500, description: 'La question, complète et autonome, terminée par « ? »' }),
  options: Type.Array(Option, { minItems: 2, maxItems: 6, description: 'Choix possibles (une réponse libre « Autre » est toujours ajoutée)' }),
  multi_select: Type.Optional(Type.Boolean({ description: 'Plusieurs réponses possibles' })),
  recommended: Type.Optional(Type.Number({ description: 'Index (à partir de 0) de l’option recommandée, le cas échéant' })),
});

export default function askPlugin(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'ask_user',
    label: 'Questions',
    description:
      'Asks the user one to six multiple-choice questions, shown as a form in the conversation (single or multiple choice; a free-text "Other" answer is always available). ' +
      'The answers arrive in the user’s next message. After calling this tool, end your turn immediately: do not continue working or guess the answers.',
    promptSnippet: 'Poser des questions à choix à l’utilisateur (formulaire dans la conversation)',
    promptGuidelines: [
      'Use ask_user only when a decision genuinely belongs to the user and changes what you do next (requirements, scope, trade-offs, irreversible choices). Do not ask about things you can find in the code or decide with a sensible default.',
      'Group related questions in a single ask_user call (up to 6). Write each question so it stands on its own, with 2 to 6 concrete options; put the recommended option first and set `recommended` when you have a recommendation.',
      'After ask_user, stop: end your turn with at most one short sentence. Continue only when the user’s answers arrive.',
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String({ maxLength: 120, description: 'Titre court du formulaire (ex. « Cadrage du projet »)' })),
      questions: Type.Array(Question, { minItems: 1, maxItems: 6 }),
    }),
    async execute(_id, p) {
      const n = p.questions.length;
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${n} question${n > 1 ? 's' : ''} affichée${n > 1 ? 's' : ''} à l’utilisateur. ` +
              'Arrête-toi maintenant : termine ton tour sans autre action. Ses réponses arriveront dans son prochain message.',
          },
        ],
        details: { questions: n },
      };
    },
  });
}
