import { describe, expect, it } from 'vitest';
import { VaultSecretProvider } from './vault-provider.js';

/**
 * Test d'intégration contre un vrai Vault (mode dev, réservé aux tests) si VAULT_TEST_ADDR est défini.
 * Exemple : docker run -d -p 8299:8200 -e VAULT_DEV_ROOT_TOKEN_ID=root hashicorp/vault:2.2.2
 */
const addr = process.env.VAULT_TEST_ADDR;
const token = process.env.VAULT_TEST_TOKEN ?? 'root';

describe.skipIf(!addr)('VaultSecretProvider (intégration)', () => {
  it('écrit, lit, versionne et révoque un secret sans exposer les valeurs dans les erreurs', async () => {
    // Montage KV v2 « cap » (idempotent).
    await fetch(`${addr}/v1/sys/mounts/cap`, {
      method: 'POST',
      headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'kv', options: { version: '2' } }),
    });
    const p = new VaultSecretProvider({ address: addr!, auth: { method: 'token', token } });
    const ref = await p.write('tests/demo', { password: 's3cr3t' });
    expect(ref).toBe('vault:tests/demo');
    expect(await p.readKey(ref, 'password')).toBe('s3cr3t');
    const meta = await p.rotate(ref, { password: 'n3w' });
    expect(meta.version).toBeGreaterThanOrEqual(2);
    expect(await p.readKey(ref, 'password')).toBe('n3w');
    expect((await p.health()).ok).toBe(true);
    await p.revoke(ref);
    await expect(p.read(ref)).rejects.toThrow(/introuvable/);
  });
});

describe('VaultSecretProvider (unitaire)', () => {
  it('rejette les chemins dangereux', () => {
    const p = new VaultSecretProvider({ address: 'http://x', auth: { method: 'token', token: 't' } });
    expect(() => p.reference('../etc')).toThrow();
    expect(() => p.reference('a//b')).toThrow();
    expect(p.reference('git-connections/abc')).toBe('vault:git-connections/abc');
  });

  it('signale une indisponibilité sans lever', async () => {
    const p = new VaultSecretProvider({
      address: 'http://127.0.0.1:1',
      auth: { method: 'token', token: 't' },
      timeoutMs: 500,
    });
    const h = await p.health();
    expect(h.ok).toBe(false);
  });
});
