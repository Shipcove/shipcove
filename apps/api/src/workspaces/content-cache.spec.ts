import { describe, expect, it } from 'vitest';
import { ContentCache } from './content-cache.js';

describe('ContentCache', () => {
  it('fusionne les chargements concurrents et sert ensuite depuis le cache', async () => {
    const c = new ContentCache<string>({ maxEntries: 10 });
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 5));
      return 'v';
    };
    const results = await Promise.all(Array.from({ length: 50 }, () => c.getOrLoad('k', load)));
    expect(results.every((r) => r === 'v')).toBe(true);
    expect(await c.getOrLoad('k', load)).toBe('v');
    expect(loads).toBe(1);
  });

  it('évince la clé la moins récemment utilisée, sans tout vider', () => {
    const c = new ContentCache<number>({ maxEntries: 2 });
    c.set('a', 1);
    c.set('b', 2);
    c.get('a');
    c.set('c', 3);
    expect(c.get('a')).toBe(1);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('c')).toBe(3);
  });

  it('respecte le poids maximal et les valeurs exclues', () => {
    const c = new ContentCache<Buffer | null>({ maxEntries: 100, maxWeight: 10, weigh: (b) => b?.length ?? 0, shouldCache: (b) => b !== null });
    c.set('a', Buffer.alloc(6));
    c.set('b', Buffer.alloc(6));
    expect(c.get('a')).toBeUndefined();
    expect(c.get('b')).toBeDefined();
    c.set('big', Buffer.alloc(11));
    expect(c.get('big')).toBeUndefined();
    c.set('n', null);
    expect(c.size).toBe(1);
  });

  it('ne met pas en cache un échec', async () => {
    const c = new ContentCache<string>({ maxEntries: 10 });
    await expect(c.getOrLoad('k', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await c.getOrLoad('k', async () => 'ok')).toBe('ok');
  });
});
