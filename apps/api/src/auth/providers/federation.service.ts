import { Inject, Injectable, Logger } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { and, count, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import {
  AUTH_PROVIDER_CONFIG_SCHEMAS,
  AUTH_PROVIDER_SECRET_FIELDS,
  type AuthProviderAdminDto,
  type GitHubOAuthConfig,
  type GitLabOAuthConfig,
  type LdapConfig,
  type LoginResult,
  type OidcConfig,
  type SamlConfig,
} from '@cap/contracts';
import { authAttempts, authFlows, authIdentities, authProviders, localCredentials, users, type Database } from '@cap/database';
import type { SecretProvider } from '@cap/secrets';
import { AppError, AuditService, DB, ENV, SECRETS, SettingsService, isUniqueViolation, randomToken, sha256Hex } from '@cap/server-core';
import type { RequestContext } from '../../common/decorators.js';
import type { ApiEnv } from '../../env.js';
import { AuthService, type SessionTokens } from '../auth.service.js';
import { FederationError, type FederatedProfile } from './federation.types.js';
import { LdapAdapter } from './ldap.adapter.js';
import { GitHubAdapter, GitLabAdapter } from './oauth.adapter.js';
import { OidcAdapter } from './oidc.adapter.js';
import { SamlAdapter } from './saml.adapter.js';

type ProviderType = keyof typeof AUTH_PROVIDER_CONFIG_SCHEMAS;
type ProviderRow = typeof authProviders.$inferSelect;

interface LoadedProvider {
  row: ProviderRow;
  type: ProviderType;
  config: OidcConfig | SamlConfig | LdapConfig | GitHubOAuthConfig | GitLabOAuthConfig;
  secrets: Record<string, string>;
}

const FLOW_TTL_MS = 10 * 60_000;
const LDAP_WINDOW_MIN = 15;

export interface SsoCallbackInput {
  /** URL complète reçue (OIDC / OAuth en GET). */
  url: URL;
  /** Corps POST (SAML : SAMLResponse + RelayState). */
  body: Record<string, unknown>;
  /** Jeton de liaison présenté par le navigateur (cookie posé au démarrage d'un rattachement). */
  linkBinding?: string;
}

export type FederatedLogin = { kind: 'login'; result: LoginResult; tokens: SessionTokens; returnTo: string } | { kind: 'linked'; returnTo: string };

/**
 * Fédération d'identité (SPEC §4) : OIDC/Keycloak, SAML 2.0, LDAP/AD, OAuth GitHub et GitLab.
 * - Les secrets (client secret, mot de passe de liaison, clé SAML) sont dans Vault.
 * - Aucune fusion de compte par email : une identité externe se rattache explicitement
 *   depuis une session active, sinon un compte est créé (si autorisé) ou la connexion est refusée.
 * - La politique MFA du fournisseur est respectée selon `config.mfa`.
 */
@Injectable()
export class FederationService {
  private readonly logger = new Logger('Federation');
  private readonly oidc = new OidcAdapter();
  private readonly saml = new SamlAdapter();
  private readonly ldap = new LdapAdapter();
  private readonly github = new GitHubAdapter();
  private readonly gitlab = new GitLabAdapter();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(SECRETS) private readonly secretsProvider: SecretProvider,
    private readonly auth: AuthService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
  ) {}

  callbackUrl(providerId: string): string {
    return `${this.env.PUBLIC_URL.replace(/\/$/, '')}/api/v1/auth/sso/${providerId}/callback`;
  }

  /* ------------------------------ Connexion ------------------------------ */

  /** Démarre une redirection vers le fournisseur ; renvoie l'URL d'autorisation. */
  async start(providerId: string, opts: { returnTo?: string; linkUserId?: string }): Promise<{ url: string; linkBinding: string | null }> {
    const p = await this.load(providerId, true);
    if (p.type === 'ldap') throw new AppError('validation_failed', 'LDAP s’utilise par identifiant et mot de passe');
    const state = randomToken(32);
    const redirectUri = this.callbackUrl(p.row.id);
    let started: { url: string; codeVerifier: string | null; nonce: string | null };
    switch (p.type) {
      case 'oidc':
        started = await this.oidc.start(this.cacheKey(p), p.config as OidcConfig, p.secrets['clientSecret'], redirectUri, state);
        break;
      case 'saml':
        started = await this.saml.start(p.config as SamlConfig, redirectUri, p.secrets['privateKey'], state);
        break;
      case 'github':
        started = this.github.start(p.config as GitHubOAuthConfig, redirectUri, state);
        break;
      case 'gitlab':
        started = this.gitlab.start(p.config as GitLabOAuthConfig, redirectUri, state);
        break;
    }
    await this.db.delete(authFlows).where(lt(authFlows.expiresAt, sql`now() - interval '1 day'`));
    // Rattachement : jeton lié au navigateur demandeur, exigé au retour du fournisseur.
    const linkBinding = opts.linkUserId ? randomToken(32) : null;
    await this.db.insert(authFlows).values({
      providerId: p.row.id,
      stateHash: sha256Hex(state),
      nonce: started.nonce,
      codeVerifier: started.codeVerifier,
      returnTo: safeReturnTo(opts.returnTo),
      linkUserId: opts.linkUserId ?? null,
      linkBindingHash: linkBinding ? sha256Hex(linkBinding) : null,
      expiresAt: new Date(Date.now() + FLOW_TTL_MS),
    });
    return { url: started.url, linkBinding };
  }

  /** Retour du fournisseur : valide le flux (usage unique), authentifie, puis ouvre une session ou rattache l'identité. */
  async callback(providerId: string, input: SsoCallbackInput, ctx: RequestContext): Promise<FederatedLogin> {
    const p = await this.load(providerId, true);
    const q = input.url.searchParams;
    const state = p.type === 'saml' ? str(input.body['RelayState']) : q.get('state');
    if (!state) throw new FederationError('sso_failed', 'Paramètre state / RelayState absent');
    // Consommation atomique : un flux ne sert qu'une fois, même entre plusieurs instances.
    const [flow] = await this.db
      .update(authFlows)
      .set({ usedAt: new Date() })
      .where(and(eq(authFlows.stateHash, sha256Hex(state)), eq(authFlows.providerId, p.row.id), isNull(authFlows.usedAt), gt(authFlows.expiresAt, sql`now()`)))
      .returning();
    if (!flow) throw new FederationError('sso_expired', 'Flux de connexion inconnu, expiré ou déjà utilisé');
    const providerError = q.get('error');
    if (providerError) throw new FederationError('sso_denied', `Le fournisseur a refusé : ${providerError} ${q.get('error_description') ?? ''}`.trim());

    const redirectUri = this.callbackUrl(p.row.id);
    let profile: FederatedProfile;
    switch (p.type) {
      case 'oidc':
        profile = await this.oidc.callback(this.cacheKey(p), p.config as OidcConfig, p.secrets['clientSecret'], input.url, {
          state,
          nonce: flow.nonce ?? '',
          codeVerifier: flow.codeVerifier ?? '',
        });
        break;
      case 'saml': {
        const response = str(input.body['SAMLResponse']);
        if (!response || !flow.nonce) throw new FederationError('sso_failed', 'SAMLResponse absente');
        profile = await this.saml.callback(p.config as SamlConfig, redirectUri, p.secrets['privateKey'], response, flow.nonce);
        break;
      }
      case 'github':
      case 'gitlab': {
        const code = q.get('code');
        const secret = p.secrets['clientSecret'];
        if (!code) throw new FederationError('sso_failed', 'Code d’autorisation absent');
        if (!secret) throw new FederationError('sso_failed', 'Secret client non configuré');
        profile =
          p.type === 'github'
            ? await this.github.callback(p.config as GitHubOAuthConfig, secret, code, redirectUri)
            : await this.gitlab.callback(p.config as GitLabOAuthConfig, secret, code, redirectUri, flow.codeVerifier ?? '');
        break;
      }
      default:
        throw new FederationError('sso_failed', 'Type de fournisseur non pris en charge');
    }

    if (flow.linkUserId) {
      // Le retour doit avoir lieu dans le navigateur qui a demandé le rattachement : sinon, toute
      // personne ouvrant le lien d'autorisation rattacherait son identité au compte du demandeur.
      if (!flow.linkBindingHash || !input.linkBinding || !safeEqualHex(sha256Hex(input.linkBinding), flow.linkBindingHash)) {
        throw new FederationError('sso_denied', 'Rattachement refusé : il doit être terminé dans le navigateur qui l’a demandé');
      }
      await this.link(p, profile, flow.linkUserId, ctx);
      return { kind: 'linked', returnTo: flow.returnTo };
    }
    const { result, tokens } = await this.signIn(p, profile, ctx);
    return { kind: 'login', result, tokens, returnTo: flow.returnTo };
  }

  /** Connexion LDAP / Active Directory (identifiant + mot de passe, sans redirection). */
  async ldapLogin(providerId: string, username: string, password: string, ctx: RequestContext): Promise<{ result: LoginResult; tokens: SessionTokens }> {
    const p = await this.load(providerId, true);
    if (p.type !== 'ldap') throw new AppError('validation_failed', 'Ce fournisseur n’est pas un annuaire LDAP');
    await this.auth.checkIpRateLimit(ctx.ip);
    const key = `ldap:${p.row.id}:${username.trim().toLowerCase()}`;
    const authCfg = await this.settings.section('auth');
    const [{ n }] = await this.db
      .select({ n: count() })
      .from(authAttempts)
      .where(and(eq(authAttempts.key, key), eq(authAttempts.success, false), gt(authAttempts.createdAt, sql`now() - (${LDAP_WINDOW_MIN} * interval '1 minute')`)));
    if (n >= authCfg.maxFailedLogins) throw new AppError('account_locked', 'Trop de tentatives : réessayez plus tard');
    let profile: FederatedProfile;
    try {
      profile = await this.ldap.authenticate(p.config as LdapConfig, p.secrets['bindPassword'] ?? '', username, password);
    } catch (e) {
      await this.auth.recordAttempt(key, null, ctx, false, e instanceof FederationError ? e.code : 'error');
      if (e instanceof FederationError && e.code === 'sso_denied') {
        await this.audit.record({ actorLabel: username.slice(0, 100), action: 'auth.login', outcome: 'failure', ip: ctx.ip, userAgent: ctx.userAgent, metadata: { method: `ldap:${p.row.name}` } });
        throw new AppError('invalid_credentials', 'Identifiants invalides');
      }
      throw this.toAppError(e);
    }
    await this.auth.recordAttempt(key, null, ctx, true, 'ldap_ok');
    try {
      return await this.signIn(p, profile, ctx);
    } catch (e) {
      throw this.toAppError(e);
    }
  }

  /** Erreur de fédération → erreur API homogène (connexion LDAP en JSON). */
  toAppError(e: unknown): AppError {
    if (e instanceof AppError) return e;
    if (e instanceof FederationError) {
      const map: Partial<Record<FederationError['code'], AppError>> = {
        account_suspended: new AppError('account_suspended', 'Compte suspendu'),
        provider_disabled: new AppError('provider_disabled', 'Fournisseur désactivé'),
        account_exists: new AppError('conflict', 'Un compte utilise déjà cette adresse : connectez-vous puis rattachez cette identité depuis vos paramètres'),
        provisioning_disabled: new AppError('forbidden', 'Aucun compte associé et la création automatique est désactivée'),
        email_missing: new AppError('validation_failed', 'L’annuaire ne fournit pas d’adresse email pour ce compte'),
        not_allowed: new AppError('forbidden', 'Accès non autorisé pour ce compte'),
      };
      this.logger.warn(`Fédération : ${e.code} — ${e.message}`);
      return map[e.code] ?? new AppError('provider_disabled', 'Fournisseur d’identité indisponible');
    }
    this.logger.error(`Fédération : ${(e as Error).message}`);
    return new AppError('internal_error', 'Erreur interne');
  }

  /* ---------------------- Comptes, rattachement, MFA ---------------------- */

  private async signIn(p: LoadedProvider, profile: FederatedProfile, ctx: RequestContext): Promise<{ result: LoginResult; tokens: SessionTokens }> {
    const mfaPolicy = (p.config as { mfa?: string }).mfa ?? 'local';
    if (mfaPolicy === 'require_idp' && !profile.mfa) throw new FederationError('mfa_required_by_idp', 'Le fournisseur n’atteste pas d’authentification multifacteur');
    const userId = await this.resolveUser(p, profile, ctx);
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u || u.status === 'suspended' || u.status === 'deleted' || u.deletedAt) throw new FederationError('account_suspended', 'Compte suspendu');
    const externalMfa = mfaPolicy === 'trust_idp' || ((mfaPolicy === 'auto' || mfaPolicy === 'require_idp') && profile.mfa);
    return this.auth.openSession(u.id, u.platformRole, `${p.type}:${p.row.name}`, ctx, { externalMfa });
  }

  private async resolveUser(p: LoadedProvider, profile: FederatedProfile, ctx: RequestContext): Promise<string> {
    const [identity] = await this.db
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.providerId, p.row.id), eq(authIdentities.subject, profile.subject)));
    if (identity) {
      await this.db.update(authIdentities).set({ lastLoginAt: new Date(), email: profile.email, rawProfile: profile.raw }).where(eq(authIdentities.id, identity.id));
      return identity.userId;
    }
    if (!p.row.autoProvision) throw new FederationError('provisioning_disabled', `Aucun compte rattaché à ${profile.subject}`);
    if (!profile.email) throw new FederationError('email_missing', 'Adresse email absente du profil fédéré');
    const [existing] = await this.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${profile.email})`);
    // Jamais de fusion implicite par email (prise de contrôle de compte) : rattachement explicite requis.
    if (existing) throw new FederationError('account_exists', `L’adresse ${profile.email} appartient déjà à un compte`);
    const base = usernameFrom(profile);
    for (let i = 0; i < 6; i++) {
      const username = i === 0 ? base : `${base.slice(0, 34)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 4)}`;
      try {
        const userId = await this.db.transaction(async (tx) => {
          const [u] = await tx
            .insert(users)
            .values({
              email: profile.email!,
              username,
              displayName: (profile.displayName ?? profile.username ?? username).slice(0, 120),
              status: 'active',
              emailVerifiedAt: profile.emailVerified ? new Date() : null,
            })
            .returning({ id: users.id });
          await tx.insert(authIdentities).values({ userId: u.id, providerId: p.row.id, subject: profile.subject, email: profile.email, rawProfile: profile.raw, lastLoginAt: new Date() });
          return u.id;
        });
        await this.audit.record({ actorId: userId, action: 'auth.sso_provisioned', targetType: 'user', targetId: userId, ip: ctx.ip, userAgent: ctx.userAgent, metadata: { provider: p.row.name, type: p.type } });
        return userId;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        const [again] = await this.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${profile.email})`);
        if (again) throw new FederationError('account_exists', `L’adresse ${profile.email} appartient déjà à un compte`);
      }
    }
    throw new FederationError('sso_failed', 'Impossible d’attribuer un identifiant unique');
  }

  private async link(p: LoadedProvider, profile: FederatedProfile, userId: string, ctx: RequestContext): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.providerId, p.row.id), eq(authIdentities.subject, profile.subject)));
    if (existing && existing.userId !== userId) throw new FederationError('identity_linked_elsewhere', 'Cette identité est déjà rattachée à un autre compte');
    if (!existing) {
      await this.db.insert(authIdentities).values({ userId, providerId: p.row.id, subject: profile.subject, email: profile.email, rawProfile: profile.raw, lastLoginAt: new Date() });
    }
    await this.audit.record({ actorId: userId, action: 'auth.identity_linked', targetType: 'auth_provider', targetId: p.row.id, ip: ctx.ip, userAgent: ctx.userAgent, metadata: { provider: p.row.name } });
  }

  /** Identités de l'utilisateur et retrait (refusé s'il ne resterait aucun moyen de connexion). */
  async identities(userId: string) {
    const rows = await this.db
      .select({ id: authIdentities.id, providerId: authProviders.id, provider: authProviders.name, type: authProviders.type, email: authIdentities.email, lastLoginAt: authIdentities.lastLoginAt, createdAt: authIdentities.createdAt })
      .from(authIdentities)
      .innerJoin(authProviders, eq(authProviders.id, authIdentities.providerId))
      .where(eq(authIdentities.userId, userId));
    return rows.map((r) => ({ ...r, lastLoginAt: r.lastLoginAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() }));
  }

  async unlink(userId: string, identityId: string, ctx: RequestContext): Promise<void> {
    const mine = await this.db.select({ id: authIdentities.id }).from(authIdentities).where(eq(authIdentities.userId, userId));
    if (!mine.some((m) => m.id === identityId)) throw new AppError('not_found', 'Identité introuvable');
    const [local] = await this.db.select({ userId: localCredentials.userId }).from(localCredentials).where(eq(localCredentials.userId, userId));
    if (!local && mine.length <= 1) throw new AppError('conflict', 'Impossible de retirer votre dernier moyen de connexion');
    await this.db.delete(authIdentities).where(and(eq(authIdentities.id, identityId), eq(authIdentities.userId, userId)));
    await this.audit.record({ actorId: userId, action: 'auth.identity_unlinked', targetId: identityId, ip: ctx.ip, userAgent: ctx.userAgent });
  }

  /* --------------------------- Administration --------------------------- */

  async adminList(): Promise<AuthProviderAdminDto[]> {
    const rows = await this.db.select().from(authProviders).orderBy(authProviders.createdAt);
    return rows.map((r) => this.adminDto(r));
  }

  async upsert(
    id: string | null,
    input: { type: ProviderType; name: string; enabled: boolean; autoProvision: boolean; config: Record<string, unknown> },
    actorId: string | null,
    ctx: RequestContext,
  ): Promise<AuthProviderAdminDto> {
    const secretFields = AUTH_PROVIDER_SECRET_FIELDS[input.type];
    const secretInput: Record<string, string> = {};
    const raw = { ...input.config };
    for (const f of secretFields) {
      if (typeof raw[f] === 'string' && raw[f]) secretInput[f] = raw[f] as string;
      delete raw[f];
    }
    const parsed = AUTH_PROVIDER_CONFIG_SCHEMAS[input.type].safeParse(raw);
    if (!parsed.success) throw new AppError('validation_failed', 'Configuration invalide', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const config = parsed.data as Record<string, unknown>;
    let row: ProviderRow;
    try {
      if (id) {
        const [prev] = await this.db.select().from(authProviders).where(eq(authProviders.id, id));
        if (!prev) throw new AppError('not_found', 'Fournisseur introuvable');
        if (prev.type !== input.type) throw new AppError('validation_failed', 'Le type d’un fournisseur ne peut pas changer');
        [row] = await this.db
          .update(authProviders)
          .set({ name: input.name, enabled: input.enabled, autoProvision: input.autoProvision, config, version: sql`${authProviders.version} + 1`, updatedAt: new Date() })
          .where(eq(authProviders.id, id))
          .returning();
      } else {
        [row] = await this.db.insert(authProviders).values({ type: input.type, name: input.name, enabled: input.enabled, autoProvision: input.autoProvision, config }).returning();
      }
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError('conflict', 'Un fournisseur porte déjà ce nom');
      throw e;
    }
    if (Object.keys(secretInput).length) {
      const prev = row.secretRef ? await this.secretsProvider.read(row.secretRef).catch(() => ({})) : {};
      const ref = await this.secretsProvider.write(`auth-providers/${row.id}`, { ...prev, ...secretInput });
      [row] = await this.db.update(authProviders).set({ secretRef: ref }).where(eq(authProviders.id, row.id)).returning();
    }
    this.oidc.invalidate(row.id);
    await this.audit.record({ actorId, action: id ? 'admin.auth_provider_update' : 'admin.auth_provider_create', targetType: 'auth_provider', targetId: row.id, ip: ctx.ip, metadata: { type: row.type, name: row.name, secretUpdated: Object.keys(secretInput) } });
    return this.adminDto(row);
  }

  async setEnabled(id: string, enabled: boolean, actorId: string, ctx: RequestContext): Promise<void> {
    const [row] = await this.db.update(authProviders).set({ enabled, updatedAt: new Date() }).where(eq(authProviders.id, id)).returning();
    if (!row) throw new AppError('not_found', 'Fournisseur introuvable');
    await this.audit.record({ actorId, action: enabled ? 'admin.auth_provider_enable' : 'admin.auth_provider_disable', targetType: 'auth_provider', targetId: id, ip: ctx.ip });
  }

  async remove(id: string, actorId: string, ctx: RequestContext): Promise<void> {
    const [row] = await this.db.delete(authProviders).where(eq(authProviders.id, id)).returning();
    if (!row) throw new AppError('not_found', 'Fournisseur introuvable');
    if (row.secretRef) await this.secretsProvider.revoke(row.secretRef).catch((e: Error) => this.logger.warn(`Révocation du secret : ${e.message}`));
    this.oidc.invalidate(id);
    await this.audit.record({ actorId, action: 'admin.auth_provider_delete', targetType: 'auth_provider', targetId: id, ip: ctx.ip, metadata: { name: row.name } });
  }

  /** Test de configuration sans connexion d'utilisateur (découverte, certificat, liaison annuaire…). */
  async test(id: string, actorId: string): Promise<{ ok: boolean; detail: string }> {
    let result: { ok: boolean; detail: string };
    try {
      const p = await this.load(id, false);
      let detail: string;
      switch (p.type) {
        case 'oidc':
          detail = await this.oidc.test(this.cacheKey(p), p.config as OidcConfig, p.secrets['clientSecret']);
          break;
        case 'saml':
          detail = this.saml.test(p.config as SamlConfig, this.callbackUrl(id), p.secrets['privateKey']);
          break;
        case 'ldap':
          detail = await this.ldap.test(p.config as LdapConfig, p.secrets['bindPassword']);
          break;
        case 'github':
          detail = await this.github.test(p.config as GitHubOAuthConfig, p.secrets['clientSecret']);
          break;
        case 'gitlab':
          detail = await this.gitlab.test(p.config as GitLabOAuthConfig, p.secrets['clientSecret']);
          break;
      }
      result = { ok: true, detail };
    } catch (e) {
      result = { ok: false, detail: e instanceof FederationError || e instanceof AppError ? (e as Error).message : `Erreur : ${(e as Error).message}` };
    }
    await this.db.update(authProviders).set({ lastTestAt: new Date(), lastTestResult: `${result.ok ? 'OK' : 'Échec'} — ${result.detail}`.slice(0, 1000) }).where(eq(authProviders.id, id));
    await this.audit.record({ actorId, action: 'admin.auth_provider_test', targetType: 'auth_provider', targetId: id, outcome: result.ok ? 'success' : 'failure' });
    return result;
  }

  /** Métadonnées SAML du fournisseur de services (à importer côté IdP). */
  async samlMetadata(id: string): Promise<string> {
    const p = await this.load(id, false);
    if (p.type !== 'saml') throw new AppError('not_found', 'Fournisseur SAML introuvable');
    return this.saml.metadata(p.config as SamlConfig, this.callbackUrl(id), p.secrets['privateKey']);
  }

  /* ------------------------------- Interne ------------------------------- */

  private async load(id: string, requireEnabled: boolean): Promise<LoadedProvider> {
    const [row] = await this.db.select().from(authProviders).where(eq(authProviders.id, id));
    if (!row) throw new AppError('not_found', 'Fournisseur introuvable');
    if (requireEnabled && !row.enabled) throw new FederationError('provider_disabled', `Fournisseur ${row.name} désactivé`);
    const type = row.type as ProviderType;
    if (requireEnabled && (type === 'github' || type === 'gitlab') && (row.config as { allowLogin?: boolean }).allowLogin === false) {
      throw new FederationError('provider_disabled', `Connexion via ${row.name} non autorisée`);
    }
    const parsed = AUTH_PROVIDER_CONFIG_SCHEMAS[type].safeParse(row.config);
    if (!parsed.success) throw new FederationError('sso_failed', `Configuration de ${row.name} invalide`);
    const secrets = row.secretRef
      ? await this.secretsProvider.read(row.secretRef).catch(() => {
          throw new AppError('secret_backend_unavailable', 'Gestionnaire de secrets indisponible');
        })
      : {};
    return { row, type, config: parsed.data as LoadedProvider['config'], secrets };
  }

  private cacheKey(p: LoadedProvider): string {
    return `${p.row.id}:${p.row.version}`;
  }

  private adminDto(r: ProviderRow): AuthProviderAdminDto {
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      enabled: r.enabled,
      autoProvision: r.autoProvision,
      config: r.config,
      secretConfigured: !!r.secretRef,
      lastTestAt: r.lastTestAt?.toISOString() ?? null,
      lastTestResult: r.lastTestResult,
      callbackUrl: this.callbackUrl(r.id),
    };
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** Chemin de retour : uniquement relatif à l'application (pas de redirection ouverte). */
export function safeReturnTo(v: string | undefined | null): string {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || /[\r\n]/.test(v)) return '/';
  return v.slice(0, 500);
}

function usernameFrom(p: FederatedProfile): string {
  const candidates = [p.username, p.email?.split('@')[0], p.displayName, 'utilisateur'];
  for (const c of candidates) {
    const s = (c ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 40);
    if (s.length >= 3) return s;
  }
  return `utilisateur-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
}

/** Comparaison à temps constant de deux empreintes hexadécimales. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
