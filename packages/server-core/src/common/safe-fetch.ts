/**
 * `fetch` sans redirection vers un autre domaine.
 *
 * Un serveur distant (forge, proxy LLM) ne doit pas pouvoir rediriger une requête de la plateforme
 * vers un service interne (Vault, base de données, métadonnées du cloud) : c'est une SSRF, d'autant
 * plus grave quand la réponse est renvoyée à une sandbox. Les redirections vers le **même** origine
 * (schéma, hôte et port identiques) restent suivies, car les forges s'en servent légitimement (dépôt
 * renommé sur GitHub, par exemple). Une requête avec un corps n'est jamais redirigée.
 */
export class RedirectRefusedError extends Error {
  constructor(readonly from: string, readonly to: string | null) {
    super(`Redirection refusée : ${new URL(from).origin} → ${to ? safeOrigin(to) : '(sans destination)'}`);
  }
}

const MAX_REDIRECTS = 5;

export async function fetchSameOrigin(url: string, init: RequestInit = {}): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400 || res.status === 304) return res;
    const location = res.headers.get('location');
    const next = location ? new URL(location, current).href : null;
    await res.body?.cancel().catch(() => undefined);
    if (!next || init.body !== undefined || hop >= MAX_REDIRECTS || new URL(next).origin !== new URL(current).origin) {
      throw new RedirectRefusedError(current, next);
    }
    current = next;
  }
}

function safeOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return '(adresse invalide)';
  }
}
