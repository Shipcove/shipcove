import { describe, expect, it } from 'vitest';
import { trustProxy } from './trust-proxy.js';

describe('TRUST_PROXY', () => {
  it('mots-clés, adresses et plages', () => {
    const { trust, stop } = trustProxy('loopback, 10.1.2.3, 172.18.0.0/16');
    expect(trust('127.0.0.1')).toBe(true);
    expect(trust('::ffff:127.0.0.1')).toBe(true);
    expect(trust('10.1.2.3')).toBe(true);
    expect(trust('172.18.4.5')).toBe(true);
    expect(trust('10.1.2.4')).toBe(false);
    expect(trust('192.168.1.1')).toBe(false);
    stop();
  });

  it('noms de services résolus : seul le proxy déclaré est cru, pas un autre conteneur interne', async () => {
    const { trust, ready, stop } = trustProxy('loopback, web, edge', { resolve: async (h) => (h === 'web' ? ['172.20.0.7'] : ['172.20.0.9']) });
    await ready;
    expect(trust('172.20.0.7')).toBe(true);
    expect(trust('172.20.0.9')).toBe(true);
    expect(trust('172.20.0.12')).toBe(false);
    stop();
  });

  it('refuse une entrée invalide', () => {
    expect(() => trustProxy('10.0.0.0/abc')).toThrow();
    expect(() => trustProxy('web; rm')).toThrow();
  });
});
