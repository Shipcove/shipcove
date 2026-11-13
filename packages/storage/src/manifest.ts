/** Manifeste versionné d'un checkpoint (ADR 0006). */
export const MANIFEST_VERSION = 1;

export interface ManifestEntry {
  /** Chemin absolu dans la sandbox (`/workspace/...` ou `/workspace-state/...`). */
  p: string;
  t: 'f' | 'd' | 'l';
  m: number;
  s: number;
  mt: number;
  h?: string;
  l?: string;
}

export interface Manifest {
  version: typeof MANIFEST_VERSION;
  workspaceId: string;
  generation: number;
  parentGeneration: number | null;
  createdAt: string;
  roots: string[];
  entries: ManifestEntry[];
}

export const ROOTS = ['/workspace', '/workspace-state'] as const;

export interface ManifestChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  type: 'f' | 'd' | 'l';
  oldHash?: string;
  newHash?: string;
}

/** Différences de contenu entre deux manifestes (fichiers et liens ; dossiers ignorés). */
export function diffManifests(before: ManifestEntry[] | null, after: ManifestEntry[]): ManifestChange[] {
  const a = new Map((before ?? []).filter((e) => e.t !== 'd').map((e) => [e.p, e]));
  const b = new Map(after.filter((e) => e.t !== 'd').map((e) => [e.p, e]));
  const out: ManifestChange[] = [];
  for (const [p, e] of b) {
    const old = a.get(p);
    if (!old) out.push({ path: p, status: 'added', type: e.t, newHash: e.h });
    else if (old.t !== e.t || old.h !== e.h || old.l !== e.l || old.m !== e.m) out.push({ path: p, status: 'modified', type: e.t, oldHash: old.h, newHash: e.h });
  }
  for (const [p, e] of a) if (!b.has(p)) out.push({ path: p, status: 'deleted', type: e.t, oldHash: e.h });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

/** Égalité stricte (contenu + structure) : aucun nouveau checkpoint nécessaire. */
export function sameTree(before: ManifestEntry[] | null, after: ManifestEntry[]): boolean {
  if (!before || before.length !== after.length) return false;
  const a = new Map(before.map((e) => [e.p, e]));
  return after.every((e) => {
    const o = a.get(e.p);
    return o && o.t === e.t && o.h === e.h && o.l === e.l && o.m === e.m;
  });
}

/** Chemin de sandbox → chemin relatif présenté aux utilisateurs (racine `/workspace`). */
export function toUserPath(p: string): string | null {
  if (p === '/workspace') return '';
  if (p.startsWith('/workspace/')) return p.slice('/workspace/'.length);
  return null;
}

export function fromUserPath(rel: string): string {
  const clean = rel.replace(/^\/+/, '');
  if (clean.split('/').some((seg) => seg === '..' || seg === '.')) throw new Error('Chemin invalide');
  return clean ? `/workspace/${clean}` : '/workspace';
}
