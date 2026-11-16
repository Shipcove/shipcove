/**
 * Dépôt désigné par l'URL d'un remote Git : `https://hôte/chemin(.git)`, `ssh://git@hôte/chemin`
 * ou `git@hôte:chemin`. Renvoie l'hôte (minuscules, port éventuel) et le chemin complet
 * (`owner/name`, ou `groupe/sous-groupe/projet` sur GitLab), sans identifiants.
 * `null` pour un chemin local ou une URL non reconnue.
 */
export function parseRemoteUrl(url: string): { host: string; fullName: string } | null {
  const raw = url.trim();
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)([^\s]+)$/.exec(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return null;
    host = u.host;
    path = decodeURIComponent(u.pathname);
  } else if (scp) {
    [, host, path] = scp;
  } else {
    return null;
  }
  const fullName = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!host || !/^[^/]+(\/[^/]+)+$/.test(fullName) || fullName.split('/').some((s) => s === '.' || s === '..')) return null;
  return { host: host.toLowerCase(), fullName };
}
