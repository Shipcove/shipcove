import { describe, expect, it } from 'vitest';
import { buildChangeList, mapLimit, type ChangeEntry } from './change-stats.js';
import { ContentCache } from './content-cache.js';

const entries = (n: number): ChangeEntry[] => Array.from({ length: n }, (_, i) => ({ path: `f${i}.txt`, status: 'modified', oldHash: `a${i}`, newHash: `b${i}` }));
const tick = () => new Promise((r) => setTimeout(r, 1));

describe('mapLimit', () => {
  it('ne dépasse jamais la concurrence demandée et garde l’ordre', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([...Array(50).keys()], 4, async (x) => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return x * 2;
    });
    expect(peak).toBe(4);
    expect(out).toEqual([...Array(50).keys()].map((x) => x * 2));
  });
});

describe('buildChangeList', () => {
  it('compte les lignes en parallèle borné', async () => {
    let running = 0;
    let peak = 0;
    const r = await buildChangeList(entries(40), async () => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
      return { additions: 1, deletions: 2, binary: false };
    }, { concurrency: 8 });
    expect(peak).toBe(8);
    expect(r.complete).toBe(true);
    expect(r.files[0]).toEqual({ path: 'f0.txt', status: 'modified', additions: 1, deletions: 2, binary: false });
  });

  it('ne compte pas au-delà du plafond, mais liste tous les fichiers', async () => {
    let calls = 0;
    const r = await buildChangeList(entries(10), async () => {
      calls++;
      return { additions: 1, deletions: 0, binary: false };
    }, { maxFiles: 3 });
    expect(calls).toBe(3);
    expect(r.files).toHaveLength(10);
    expect(r.files.filter((f) => f.statsSkipped)).toHaveLength(7);
    expect(r.complete).toBe(true);
  });

  it('une lecture en échec rend la liste incomplète, sans fausses statistiques', async () => {
    const r = await buildChangeList(entries(3), async (c) => {
      if (c.path === 'f1.txt') throw new Error('S3 indisponible');
      return { additions: 5, deletions: 0, binary: false };
    });
    expect(r.complete).toBe(false);
    expect(r.files[1]).toMatchObject({ path: 'f1.txt', statsSkipped: true, additions: 0 });
    expect(r.files[2]).toMatchObject({ additions: 5 });
  });

  it('erreur passagère : rien n’est mis en cache, la lecture suivante réussit', async () => {
    const stats = new ContentCache<{ additions: number; deletions: number; binary: boolean }>({ maxEntries: 10 });
    const responses = new ContentCache<{ files: number; complete: boolean }>({ maxEntries: 10, shouldCache: (v) => v.complete });
    let fail = true;
    const compute = async () => {
      const r = await buildChangeList(entries(2), (c) =>
        stats.getOrLoad(`${c.oldHash}:${c.newHash}`, async () => {
          if (fail && c.path === 'f1.txt') throw new Error('S3 indisponible');
          return { additions: 1, deletions: 0, binary: false };
        }),
      );
      return { files: r.files.filter((f) => !f.statsSkipped).length, complete: r.complete };
    };
    expect(await responses.getOrLoad('k', compute)).toEqual({ files: 1, complete: false });
    expect(stats.size).toBe(1); // seul le fichier lu avec succès est en cache
    fail = false;
    expect(await responses.getOrLoad('k', compute)).toEqual({ files: 2, complete: true });
    expect(responses.size).toBe(1);
  });
});

describe('ContentCache pesé', () => {
  it('évince les entrées les plus anciennes au-delà du poids maximal', () => {
    const c = new ContentCache<{ n: number }>({ maxEntries: 100, maxWeight: 10, weigh: (v) => v.n });
    c.set('a', { n: 6 });
    c.set('b', { n: 3 });
    c.set('c', { n: 4 }); // 13 > 10 : « a » sort
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')?.n).toBe(3);
    expect(c.get('c')?.n).toBe(4);
    c.set('big', { n: 11 }); // plus lourd que le maximum : jamais conservé
    expect(c.get('big')).toBeUndefined();
  });
});
