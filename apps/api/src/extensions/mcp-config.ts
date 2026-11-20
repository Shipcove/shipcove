/**
 * Configuration des serveurs MCP : séparation des en-têtes publics et secrets, fusion des secrets
 * lors d'une modification, règles d'une sélection d'outils. Fonctions pures (testées à part).
 */
import type { McpScope } from '@cap/contracts';

/** En-têtes considérés comme secrets même non cochés (stockés dans Vault, jamais renvoyés). */
export const SENSITIVE_HEADER = /auth|token|key|secret|pass|pwd|cookie|credential|session|signature/i;

/** Sépare les en-têtes publics des secrets (cochés dans le formulaire, ou au nom sensible). */
export function splitHeaders(headers: Record<string, string>, secretHeaders: Record<string, string>) {
  const secret: Record<string, string> = {};
  const pub: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) (SENSITIVE_HEADER.test(k) ? secret : pub)[k] = v;
  for (const [k, v] of Object.entries(secretHeaders)) secret[k] = v;
  for (const k of Object.keys(secret)) delete pub[k];
  return { pub, secret };
}

/**
 * Secrets après modification : ceux qui sont retirés disparaissent, les nouveaux remplacent les
 * anciens, les autres sont conservés. Un en-tête redevenu public ne reste pas aussi en secret.
 */
export function mergeSecrets(
  stored: Record<string, string>,
  change: { publicHeaders: Record<string, string>; secretHeaders: Record<string, string>; remove: string[] },
): Record<string, string> {
  const next: Record<string, string> = { ...stored };
  for (const k of change.remove) delete next[k];
  for (const k of Object.keys(change.publicHeaders)) delete next[`header:${k}`];
  for (const [k, v] of Object.entries(change.secretHeaders)) next[`header:${k}`] = v;
  return next;
}

/** Règles d'une sélection : un refus par outil décoché (jamais de liste blanche). */
export function selectionRules(serverId: string, scope: McpScope, subjectId: string | null, denied: string[]) {
  return [...new Set(denied)].filter((n) => n !== '*').map((toolName) => ({ serverId, toolName, scope, subjectId, effect: 'deny' as const }));
}
