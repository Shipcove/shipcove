/**
 * Hooks Git globaux de la sandbox (`core.hooksPath` dans ~/.gitconfig, écrit par la plateforme) :
 * - `commit-msg` ajoute la mention de co-auteur de la plateforme à chaque commit ;
 * - chaque hook relaie ensuite vers le hook du dépôt (`.git/hooks/<nom>`), qu'un `core.hooksPath`
 *   global masquerait sinon (pre-commit, commit-msg de commitlint…).
 *
 * Un dépôt qui fixe son propre `core.hooksPath` (husky…) l'emporte sur ce réglage global : la
 * consigne donnée à Pi (`coAuthorPrompt`) couvre ce cas, `addIfDifferent` évite les doublons.
 */
export const GIT_HOOKS_DIR = '/home/agent/.cap/git-hooks';

/** Hooks côté client relayés vers ceux du dépôt. */
export const RELAYED_HOOKS = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'post-rewrite',
  'pre-auto-gc',
] as const;

/** Mention ajoutée aux commits ; `null` si la plateforme n'en ajoute pas (adresse vide). */
export function coAuthorTrailer(email: string): string | null {
  const e = email.trim();
  return e ? `Co-Authored-By: Shipcove <${e}>` : null;
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Script commun à tous les hooks (le nom du hook est celui du fichier). */
export function hookScript(trailer: string | null): string {
  return [
    '#!/bin/sh',
    '# Hook de la plateforme Shipcove : mention de co-auteur, puis hook du dépôt.',
    'hook=$(basename "$0")',
    ...(trailer
      ? [
          'if [ "$hook" = commit-msg ] && [ -n "$1" ]; then',
          `  git interpret-trailers --in-place --if-exists addIfDifferent --trailer ${shQuote(trailer)} "$1" || true`,
          'fi',
        ]
      : []),
    'repo_hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/$hook"',
    'if [ -x "$repo_hook" ]; then exec "$repo_hook" "$@"; fi',
    'exit 0',
    '',
  ].join('\n');
}

/** Fichiers à écrire dans la sandbox (chemins relatifs à `/`). */
export function gitHookFiles(trailer: string | null): Array<{ path: string; content: string; mode: number }> {
  const script = hookScript(trailer);
  return RELAYED_HOOKS.map((h) => ({ path: `${GIT_HOOKS_DIR.slice(1)}/${h}`, content: script, mode: 0o755 }));
}

/** Consigne pour Pi : couvre les dépôts dont les hooks remplacent ceux de la plateforme. */
export function coAuthorPrompt(trailer: string | null): string | null {
  return trailer ? `Every git commit message you write must end with this trailer, on its own line after a blank line: ${trailer}` : null;
}
