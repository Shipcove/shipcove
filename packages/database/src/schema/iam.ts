import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common.js';

export const users = pgTable(
  'users',
  {
    id: pk(),
    email: text().notNull(),
    username: text().notNull(),
    displayName: text().notNull(),
    platformRole: text({ enum: ['platform_admin', 'user'] }).notNull().default('user'),
    status: text({ enum: ['active', 'suspended', 'deleted', 'pending_verification'] }).notNull().default('active'),
    emailVerifiedAt: ts(),
    lastLoginAt: ts(),
    /** Incrémenté pour invalider toutes les sessions (révocation globale). */
    sessionEpoch: integer().notNull().default(0),
    deletedAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
    uniqueIndex('users_username_uq').on(sql`lower(${t.username})`),
  ],
);

export const localCredentials = pgTable('local_credentials', {
  userId: uuid()
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text().notNull(),
  passwordChangedAt: ts().notNull().defaultNow(),
  failedAttempts: integer().notNull().default(0),
  lockedUntil: ts(),
});

/** Fournisseurs d'identité configurés (le login local est un réglage plateforme). */
export const authProviders = pgTable(
  'auth_providers',
  {
    id: pk(),
    type: text({ enum: ['oidc', 'saml', 'ldap', 'github', 'gitlab'] }).notNull(),
    name: text().notNull(),
    enabled: boolean().notNull().default(false),
    autoProvision: boolean().notNull().default(true),
    /** Configuration non sensible ; les secrets sont référencés dans Vault. */
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    secretRef: text(),
    version: integer().notNull().default(1),
    lastTestAt: ts(),
    lastTestResult: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('auth_providers_name_uq').on(t.name)],
);

/**
 * État d'une redirection SSO en cours (OIDC/OAuth : state + nonce + PKCE ; SAML : RelayState).
 * Usage unique et durée de vie courte ; stocké en base pour fonctionner avec plusieurs instances API.
 */
export const authFlows = pgTable(
  'auth_flows',
  {
    id: pk(),
    providerId: uuid()
      .notNull()
      .references(() => authProviders.id, { onDelete: 'cascade' }),
    /** Empreinte SHA-256 du `state` / RelayState transmis au fournisseur. */
    stateHash: text().notNull(),
    nonce: text(),
    codeVerifier: text(),
    /** Chemin relatif de retour après connexion. */
    returnTo: text().notNull().default('/'),
    /** Rattachement d'une identité externe à l'utilisateur connecté (sinon : connexion). */
    linkUserId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('auth_flows_state_uq').on(t.stateHash), index().on(t.expiresAt)],
);

/** Identités externes rattachées à un utilisateur interne (jamais de fusion par email). */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    providerId: uuid()
      .notNull()
      .references(() => authProviders.id, { onDelete: 'cascade' }),
    subject: text().notNull(),
    email: text(),
    rawProfile: jsonb().$type<Record<string, unknown>>(),
    lastLoginAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('auth_identities_provider_subject_uq').on(t.providerId, t.subject), index().on(t.userId)],
);

export const userSessions = pgTable(
  'user_sessions',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 du jeton de session (le jeton brut n'est jamais stocké). */
    tokenHash: text().notNull(),
    csrfToken: text().notNull(),
    sessionEpoch: integer().notNull(),
    authMethod: text().notNull(),
    /** `pending_mfa` : mot de passe validé, second facteur attendu. */
    state: text({ enum: ['active', 'pending_mfa', 'pending_mfa_enrollment'] }).notNull().default('active'),
    mfaVerifiedAt: ts(),
    ip: text(),
    userAgent: text(),
    createdAt: createdAt(),
    lastSeenAt: ts().notNull().defaultNow(),
    idleExpiresAt: ts().notNull(),
    absoluteExpiresAt: ts().notNull(),
    revokedAt: ts(),
  },
  (t) => [uniqueIndex('user_sessions_token_uq').on(t.tokenHash), index().on(t.userId)],
);

export const mfaFactors = pgTable(
  'mfa_factors',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `webauthn` réservé (architecture compatible passkeys). */
    type: text({ enum: ['totp', 'recovery_codes', 'webauthn'] }).notNull(),
    /** Secret TOTP chiffré (AES-256-GCM, clé issue de Vault Transit / clé maître). */
    secretEnc: text(),
    /** Codes de récupération hachés (Argon2id) avec marqueur d'utilisation. */
    recoveryCodes: jsonb().$type<Array<{ hash: string; usedAt: string | null }>>(),
    lastUsedStep: integer(),
    confirmedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.userId)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: pk(),
    email: text().notNull(),
    tokenHash: text().notNull(),
    teamId: uuid(),
    role: text({ enum: ['team_admin', 'member'] }).notNull().default('member'),
    invitedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    expiresAt: ts().notNull(),
    acceptedAt: ts(),
    acceptedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invitations_token_uq').on(t.tokenHash), index().on(t.email)],
);

/** Jetons à usage unique : vérification email, réinitialisation de mot de passe. */
export const oneTimeTokens = pgTable(
  'one_time_tokens',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text({ enum: ['email_verification', 'password_reset'] }).notNull(),
    tokenHash: text().notNull(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('one_time_tokens_hash_uq').on(t.tokenHash), index().on(t.userId, t.purpose)],
);

/** Connexions Git (indépendantes de l'identité de login). Les tokens sont dans Vault. */
export const gitConnections = pgTable(
  'git_connections',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text({ enum: ['github', 'github_enterprise', 'gitlab', 'gitlab_self_managed'] }).notNull(),
    host: text().notNull(),
    accountId: text().notNull(),
    accountLogin: text().notNull(),
    accountName: text(),
    scopes: jsonb().$type<string[]>().notNull().default([]),
    secretRef: text().notNull(),
    authType: text({ enum: ['oauth', 'pat'] }).notNull(),
    tokenExpiresAt: ts(),
    status: text({ enum: ['active', 'expired', 'revoked', 'error'] }).notNull().default('active'),
    lastUsedAt: ts(),
    createdAt: createdAt(),
    revokedAt: ts(),
  },
  (t) => [
    uniqueIndex('git_connections_user_account_uq')
      .on(t.userId, t.host, t.accountId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/** Tentatives d'authentification (limitation de débit et journal d'authentification). */
export const authAttempts = pgTable(
  'auth_attempts',
  {
    id: pk(),
    key: text().notNull(),
    userId: uuid(),
    ip: text(),
    kind: text().notNull(),
    success: boolean().notNull(),
    reason: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.key, t.createdAt), index().on(t.userId, t.createdAt)],
);

