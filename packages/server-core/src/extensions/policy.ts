/**
 * Évaluation des politiques skills / MCP (SPEC §14–§15).
 * Portées : global > équipe > personnel. Une règle `deny` d'une portée supérieure ne peut jamais
 * être contournée par une portée inférieure ; une portée inférieure peut seulement restreindre.
 */
export type Scope = 'global' | 'team' | 'personal';

export interface PermissionRule {
  serverId: string;
  toolName: string; // '*' = tous les outils du serveur
  scope: Scope;
  subjectId: string | null;
  effect: 'allow' | 'deny';
}

export interface Subject {
  userId: string;
  teamId: string;
}

const RANK: Record<Scope, number> = { global: 0, team: 1, personal: 2 };

function applies(rule: PermissionRule, subject: Subject): boolean {
  if (rule.scope === 'global') return true;
  if (rule.scope === 'team') return rule.subjectId === subject.teamId;
  return rule.subjectId === subject.userId;
}

/**
 * Résultat effectif pour un outil :
 * - un `deny` applicable à n'importe quelle portée → refusé ;
 * - sinon, si une portée a défini des `allow` explicites pour ce serveur (mode liste blanche),
 *   l'outil doit figurer dans la liste de la portée la plus haute qui en définit ;
 * - sinon autorisé.
 */
export function effectiveToolPermission(serverId: string, toolName: string, rules: PermissionRule[], subject: Subject): 'allowed' | 'denied' {
  const relevant = rules.filter((r) => r.serverId === serverId && applies(r, subject));
  if (relevant.some((r) => r.effect === 'deny' && (r.toolName === '*' || r.toolName === toolName))) return 'denied';
  const allows = relevant.filter((r) => r.effect === 'allow').sort((a, b) => RANK[a.scope] - RANK[b.scope]);
  if (allows.length === 0) return 'allowed';
  const topScope = allows[0].scope;
  const top = allows.filter((r) => r.scope === topScope);
  return top.some((r) => r.toolName === '*' || r.toolName === toolName) ? 'allowed' : 'denied';
}

/** Un serveur / skill d'une portée est-il visible pour ce sujet ? */
export function scopeVisible(scope: Scope, teamId: string | null, ownerId: string | null, subject: Subject): boolean {
  if (scope === 'global') return true;
  if (scope === 'team') return teamId === subject.teamId;
  return ownerId === subject.userId;
}
