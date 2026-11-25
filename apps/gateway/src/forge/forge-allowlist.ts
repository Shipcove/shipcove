/**
 * Écritures autorisées à l'agent sur les forges (liste blanche, ADR 0013). Toute écriture absente
 * d'ici est refusée : une opération nouvelle ou oubliée de la forge (approbation d'une PR,
 * déclenchement d'un déploiement, réglage) n'est jamais ouverte par défaut.
 *
 * Les chemins sont ceux de `normalizeApiPath` : décodés, en minuscules, sans préfixe d'API.
 */

export interface AllowedWrite {
  methods: string[];
  path: RegExp;
  /** Revue de PR : le champ `event` du corps ne doit pas être une approbation. */
  reviewEvent?: true;
}

const GH_REPO = String.raw`^/repos/[^/]+/[^/]+`;
const gh = (methods: string[], tail: string, extra: Partial<AllowedWrite> = {}): AllowedWrite => ({ methods, path: new RegExp(`${GH_REPO}${tail}$`), ...extra });

export const GITHUB_ALLOWED_WRITES: AllowedWrite[] = [
  // Pull requests : création, édition (titre, description, brouillon, fermeture), relecteurs, mise à jour de branche.
  gh(['POST'], '/pulls'),
  gh(['PATCH'], String.raw`/pulls/\d+`),
  gh(['POST', 'DELETE'], String.raw`/pulls/\d+/requested_reviewers`),
  gh(['PUT'], String.raw`/pulls/\d+/update-branch`),
  // Commentaires de revue et revues sans approbation (corps contrôlé par la passerelle).
  gh(['POST'], String.raw`/pulls/\d+/comments(/\d+/replies)?`),
  gh(['PATCH', 'DELETE'], String.raw`/pulls/comments/\d+`),
  gh(['POST'], String.raw`/pulls/\d+/reviews`, { reviewEvent: true }),
  gh(['POST'], String.raw`/pulls/\d+/reviews/\d+/events`, { reviewEvent: true }),
  gh(['PUT', 'DELETE'], String.raw`/pulls/\d+/reviews/\d+`),
  // Tickets : création, édition, commentaires, étiquettes, assignations.
  gh(['POST'], '/issues'),
  gh(['PATCH'], String.raw`/issues/\d+`),
  gh(['POST'], String.raw`/issues/\d+/comments`),
  gh(['PATCH', 'DELETE'], String.raw`/issues/comments/\d+`),
  gh(['POST', 'PUT', 'DELETE'], String.raw`/issues/\d+/labels(/[^/]+)?`),
  gh(['POST', 'DELETE'], String.raw`/issues/\d+/assignees`),
  // Réactions.
  gh(['POST'], String.raw`/(issues|pulls)(/comments)?/\d+/reactions`),
  gh(['DELETE'], String.raw`/(issues|pulls)(/comments)?/\d+/reactions/\d+`),
  // Objets Git et création de références (leur mise à jour ou suppression reste interdite).
  gh(['POST'], '/git/(blobs|trees|commits|refs)'),
  // CI : relance et annulation (les déploiements protégés restent soumis à leurs relecteurs humains).
  gh(['POST'], String.raw`/actions/runs/\d+/(rerun|rerun-failed-jobs|cancel)`),
  gh(['POST'], String.raw`/actions/jobs/\d+/rerun`),
  gh(['POST'], '/forks'),
  { methods: ['POST'], path: /^\/markdown(\/raw)?$/ },
];

const GL_PROJECT = String.raw`^/projects/[^/]+`;
const gl = (methods: string[], tail: string): AllowedWrite => ({ methods, path: new RegExp(`${GL_PROJECT}${tail}$`) });

export const GITLAB_ALLOWED_WRITES: AllowedWrite[] = [
  gl(['POST'], '/merge_requests'),
  gl(['PUT'], String.raw`/merge_requests/\d+`),
  gl(['POST'], '/issues'),
  gl(['PUT'], String.raw`/issues/\d+`),
  gl(['POST', 'PUT', 'DELETE'], String.raw`/(merge_requests|issues)/\d+/(notes|discussions)(/[^/]+(/notes(/\d+)?)?)?`),
  gl(['POST', 'DELETE'], String.raw`/(merge_requests|issues)/\d+(/notes/\d+)?/award_emoji(/\d+)?`),
  gl(['POST'], String.raw`/(merge_requests|issues)/\d+/(subscribe|unsubscribe|todo)`),
  gl(['POST'], '/repository/branches'),
  gl(['POST'], String.raw`/pipelines/\d+/(retry|cancel)`),
  gl(['POST'], String.raw`/jobs/\d+/(retry|cancel)`),
  gl(['POST'], '/fork'),
  { methods: ['POST'], path: /^\/markdown$/ },
];

/** Mutations GraphQL autorisées (champs de premier niveau d'une opération `mutation`), en minuscules. */
export const GITHUB_ALLOWED_MUTATIONS = new Set(
  [
    'addComment', 'updateIssueComment', 'deleteIssueComment', 'createIssue', 'updateIssue', 'closeIssue', 'reopenIssue',
    'createPullRequest', 'updatePullRequest', 'closePullRequest', 'reopenPullRequest', 'markPullRequestReadyForReview',
    'convertPullRequestToDraft', 'requestReviews', 'addPullRequestReviewThread', 'addPullRequestReviewThreadReply',
    'addPullRequestReviewComment', 'updatePullRequestReviewComment', 'deletePullRequestReviewComment',
    'resolveReviewThread', 'unresolveReviewThread', 'addReaction', 'removeReaction', 'addLabelsToLabelable',
    'removeLabelsFromLabelable', 'addAssigneesToAssignable', 'removeAssigneesFromAssignable', 'updatePullRequestBranch',
  ].map((m) => m.toLowerCase()),
);

export const GITLAB_ALLOWED_MUTATIONS = new Set(
  [
    'createNote', 'updateNote', 'destroyNote', 'createDiffNote', 'createImageDiffNote', 'discussionToggleResolve',
    'createIssue', 'updateIssue', 'issueSetLabels', 'issueSetAssignees', 'mergeRequestCreate', 'mergeRequestUpdate',
    'mergeRequestSetLabels', 'mergeRequestSetAssignees', 'mergeRequestSetReviewers', 'mergeRequestSetDraft',
    'mergeRequestReviewerRereview', 'awardEmojiAdd', 'awardEmojiRemove', 'awardEmojiToggle', 'todoMarkDone',
  ].map((m) => m.toLowerCase()),
);

/** Revue soumise par l'agent : commentaire ou demande de modifications, jamais une approbation. */
export function reviewEventAllowed(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const event = (body as { event?: unknown }).event;
  return event === undefined || event === null || (typeof event === 'string' && ['COMMENT', 'REQUEST_CHANGES', 'PENDING'].includes(event.toUpperCase()));
}

const OPERATION_KEYWORDS = new Set(['query', 'mutation', 'subscription', 'fragment']);

/**
 * Champs de premier niveau des opérations `mutation` d'un document GraphQL (alias résolus).
 * `null` si le document ne peut pas être contrôlé (fragment au premier niveau d'une mutation,
 * syntaxe déséquilibrée) : il est alors refusé.
 */
export function mutationFields(doc: string): string[] | null {
  // Chaînes (blocs à triples guillemets compris) et commentaires retirés : aucun nom de champ ne peut s'y cacher.
  const src = doc
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n\r]*/g, ' ');
  const tokens = src.match(/\.\.\.|[A-Za-z_][A-Za-z0-9_]*|[{}():@$!=[\]]/g) ?? [];
  const fields: string[] = [];
  let depth = 0;
  let parens = 0;
  let opKind: string | null = null;
  let inMutation = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '(') {
      parens++;
      continue;
    }
    if (t === ')') {
      if (--parens < 0) return null;
      continue;
    }
    if (parens > 0) continue; // arguments, variables et leurs valeurs
    if (t === '{') {
      if (depth === 0) inMutation = opKind === 'mutation';
      depth++;
      continue;
    }
    if (t === '}') {
      if (--depth < 0) return null;
      if (depth === 0) {
        inMutation = false;
        opKind = null;
      }
      continue;
    }
    if (depth === 0) {
      if (OPERATION_KEYWORDS.has(t.toLowerCase())) opKind = t.toLowerCase();
      continue;
    }
    if (depth !== 1 || !inMutation) continue;
    if (t === '...') return null; // fragment (en ligne ou nommé) au premier niveau : non contrôlable
    if (t === '@') {
      i++; // nom de la directive
      continue;
    }
    if (!/^[A-Za-z_]/.test(t)) continue;
    if (tokens[i + 1] === ':') {
      // alias: champ
      const field = tokens[i + 2];
      if (!field || !/^[A-Za-z_]/.test(field)) return null;
      fields.push(field);
      i += 2;
    } else {
      fields.push(t);
    }
  }
  if (depth !== 0 || parens !== 0) return null;
  return fields;
}
