import { describe, expect, it } from 'vitest';
import { decideHost, isPrivateAddress } from './egress-policy.js';

describe('politique d’egress', () => {
  const allow = ['registry.npmjs.org', '*.pythonhosted.org', 'github.com'];
  it('refuse toujours les forges, même si l’admin les ajoute à la liste blanche', () => {
    for (const h of ['github.com', 'api.github.com', 'GITHUB.COM.', 'gitlab.com', 'x.github.com']) {
      expect(decideHost(h, 443, allow, []).allowed).toBe(false);
    }
    expect(decideHost('git.corp.local', 443, ['git.corp.local'], ['git.corp.local']).allowed).toBe(false);
  });
  it('applique la liste blanche, les ports et refuse les IP littérales', () => {
    expect(decideHost('registry.npmjs.org', 443, allow, []).allowed).toBe(true);
    expect(decideHost('files.pythonhosted.org', 443, allow, []).allowed).toBe(true);
    expect(decideHost('evil.example', 443, allow, []).allowed).toBe(false);
    expect(decideHost('registry.npmjs.org', 22, allow, []).allowed).toBe(false);
    expect(decideHost('140.82.112.3', 443, ['140.82.112.3'], []).allowed).toBe(false);
  });
  it('détecte les adresses internes (SSRF)', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.20.0.5', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.1.2.3']) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress('104.16.1.1')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });
  it('refuse toutes les écritures IPv6 d’une adresse IPv4 (mappée, hexadécimale, NAT64)', () => {
    for (const ip of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '::127.0.0.1', 'fe80::1', 'fd00::1', '::1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });
});
