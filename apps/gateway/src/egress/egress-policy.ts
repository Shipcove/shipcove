import { isIP } from 'node:net';

/** Forges dont l'accès direct depuis une sandbox est toujours interdit (ADR 0007). */
export const ALWAYS_DENIED_HOSTS = [
  'github.com',
  'api.github.com',
  'uploads.github.com',
  'gist.github.com',
  'codeload.github.com',
  'gitlab.com',
  'registry.gitlab.com',
];

export interface EgressDecision {
  allowed: boolean;
  reason: string;
}

const norm = (h: string) => h.toLowerCase().replace(/\.$/, '');

/** `*.example.com` ou `.example.com` couvrent les sous-domaines ; sinon correspondance exacte. */
export function hostMatches(host: string, pattern: string): boolean {
  const h = norm(host);
  const p = norm(pattern);
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  if (p.startsWith('.')) return h === p.slice(1) || h.endsWith(p);
  return h === p;
}

export function decideHost(host: string, port: number, allowlist: string[], deniedHosts: string[]): EgressDecision {
  const h = norm(host);
  if (![80, 443].includes(port)) return { allowed: false, reason: `port ${port} non autorisé` };
  if (isIP(h)) return { allowed: false, reason: 'adresse IP directe interdite' };
  for (const d of [...ALWAYS_DENIED_HOSTS, ...deniedHosts]) {
    if (hostMatches(h, d) || hostMatches(h, `*.${norm(d)}`)) {
      return { allowed: false, reason: `forge Git ${d} : publication uniquement via approbation (outil platform_git_push)` };
    }
  }
  if (allowlist.some((a) => hostMatches(h, a))) return { allowed: true, reason: 'liste blanche' };
  return { allowed: false, reason: 'domaine hors liste blanche (configurable par l’administrateur)' };
}

/** Adresses internes interdites (anti-SSRF) : privées, loopback, link-local, métadonnées, CGNAT, ULA. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return false;
}
