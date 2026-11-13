import { hmacSha256, safeEqual } from './crypto.js';

/**
 * Jetons de preview signés (HMAC-SHA256) : courte durée pour l'échange initial,
 * plus longue pour le cookie propre au sous-domaine de preview.
 */
export interface PreviewClaims {
  ws: string;
  port: number;
  uid: string;
  exp: number;
  kind: 'exchange' | 'session';
}

export function signPreviewToken(key: string, claims: PreviewClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${hmacSha256(key, body)}`;
}

export function verifyPreviewToken(key: string, token: string | undefined, kind: PreviewClaims['kind']): PreviewClaims | null {
  if (!token || token.length > 2000) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig || !safeEqual(sig, hmacSha256(key, body))) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PreviewClaims;
    if (c.kind !== kind || typeof c.exp !== 'number' || c.exp < Date.now() / 1000) return null;
    return c;
  } catch {
    return null;
  }
}

/** Sous-domaine : `<port>-<workspaceId sans tirets>`. */
export function previewHost(workspaceId: string, port: number, domain: string): string {
  return `${port}-${workspaceId.replace(/-/g, '')}.${domain}`;
}

export function parsePreviewHost(host: string, domain: string): { workspaceId: string; port: number } | null {
  const h = host.split(':')[0].toLowerCase();
  if (!h.endsWith(`.${domain.toLowerCase()}`)) return null;
  const label = h.slice(0, -(domain.length + 1));
  const m = /^(\d{2,5})-([0-9a-f]{32})$/.exec(label);
  if (!m) return null;
  const id = m[2];
  return { port: Number(m[1]), workspaceId: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}` };
}
