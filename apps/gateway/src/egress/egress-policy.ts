import { BlockList, isIP } from 'node:net';

/**
 * Hôtes de forges jamais joignables en direct. Les forges utilisables (github.com, api.github.com,
 * gitlab.com, forges déclarées) sont interceptées en amont par le proxy des forges (ADR 0013).
 */
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
      return { allowed: false, reason: 'forge Git : accès direct non pris en charge (git, gh et glab passent par le proxy des forges)' };
    }
  }
  if (allowlist.some((a) => hostMatches(h, a))) return { allowed: true, reason: 'liste blanche' };
  return { allowed: false, reason: 'domaine hors liste blanche (configurable par l’administrateur)' };
}

/**
 * Adresses internes interdites (anti-SSRF) : privées, loopback, link-local, métadonnées, CGNAT,
 * multicast et réservées. En IPv6, toutes les écritures d'une adresse IPv4 (`::ffff:a.b.c.d`,
 * `::ffff:7f00:1`, NAT64 `64:ff9b::/96`, compatibilité `::/96`) sont refusées par principe.
 */
// Deux listes : Node ferait correspondre toute IPv4 à la règle IPv6 `::ffff:0:0/96`.
const PRIVATE_V4 = new BlockList();
const PRIVATE_V6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) PRIVATE_V4.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32],
] as const) PRIVATE_V6.addSubnet(net, prefix, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return PRIVATE_V4.check(ip, 'ipv4');
  if (family === 6) return PRIVATE_V6.check(ip, 'ipv6');
  return true; // pas une adresse : refus
}
