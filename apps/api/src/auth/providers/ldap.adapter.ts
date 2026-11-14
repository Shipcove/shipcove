import { Client, InvalidCredentialsError, type Entry } from 'ldapts';
import type { LdapConfig } from '@cap/contracts';
import { FederationError, type FederatedProfile } from './federation.types.js';

/** Échappement d'une valeur insérée dans un filtre LDAP (RFC 4515). */
export function escapeLdapFilter(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function client(cfg: LdapConfig): Client {
  // ldapts ouvre une connexion TLS dès que `tlsOptions` est fourni : réservé à ldaps:// (StartTLS : voir open()).
  const tls = cfg.url.startsWith('ldaps://') ? { tlsOptions: { rejectUnauthorized: cfg.tlsRejectUnauthorized } } : {};
  return new Client({ url: cfg.url, timeout: cfg.timeoutMs, connectTimeout: cfg.timeoutMs, ...tls });
}

async function open(cfg: LdapConfig): Promise<Client> {
  const c = client(cfg);
  if (cfg.startTls) await c.startTLS({ rejectUnauthorized: cfg.tlsRejectUnauthorized });
  return c;
}

function first(entry: Entry, attr: string): string | null {
  const v = entry[attr];
  const s = Array.isArray(v) ? v[0] : v;
  if (Buffer.isBuffer(s)) return s.toString('utf8');
  return typeof s === 'string' && s ? s : null;
}

/** Identifiant stable : entryUUID (OpenLDAP), objectGUID (AD), sinon le DN. */
function stableId(entry: Entry): string {
  const guid = entry['objectGUID'];
  const g = Array.isArray(guid) ? guid[0] : guid;
  if (Buffer.isBuffer(g) && g.length === 16) return `guid:${g.toString('hex')}`;
  const uuid = first(entry, 'entryUUID');
  return uuid ? `uuid:${uuid}` : `dn:${entry.dn.toLowerCase()}`;
}

export class LdapAdapter {
  async authenticate(cfg: LdapConfig, bindPassword: string, username: string, password: string): Promise<FederatedProfile> {
    // Un mot de passe vide déclencherait un bind anonyme (« unauthenticated bind ») accepté par certains serveurs.
    if (!password || !username.trim()) throw new FederationError('sso_denied', 'Identifiants invalides');
    const svc = await open(cfg);
    let entry: Entry;
    try {
      await svc.bind(cfg.bindDn, bindPassword).catch((e: Error) => {
        throw new FederationError('sso_failed', `Liaison du compte de service refusée : ${e.message}`);
      });
      const filter = cfg.searchFilter.replaceAll('{{username}}', escapeLdapFilter(username.trim()));
      const { searchEntries } = await svc.search(cfg.searchBase, {
        scope: 'sub',
        filter,
        sizeLimit: 2,
        attributes: ['dn', 'entryUUID', 'objectGUID', cfg.usernameAttribute, cfg.emailAttribute, cfg.nameAttribute],
        explicitBufferAttributes: ['objectGUID'],
      });
      if (searchEntries.length !== 1) throw new FederationError('sso_denied', 'Identifiants invalides');
      entry = searchEntries[0];
    } finally {
      await svc.unbind().catch(() => undefined);
    }
    const user = await open(cfg);
    try {
      await user.bind(entry.dn, password);
    } catch (e) {
      if (e instanceof InvalidCredentialsError) throw new FederationError('sso_denied', 'Identifiants invalides');
      throw new FederationError('sso_failed', `Vérification LDAP impossible : ${(e as Error).message}`);
    } finally {
      await user.unbind().catch(() => undefined);
    }
    const email = first(entry, cfg.emailAttribute);
    return {
      subject: stableId(entry),
      email,
      // L'annuaire d'entreprise fait autorité sur l'adresse.
      emailVerified: !!email,
      username: first(entry, cfg.usernameAttribute) ?? username.trim(),
      displayName: first(entry, cfg.nameAttribute),
      mfa: false,
      raw: { dn: entry.dn },
    };
  }

  async test(cfg: LdapConfig, bindPassword: string | undefined): Promise<string> {
    if (!bindPassword) throw new FederationError('sso_failed', 'Mot de passe du compte de service absent');
    const c = await open(cfg).catch((e: Error) => {
      throw new FederationError('sso_failed', `Connexion impossible à ${cfg.url} : ${e.message}`);
    });
    try {
      await c.bind(cfg.bindDn, bindPassword).catch((e: Error) => {
        throw new FederationError('sso_failed', `Liaison du compte de service refusée : ${e.message}`);
      });
      const { searchEntries } = await c.search(cfg.searchBase, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'] }).catch((e: Error) => {
        throw new FederationError('sso_failed', `Base de recherche introuvable (${cfg.searchBase}) : ${e.message}`);
      });
      return `Annuaire joignable (${cfg.url}${cfg.startTls ? ', StartTLS' : ''}) ; compte de service lié ; base « ${searchEntries[0]?.dn ?? cfg.searchBase} » trouvée`;
    } finally {
      await c.unbind().catch(() => undefined);
    }
  }
}
