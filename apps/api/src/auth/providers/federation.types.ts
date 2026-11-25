/** Profil normalisé renvoyé par un fournisseur d'identité après authentification réussie. */
export interface FederatedProfile {
  /** Identifiant stable et unique chez le fournisseur (jamais l'email). */
  subject: string;
  email: string | null;
  /**
   * `true` : email attesté par le fournisseur (ou annuaire géré par l'entreprise) ; `false` :
   * explicitement non vérifié ; `null` : le fournisseur ne dit rien.
   */
  emailVerified: boolean | null;
  username: string | null;
  displayName: string | null;
  /** Le fournisseur atteste une authentification multifacteur (amr / AuthnContext). */
  mfa: boolean;
  /** Profil brut minimal (sans jeton) conservé pour diagnostic. */
  raw: Record<string, unknown>;
}

/** Erreur fonctionnelle de fédération : code stable affiché par l'interface, message pour les journaux. */
export class FederationError extends Error {
  constructor(
    readonly code: FederationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FederationError';
  }
}

export type FederationErrorCode =
  | 'sso_failed'
  | 'sso_expired'
  | 'sso_denied'
  | 'provider_disabled'
  | 'account_exists'
  | 'account_suspended'
  | 'email_missing'
  | 'email_unverified'
  | 'provisioning_disabled'
  | 'mfa_required_by_idp'
  | 'not_allowed'
  | 'identity_linked_elsewhere';

/** Valeurs `amr` (RFC 8176) indiquant une authentification multifacteur. */
const MFA_AMR = new Set(['mfa', 'otp', 'hwk', 'swk', 'sms', 'fpt', 'face', 'iris', 'retina', 'vbm', 'pop', 'sc']);

export function amrIndicatesMfa(amr: unknown, acr: unknown): boolean {
  if (Array.isArray(amr) && amr.some((v) => typeof v === 'string' && MFA_AMR.has(v.toLowerCase()))) return true;
  return typeof acr === 'string' && /mfa|multi|2fa|\b2\b|loa[2-9]|silver|gold/i.test(acr);
}
