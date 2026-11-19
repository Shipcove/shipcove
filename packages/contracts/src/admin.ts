import { z } from 'zod';
import { AuthProviderTypeSchema } from './auth.js';
import { PlatformRoleSchema } from './common.js';
import { NotificationTypes } from './extensions.js';

/**
 * Paramètres plateforme (table `platform_settings`, versionnée).
 * Les valeurs par défaut ci-dessous sont celles du cahier des charges.
 */
/** Plage de ports de preview : « 8080 » ou « 3000-9999 » (1024 à 65535). */
export const PortRangeSchema = z
  .string()
  .trim()
  .regex(/^\d{4,5}(-\d{4,5})?$/, 'Port ou plage attendus : 8080 ou 3000-9999')
  .refine((v) => {
    const [lo, hi = lo] = v.split('-').map(Number);
    return lo >= 1024 && hi <= 65535 && lo <= hi;
  }, 'Ports entre 1024 et 65535, plage croissante');

/** Port couvert par la liste blanche des previews. */
export function previewPortAllowed(port: number, ranges: readonly string[]): boolean {
  return ranges.some((r) => {
    const [lo, hi = lo] = r.split('-').map(Number);
    return port >= lo && port <= hi;
  });
}

/**
 * Dossiers régénérables jamais utiles dans un checkpoint (si `sandbox.excludeDependencyDirs`).
 * Chaque motif désigne un segment de chemin, à n'importe quelle profondeur.
 */
export const DEFAULT_CHECKPOINT_EXCLUDES = [
  'node_modules',
  '.pnpm-store',
  '.npm',
  '.next/cache',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.angular/cache',
  '.svelte-kit',
  '__pycache__',
  '.venv',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.gradle',
] as const;

export const PlatformSettingsSchema = z.object({
  auth: z
    .object({
      localLoginEnabled: z.boolean().default(true),
      registrationEnabled: z.boolean().default(false),
      emailVerificationRequired: z.boolean().default(true),
      mfaPolicy: z.enum(['optional', 'required_admins', 'required_all']).default('required_admins'),
      sessionIdleHours: z.number().int().min(1).max(720).default(24),
      sessionAbsoluteHours: z.number().int().min(1).max(8760).default(24 * 14),
      maxFailedLogins: z.number().int().min(3).max(100).default(8),
      lockoutMinutes: z.number().int().min(1).max(1440).default(15),
    })
    .prefault({}),
  editor: z
    .object({
      manualEditingEnabled: z.boolean().default(false),
    })
    .prefault({}),
  sandbox: z
    .object({
      idleTimeoutMinutes: z.number().int().min(1).max(1440).default(15),
      maxRunMinutes: z.number().int().min(5).max(24 * 60).default(240),
      cpu: z.number().min(0.25).max(64).default(2),
      memoryMb: z.number().int().min(256).max(262144).default(4096),
      diskMb: z.number().int().min(512).max(1_048_576).default(10240),
      pidsLimit: z.number().int().min(64).max(65536).default(1024),
      maxActiveSandboxesPerUser: z.number().int().min(1).max(100).default(3),
      maxActiveSandboxesTotal: z.number().int().min(1).max(10000).default(50),
      /** Domaines accessibles depuis les sandboxes via le proxy d'egress. */
      egressAllowlist: z
        .array(z.string().max(255))
        .default([
          'registry.npmjs.org',
          'pypi.org',
          'files.pythonhosted.org',
          'registry.yarnpkg.com',
          'deb.debian.org',
          'proxy.golang.org',
          'crates.io',
          'static.crates.io',
          'index.crates.io',
          'repo.maven.apache.org',
          'objects.githubusercontent.com',
        ]),
      /**
       * Exclut des checkpoints les dossiers régénérables de DEFAULT_CHECKPOINT_EXCLUDES (dépendances,
       * caches). Ils ne sont alors ni sauvegardés ni restaurés : le script de préparation, relancé à
       * chaque nouvelle sandbox, les réinstalle.
       */
      excludeDependencyDirs: z.boolean().default(true),
      /** Motifs supplémentaires (nom de dossier ou de fichier, `*` autorisé), en plus de la liste ci-dessus. */
      checkpointExcludes: z.array(z.string().max(255)).default([]),
      /** Nombre maximal de services d'appui lancés par Pi dans une même sandbox. */
      maxServicesPerWorkspace: z.number().int().min(0).max(10).default(4),
      /** Durée maximale du script de démarrage. */
      setupTimeoutMinutes: z.number().int().min(1).max(120).default(20),
      /**
       * Script de démarrage (bash) exécuté dans chaque nouvelle sandbox, avec ou sans dépôt, et
       * rejoué quand il change : registres npm / pip, miroirs, outils, `git config --global`…
       * Vide : aucun script.
       */
      startupScript: z.string().max(20_000).default(''),
    })
    .prefault({}),
  previews: z
    .object({
      maxPortsPerWorkspace: z.number().int().min(0).max(50).default(3),
      enabled: z.boolean().default(true),
      /** Ports autorisés (liste blanche) : « 3000 » ou « 3000-9999 ». Les ports des services d'appui restent toujours refusés. */
      allowedPorts: z.array(PortRangeSchema).max(100).default(['3000-9999']),
    })
    .prefault({}),
  quotas: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * Tokens de sortie réservés par appel (plafond de l'estimation, même si `max_tokens` est plus
       * grand) ; l'usage réel est débité à la fin de l'appel.
       */
      defaultOutputReservation: z.number().int().min(256).max(200_000).default(8192),
      /** Politique si l'usage reste inconnu après réconciliation. */
      unknownUsagePolicy: z.enum(['charge_estimate_input', 'charge_nothing_flag']).default('charge_estimate_input'),
    })
    .prefault({}),
  attachments: z
    .object({
      maxFileMb: z.number().int().min(1).max(500).default(20),
      maxFilesPerMessage: z.number().int().min(1).max(50).default(10),
      allowArchives: z.boolean().default(true),
      maxArchiveEntries: z.number().int().min(1).max(100000).default(2000),
      maxArchiveExpandedMb: z.number().int().min(1).max(5000).default(200),
    })
    .prefault({}),
  skills: z
    .object({
      personalSkillsAllowed: z.boolean().default(true),
      personalSkillsRequireReview: z.boolean().default(false),
    })
    .prefault({}),
  mcp: z
    .object({
      personalServersAllowed: z.boolean().default(true),
      allowedRemoteHosts: z.array(z.string().max(255)).default([]),
    })
    .prefault({}),
  git: z
    .object({
      /**
       * Forges auto-hébergées joignables en HTTP (hôte[:port], ex. forge interne de recette).
       * Vide par défaut : HTTPS obligatoire. Les jetons transitent alors en clair sur ce réseau.
       */
      insecureHttpHosts: z.array(z.string().regex(/^[a-z0-9.-]+(:\d+)?$/i).max(255)).max(20).default([]),
      /** Rattachement par jeton d'accès personnel (désactivé : OAuth via les forges configurées). */
      allowPersonalTokens: z.boolean().default(false),
      /**
       * Adresse de la mention « Co-Authored-By: Shipcove <adresse> » ajoutée à chaque commit fait
       * dans les sandboxes (vide : aucune mention). Elle ne doit correspondre à aucun compte d'une
       * forge, qui lui attribuerait ces commits.
       */
      coAuthorEmail: z.union([z.literal(''), z.email().max(254)]).default('noreply@shipcove.dev'),
    })
    .prefault({}),
  subagents: z
    .object({
      /** Outil `subagent` proposé à l'agent (sinon : aucun sous-agent sur la plateforme). */
      enabled: z.boolean().default(true),
      /** Nombre maximal de sous-agents par appel de l'outil. */
      maxTasks: z.number().int().min(1).max(8).default(4),
      /** Sous-agents d'exploration lancés en même temps (ceux de travail passent un par un). */
      maxParallel: z.number().int().min(1).max(8).default(4),
      /** Durée maximale d'un sous-agent, au-delà il est arrêté et compté en échec. */
      timeoutMinutes: z.number().int().min(1).max(120).default(20),
    })
    .prefault({}),
  conversations: z
    .object({
      /** Modèle qui génère les titres des conversations (non décompté des quotas) ; vide : premier message tronqué. */
      titleModelId: z.uuid().nullable().default(null),
    })
    .prefault({}),
  notifications: z
    .object({
      emailEnabled: z.boolean().default(true),
      mandatoryEmailTypes: z.array(z.enum(NotificationTypes)).default(['security']),
    })
    .prefault({}),
});
export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;

export const PlatformSettingsPatchSchema = z.object({
  section: z.enum(['auth', 'editor', 'sandbox', 'previews', 'quotas', 'attachments', 'skills', 'mcp', 'git', 'subagents', 'conversations', 'notifications']),
  values: z.record(z.string(), z.unknown()),
});

export const RetentionDataTypes = [
  'conversations',
  'messages',
  'agent_events',
  'tool_logs',
  'attachments',
  'notifications',
  'checkpoints',
  'archived_workspaces',
  'audit',
  'llm_requests',
  'email_deliveries',
] as const;
export type RetentionDataType = (typeof RetentionDataTypes)[number];

export const RetentionPolicySchema = z.object({
  dataType: z.enum(RetentionDataTypes),
  /** `null` = conservation illimitée. */
  retentionDays: z.number().int().min(1).max(36500).nullable(),
  legalHold: z.boolean().default(false),
});

/* ---------- Fournisseurs d'authentification ---------- */

export const UpsertAuthProviderSchema = z.object({
  type: AuthProviderTypeSchema.exclude(['local']),
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(false),
  /** Création automatique de compte au premier login (pas de fusion par email). */
  autoProvision: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()),
});

/**
 * Politique MFA d'un fournisseur fédéré :
 * - `auto` : MFA locale exigée selon la politique plateforme, sauf si le fournisseur atteste une MFA (amr / AuthnContext) ;
 * - `require_idp` : connexion refusée si le fournisseur n'atteste pas de MFA ;
 * - `trust_idp` : le fournisseur impose lui-même la MFA (aucune MFA locale) ;
 * - `local` : politique MFA locale toujours appliquée.
 */
export const FederatedMfaSchema = z.enum(['auto', 'require_idp', 'trust_idp', 'local']);

const httpUrl = z.url({ protocol: /^https?$/ });

export const OidcConfigSchema = z.object({
  issuer: httpUrl,
  clientId: z.string().min(1).max(500),
  scopes: z.array(z.string().min(1).max(100)).max(30).default(['openid', 'profile', 'email']),
  usernameClaim: z.string().max(100).default('preferred_username'),
  emailClaim: z.string().max(100).default('email'),
  nameClaim: z.string().max(100).default('name'),
  mfa: FederatedMfaSchema.default('auto'),
  /** Émetteur en HTTP (développement / tests uniquement). */
  allowInsecureHttp: z.boolean().default(false),
});

export const SamlConfigSchema = z.object({
  /** URL SSO (HTTP-Redirect) du fournisseur d'identité. */
  entryPoint: httpUrl,
  /** Identifiant (entityID) de la plateforme côté fournisseur. */
  issuer: z.string().min(1).max(500),
  /** Certificat(s) de signature du fournisseur (PEM ou base64). */
  idpCert: z.union([z.string().min(20), z.array(z.string().min(20)).min(1)]),
  idpIssuer: z.string().max(500).optional(),
  emailAttribute: z.string().max(200).default('email'),
  nameAttribute: z.string().max(200).default('displayName'),
  usernameAttribute: z.string().max(200).default('username'),
  wantAssertionsSigned: z.boolean().default(true),
  wantAuthnResponseSigned: z.boolean().default(false),
  mfa: FederatedMfaSchema.default('auto'),
});

export const LdapConfigSchema = z.object({
  url: z.string().regex(/^ldaps?:\/\/[^\s]+$/, 'URL ldap:// ou ldaps://'),
  bindDn: z.string().min(1).max(500),
  searchBase: z.string().min(1).max(500),
  /** `{{username}}` est remplacé par l'identifiant saisi, échappé (RFC 4515). */
  searchFilter: z
    .string()
    .min(3)
    .max(1000)
    .refine((s) => s.includes('{{username}}'), 'Le filtre doit contenir {{username}}')
    .default('(|(uid={{username}})(sAMAccountName={{username}}))'),
  usernameAttribute: z.string().max(100).default('uid'),
  emailAttribute: z.string().max(100).default('mail'),
  nameAttribute: z.string().max(100).default('cn'),
  startTls: z.boolean().default(false),
  tlsRejectUnauthorized: z.boolean().default(true),
  timeoutMs: z.number().int().min(500).max(60_000).default(8000),
  mfa: z.enum(['local']).default('local'),
});

export const GitHubOAuthConfigSchema = z.object({
  /** `github.com` ou hôte GitHub Enterprise Server. */
  host: z.string().min(1).max(255).default('github.com'),
  clientId: z.string().min(1).max(500),
  allowLogin: z.boolean().default(true),
  /** Restreint la connexion aux membres de ces organisations (vide = tous). */
  allowedOrganizations: z.array(z.string().min(1).max(100)).max(50).default([]),
  mfa: z.enum(['local']).default('local'),
});

export const GitLabOAuthConfigSchema = z.object({
  /** `gitlab.com` ou instance auto-hébergée. */
  host: z.string().min(1).max(255).default('gitlab.com'),
  clientId: z.string().min(1).max(500),
  allowLogin: z.boolean().default(true),
  /** Restreint la connexion aux membres de ces groupes (chemin complet ; vide = tous). */
  allowedGroups: z.array(z.string().min(1).max(255)).max(50).default([]),
  mfa: z.enum(['local']).default('local'),
});

export const AUTH_PROVIDER_CONFIG_SCHEMAS = {
  oidc: OidcConfigSchema,
  saml: SamlConfigSchema,
  ldap: LdapConfigSchema,
  github: GitHubOAuthConfigSchema,
  gitlab: GitLabOAuthConfigSchema,
} as const;

/** Champs secrets acceptés à l'enregistrement (écrits dans Vault, jamais renvoyés). */
export const AUTH_PROVIDER_SECRET_FIELDS: Record<keyof typeof AUTH_PROVIDER_CONFIG_SCHEMAS, readonly string[]> = {
  oidc: ['clientSecret'],
  saml: ['privateKey'],
  ldap: ['bindPassword'],
  github: ['clientSecret'],
  gitlab: ['clientSecret'],
};

export type OidcConfig = z.infer<typeof OidcConfigSchema>;
export type SamlConfig = z.infer<typeof SamlConfigSchema>;
export type LdapConfig = z.infer<typeof LdapConfigSchema>;
export type GitHubOAuthConfig = z.infer<typeof GitHubOAuthConfigSchema>;
export type GitLabOAuthConfig = z.infer<typeof GitLabOAuthConfigSchema>;

export interface AuthProviderAdminDto {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  autoProvision: boolean;
  config: Record<string, unknown>;
  secretConfigured: boolean;
  lastTestAt: string | null;
  lastTestResult: string | null;
  /** URL de rappel à déclarer chez le fournisseur (OIDC / OAuth : redirect URI ; SAML : ACS). */
  callbackUrl: string;
}

/** Identité externe rattachée au compte courant. */
export interface LinkedIdentityDto {
  id: string;
  providerId: string;
  provider: string;
  type: string;
  email: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export const SmtpConfigSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  username: z.string().max(500).optional(),
  password: z.string().max(4000).optional(),
  fromAddress: z.email(),
  fromName: z.string().max(200).default('Shipcove'),
});

/* ---------- Utilisateurs (admin) ---------- */

export interface AdminUserDto {
  id: string;
  email: string;
  username: string;
  displayName: string;
  platformRole: z.infer<typeof PlatformRoleSchema>;
  status: 'active' | 'suspended' | 'deleted' | 'pending_verification';
  mfaEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  identities: Array<{ provider: string; subject: string }>;
}

export const AdminUpdateUserSchema = z.object({
  platformRole: PlatformRoleSchema.optional(),
  status: z.enum(['active', 'suspended']).optional(),
  displayName: z.string().min(1).max(120).optional(),
});

export const AdminCreateUserSchema = z.object({
  email: z.email(),
  username: z.string().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/),
  displayName: z.string().min(1).max(120),
  platformRole: PlatformRoleSchema.default('user'),
  /** Absent → email d'invitation à définir le mot de passe. */
  password: z.string().min(12).max(256).optional(),
});

export interface AdminOverviewDto {
  users: { total: number; active: number; suspended: number };
  /** Dépôts utilisés par au moins une conversation. */
  repositories: number;
  workspaces: { total: number; running: number };
  sandboxes: { active: number };
  llm: { requests24h: number; errors24h: number; credits24h: string; costUsd24h: string; p95LatencyMs: number | null };
  checkpoints: { failed24h: number; unsyncedWorkspaces: number };
  jobs: { pending: number; failed: number };
  health: Record<string, { status: 'up' | 'down' | 'degraded'; detail?: string }>;
}

export interface AuditEventDto {
  id: string;
  occurredAt: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  outcome: 'success' | 'failure';
  ip: string | null;
  metadata: Record<string, unknown>;
}

export const AuditQuerySchema = z.object({
  action: z.string().max(200).optional(),
  actorId: z.uuid().optional(),
  targetId: z.string().max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(200).optional(),
});
