import { describe, expect, it } from 'vitest';
import { isSameOrigin } from './auth.guard.js';

const req = (headers: Record<string, string>) => ({ headers: { host: 'shipcove.example.com', ...headers } });

describe('isSameOrigin (CSRF des routes publiques)', () => {
  it('accepte une requête de l’application', () => {
    expect(isSameOrigin(req({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOrigin(req({ origin: 'https://shipcove.example.com' }))).toBe(true);
    expect(isSameOrigin(req({}))).toBe(true); // client non navigateur
    // nginx transmet Host sans le port.
    expect(isSameOrigin({ headers: { host: 'localhost', origin: 'http://localhost:8080' } })).toBe(true);
  });
  it('refuse un autre site, un sous-domaine (previews) ou une origine opaque', () => {
    expect(isSameOrigin(req({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
    expect(isSameOrigin(req({ 'sec-fetch-site': 'same-site' }))).toBe(false);
    expect(isSameOrigin(req({ origin: 'https://evil.example' }))).toBe(false);
    expect(isSameOrigin(req({ origin: 'null' }))).toBe(false);
  });
  it('tient compte de l’hôte transmis par le reverse proxy', () => {
    expect(isSameOrigin({ headers: { host: 'api:3000', 'x-forwarded-host': 'shipcove.example.com', origin: 'https://shipcove.example.com' } })).toBe(true);
  });
});
