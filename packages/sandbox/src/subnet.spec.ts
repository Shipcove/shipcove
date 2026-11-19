import { describe, expect, it } from 'vitest';
import { privateNetworkName, subnetFor } from './docker-provider.js';

describe('réseaux privés de sandbox', () => {
  it('attribue un /28 aligné dans la plage, stable pour une sandbox', () => {
    const id = '0f3c2a91-7d4e-4b8a-9c1d-2e5f6a7b8c9d';
    const s = subnetFor('10.231.0.0/16', id, 0);
    expect(s).toMatch(/^10\.231\.\d{1,3}\.\d{1,3}\/28$/);
    expect(Number(s.split('.')[3].split('/')[0]) % 16).toBe(0);
    expect(subnetFor('10.231.0.0/16', id, 0)).toBe(s);
    expect(subnetFor('10.231.0.0/16', id, 1)).not.toBe(s);
  });
  it('reste dans une petite plage', () => {
    for (let i = 0; i < 50; i++) expect(subnetFor('192.168.240.0/24', `id-${i}`, i)).toMatch(/^192\.168\.240\.(\d+)\/28$/);
  });
  it('nomme le réseau d’après la sandbox', () => {
    expect(privateNetworkName('ABC-123')).toBe('cap-sbx-net-abc-123');
  });
});
