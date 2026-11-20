import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/**
 * Proxys de confiance pour `X-Forwarded-For` (réglage `TRUST_PROXY`), liste séparée par des virgules :
 * - mots-clés d'Express : `loopback`, `linklocal`, `uniquelocal` (ce dernier = tout réseau privé :
 *   n'importe quel conteneur interne peut alors usurper l'adresse IP du client) ;
 * - adresses ou plages : `10.0.0.5`, `172.18.0.0/16`, `fd00::/8` ;
 * - noms d'hôte : `web`, `edge` (services Compose), résolus au démarrage puis toutes les 30 s
 *   (l'adresse d'un conteneur change à sa recréation).
 *
 * Renvoie la fonction attendue par `app.set('trust proxy', …)` et une fonction d'arrêt.
 */
export function trustProxy(spec: string, opts: { refreshMs?: number; resolve?: (host: string) => Promise<string[]> } = {}) {
  const fixed = new BlockList();
  const hosts: string[] = [];
  for (const raw of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const entry = raw.toLowerCase();
    if (entry === 'loopback') {
      fixed.addSubnet('127.0.0.0', 8, 'ipv4');
      fixed.addAddress('::1', 'ipv6');
    } else if (entry === 'linklocal') {
      fixed.addSubnet('169.254.0.0', 16, 'ipv4');
      fixed.addSubnet('fe80::', 10, 'ipv6');
    } else if (entry === 'uniquelocal') {
      fixed.addSubnet('10.0.0.0', 8, 'ipv4');
      fixed.addSubnet('172.16.0.0', 12, 'ipv4');
      fixed.addSubnet('192.168.0.0', 16, 'ipv4');
      fixed.addSubnet('fc00::', 7, 'ipv6');
    } else if (entry.includes('/')) {
      const [ip, bits] = entry.split('/');
      const v = isIP(ip);
      if (!v || !/^\d+$/.test(bits)) throw new Error(`TRUST_PROXY : plage invalide « ${raw} »`);
      fixed.addSubnet(ip, Number(bits), v === 6 ? 'ipv6' : 'ipv4');
    } else if (isIP(entry)) fixed.addAddress(entry, isIP(entry) === 6 ? 'ipv6' : 'ipv4');
    else if (/^[a-z0-9.-]+$/.test(entry)) hosts.push(entry);
    else throw new Error(`TRUST_PROXY : entrée invalide « ${raw} »`);
  }

  const resolve = opts.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address));
  let resolved = new Set<string>();
  const refresh = async () => {
    const next = new Set<string>();
    for (const h of hosts) for (const a of await resolve(h).catch(() => [] as string[])) next.add(normalize(a));
    resolved = next;
  };
  const timer = hosts.length ? setInterval(() => void refresh(), opts.refreshMs ?? 30_000) : null;
  timer?.unref();
  const ready = hosts.length ? refresh() : Promise.resolve();

  const trust = (addr: string): boolean => {
    const a = normalize(addr);
    const v = isIP(a);
    if (!v) return false;
    return resolved.has(a) || fixed.check(a, v === 6 ? 'ipv6' : 'ipv4');
  };
  return { trust, ready, stop: () => timer && clearInterval(timer) };
}

/** `::ffff:10.0.0.1` (IPv4 vue par une socket IPv6) → `10.0.0.1`. */
function normalize(addr: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return (m ? m[1] : addr).toLowerCase();
}
