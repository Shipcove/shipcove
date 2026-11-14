import { X509Certificate, randomBytes } from 'node:crypto';
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import type { SamlConfig } from '@cap/contracts';
import { FederationError, type FederatedProfile } from './federation.types.js';

/**
 * Cache `InResponseTo` adossé à l'état du flux SSO (table auth_flows), et non à la mémoire
 * du processus : fonctionne avec plusieurs instances API. L'identifiant de requête est
 * mémorisé au démarrage et ne peut être consommé qu'une fois (flux à usage unique).
 */
class FlowRequestCache implements CacheProvider {
  constructor(private readonly expected: string | null) {}
  saved: string | null = null;
  async saveAsync(key: string, value: string) {
    this.saved = key;
    return { value, createdAt: Date.now() };
  }
  async getAsync(key: string) {
    // Relu par node-saml via `new Date(valeur)` : format ISO requis.
    return key === this.expected ? new Date().toISOString() : null;
  }
  /**
   * node-saml vérifie InResponseTo au niveau de la réponse puis du sujet, en retirant la clé entre
   * les deux : on ne l'oublie pas ici, l'unicité étant garantie par la consommation du flux en base.
   */
  async removeAsync(key: string | null) {
    return key;
  }
}

const MFA_CONTEXT = /MultiFactor|TimeSyncToken|Smartcard|MobileTwoFactor|\bmfa\b/i;

function normalizeCert(c: string): string {
  return c.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

export class SamlAdapter {
  private saml(cfg: SamlConfig, callbackUrl: string, privateKey: string | undefined, cache: CacheProvider): SAML {
    const certs = (Array.isArray(cfg.idpCert) ? cfg.idpCert : [cfg.idpCert]).map(normalizeCert);
    return new SAML({
      entryPoint: cfg.entryPoint,
      issuer: cfg.issuer,
      callbackUrl,
      idpCert: certs,
      idpIssuer: cfg.idpIssuer,
      audience: cfg.issuer,
      wantAssertionsSigned: cfg.wantAssertionsSigned,
      wantAuthnResponseSigned: cfg.wantAuthnResponseSigned,
      privateKey,
      signatureAlgorithm: 'sha256',
      identifierFormat: null,
      disableRequestedAuthnContext: true,
      acceptedClockSkewMs: 60_000,
      maxAssertionAgeMs: 5 * 60_000,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: 10 * 60_000,
      cacheProvider: cache,
      generateUniqueId: () => `_${randomBytes(20).toString('hex')}`,
    });
  }

  async start(cfg: SamlConfig, callbackUrl: string, privateKey: string | undefined, relayState: string) {
    const cache = new FlowRequestCache(null);
    const url = await this.saml(cfg, callbackUrl, privateKey, cache)
      .getAuthorizeUrlAsync(relayState, undefined, {})
      .catch((e: Error) => {
        throw new FederationError('sso_failed', `Requête SAML impossible : ${e.message}`);
      });
    if (!cache.saved) throw new FederationError('sso_failed', 'Identifiant de requête SAML non généré');
    // `nonce` du flux = identifiant de l'AuthnRequest (vérifié via InResponseTo).
    return { url, codeVerifier: null, nonce: cache.saved };
  }

  async callback(cfg: SamlConfig, callbackUrl: string, privateKey: string | undefined, samlResponse: string, requestId: string): Promise<FederatedProfile> {
    const { profile } = await this.saml(cfg, callbackUrl, privateKey, new FlowRequestCache(requestId))
      .validatePostResponseAsync({ SAMLResponse: samlResponse })
      .catch((e: Error) => {
        throw new FederationError('sso_failed', `Réponse SAML refusée : ${e.message}`);
      });
    if (!profile?.nameID) throw new FederationError('sso_failed', 'Réponse SAML sans NameID');
    const attr = (name: string): string | null => {
      const v = (profile as Profile)[name];
      const s = Array.isArray(v) ? v[0] : v;
      return typeof s === 'string' && s ? s : null;
    };
    const emailFromNameId = /emailAddress/.test(profile.nameIDFormat ?? '') ? profile.nameID : null;
    const email = attr(cfg.emailAttribute) ?? attr('email') ?? attr('mail') ?? attr('urn:oid:0.9.2342.19200300.100.1.3') ?? emailFromNameId;
    const assertion = profile.getAssertionXml?.() ?? '';
    const contexts = [...assertion.matchAll(/AuthnContextClassRef>([^<]+)</g)].map((m) => m[1]);
    return {
      subject: profile.nameID,
      email,
      // Assertion signée par le fournisseur configuré : l'email est attesté par lui.
      emailVerified: !!email,
      username: attr(cfg.usernameAttribute),
      displayName: attr(cfg.nameAttribute),
      mfa: contexts.some((c) => MFA_CONTEXT.test(c)),
      raw: { issuer: profile.issuer, nameID: profile.nameID, nameIDFormat: profile.nameIDFormat, authnContext: contexts },
    };
  }

  metadata(cfg: SamlConfig, callbackUrl: string, privateKey: string | undefined): string {
    return this.saml(cfg, callbackUrl, privateKey, new FlowRequestCache(null)).generateServiceProviderMetadata(null, null);
  }

  test(cfg: SamlConfig, callbackUrl: string, privateKey: string | undefined): string {
    const certs = Array.isArray(cfg.idpCert) ? cfg.idpCert : [cfg.idpCert];
    const details = certs.map((c) => {
      try {
        const x = new X509Certificate(Buffer.from(normalizeCert(c), 'base64'));
        const expires = new Date(x.validTo);
        if (expires < new Date()) throw new FederationError('sso_failed', `Certificat du fournisseur expiré le ${expires.toISOString().slice(0, 10)}`);
        return `certificat « ${x.subject.replace(/\n/g, ', ')} » valide jusqu’au ${expires.toISOString().slice(0, 10)}`;
      } catch (e) {
        if (e instanceof FederationError) throw e;
        throw new FederationError('sso_failed', 'Certificat du fournisseur illisible (PEM ou base64 attendu)');
      }
    });
    this.metadata(cfg, callbackUrl, privateKey);
    return `Configuration SAML valide : ${details.join(' ; ')} ; métadonnées SP générées`;
  }
}
