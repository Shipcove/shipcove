import type { FileChangeDto } from '@cap/contracts';

/** Au-delà, les lignes ajoutées / supprimées ne sont pas comptées (fichiers listés quand même). */
export const LINE_STATS_MAX_FILES = 2000;
/** Lectures simultanées dans le stockage objet pendant le comptage. */
export const LINE_STATS_CONCURRENCY = 16;

export type LineStats = { additions: number; deletions: number; binary: boolean };

export interface ChangeEntry {
  path: string;
  status: FileChangeDto['status'];
  oldHash?: string | null;
  newHash?: string | null;
}

/** `fn` appliquée à chaque élément, au plus `limit` à la fois ; ordre des résultats conservé. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Liste des fichiers modifiés avec leurs statistiques de lignes. Les `LINE_STATS_MAX_FILES`
 * premiers sont comptés (lectures parallèles bornées) ; les suivants, ou ceux dont la lecture a
 * échoué, sont marqués `statsSkipped`. `complete` est faux si une lecture a échoué : la réponse
 * ne doit alors pas être mise en cache (erreur passagère du stockage).
 */
export async function buildChangeList(
  changes: readonly ChangeEntry[],
  stats: (c: ChangeEntry) => Promise<LineStats>,
  opts: { maxFiles?: number; concurrency?: number } = {},
): Promise<{ files: FileChangeDto[]; complete: boolean }> {
  const max = opts.maxFiles ?? LINE_STATS_MAX_FILES;
  let complete = true;
  const files = await mapLimit(changes, opts.concurrency ?? LINE_STATS_CONCURRENCY, async (c, i): Promise<FileChangeDto> => {
    const skipped = { path: c.path, status: c.status, additions: 0, deletions: 0, binary: false, statsSkipped: true };
    if (i >= max) return skipped;
    try {
      return { path: c.path, status: c.status, ...(await stats(c)) };
    } catch {
      complete = false;
      return skipped;
    }
  });
  return { files, complete };
}
