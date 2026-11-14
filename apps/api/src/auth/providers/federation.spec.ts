import { describe, expect, it } from 'vitest';
import { LdapConfigSchema, OidcConfigSchema } from '@cap/contracts';
import { safeReturnTo } from './federation.service.js';
import { amrIndicatesMfa } from './federation.types.js';
import { escapeLdapFilter } from './ldap.adapter.js';
import { originOf } from './oauth.adapter.js';

describe('fédération : fonctions de sécurité', () => {
  it('échappe les valeurs insérées dans un filtre LDAP (RFC 4515)', () => {
    expect(escapeLdapFilter('bob')).toBe('bob');
    expect(escapeLdapFilter('*')).toBe('\\2a');
    expect(escapeLdapFilter('a)(uid=*')).toBe('a\\29\\28uid=\\2a');
    expect(escapeLdapFilter('x\\y')).toBe('x\\5cy');
    expect(escapeLdapFilter('nul\0')).toBe('nul\\00');
  });

  it('refuse les redirections ouvertes après connexion', () => {
    expect(safeReturnTo('/workspaces/1')).toBe('/workspaces/1');
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('//evil.example')).toBe('/');
    expect(safeReturnTo('/\\evil.example')).toBe('/');
    expect(safeReturnTo('/ok\r\nSet-Cookie: x=1')).toBe('/');
    expect(safeReturnTo(undefined)).toBe('/');
  });

  it('détecte une MFA attestée par le fournisseur (amr / acr)', () => {
    expect(amrIndicatesMfa(['pwd'], undefined)).toBe(false);
    expect(amrIndicatesMfa(['pwd', 'otp'], undefined)).toBe(true);
    expect(amrIndicatesMfa(['mfa'], undefined)).toBe(true);
    expect(amrIndicatesMfa(undefined, 'urn:example:mfa')).toBe(true);
    expect(amrIndicatesMfa(undefined, '1')).toBe(false);
  });

  it('normalise les hôtes OAuth (SaaS ou auto-hébergé)', () => {
    expect(originOf('github.com')).toBe('https://github.com');
    expect(originOf('http://gitlab.local:8080/')).toBe('http://gitlab.local:8080');
  });

  it('valide les configurations de fournisseurs', () => {
    expect(LdapConfigSchema.safeParse({ url: 'ldap://x', bindDn: 'cn=a', searchBase: 'dc=x', searchFilter: '(uid=bob)' }).success).toBe(false);
    expect(LdapConfigSchema.parse({ url: 'ldaps://x', bindDn: 'cn=a', searchBase: 'dc=x' }).searchFilter).toContain('{{username}}');
    expect(OidcConfigSchema.safeParse({ issuer: 'javascript:alert(1)', clientId: 'x' }).success).toBe(false);
    expect(OidcConfigSchema.parse({ issuer: 'https://kc/realms/r', clientId: 'x' }).mfa).toBe('auto');
  });
});
