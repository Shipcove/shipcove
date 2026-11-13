import { z } from 'zod';
import { AuthProviderTypeSchema } from './auth.js';
import { PlatformRoleSchema } from './common.js';
import { NotificationTypes } from './extensions.js';

/**
 * Paramètres plateforme (table `platform_settings`, versionnée).
 * Les valeurs par défaut ci-dessous sont celles du cahier des charges.
 */
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
      checkpointExcludes: z.array(z.string().max(255)).default([]),
    })
    .prefault({}),
  previews: z
    .object({
      maxPortsPerWorkspace: z.number().int().min(0).max(50).default(3),
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  quotas: z
    .object({
      enabled: z.boolean().default(true),
      /** Estimation de sortie réservée quand `max_tokens` n'est pas fourni. */
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
      teamServersAllowed: z.boolean().default(true),
      allowedRemoteHosts: z.array(z.string().max(255)).default([]),
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
  section: z.enum(['auth', 'editor', 'sandbox', 'previews', 'quotas', 'attachments', 'skills', 'mcp', 'notifications']),
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

export const OidcConfigSchema = z.object({
  issuer: z.url(),
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().max(4000).optional(),
  scopes: z.array(z.string()).default(['openid', 'profile', 'email']),
  /** Claim exigeant la MFA côté IdP (ex. `amr` contient `mfa`). */
  requireMfaClaim: z.boolean().default(false),
});
export const SamlConfigSchema = z.object({
  entryPoint: z.url(),
  issuer: z.string().min(1).max(500),
  idpCert: z.string().min(20).max(20000),
  emailAttribute: z.string().default('email'),
  nameAttribute: z.string().default('displayName'),
  wantAssertionsSigned: z.boolean().default(true),
});
export const LdapConfigSchema = z.object({
  url: z.string().regex(/^ldaps?:\/\//),
  bindDn: z.string().max(1000),
  bindPassword: z.string().max(4000).optional(),
  searchBase: z.string().max(1000),
  searchFilter: z.string().max(1000).default('(|(uid={{username}})(sAMAccountName={{username}}))'),
  emailAttribute: z.string().default('mail'),
  nameAttribute: z.string().default('cn'),
  usernameAttribute: z.string().default('uid'),
  startTls: z.boolean().default(false),
});
export const OAuthGitConfigSchema = z.object({
  /** github.com / gitlab.com ou hôte self-hosted. */
  host: z.string().min(3).max(255),
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().max(4000).optional(),
  /** Autoriser aussi l'usage pour la connexion (login), en plus du rattachement Git. */
  allowLogin: z.boolean().default(true),
});

export const UpsertAuthProviderSchema = z.object({
  type: AuthProviderTypeSchema.exclude(['local']),
  name: z.string().min(1).max(120),
  enabled: z.boolean().default(false),
  /** Création automatique de compte au premier login (pas de fusion par email). */
  autoProvision: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()),
});

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
}

export const SmtpConfigSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(false),
  username: z.string().max(500).optional(),
  password: z.string().max(4000).optional(),
  fromAddress: z.email(),
  fromName: z.string().max(200).default('Coding Agent Platform'),
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
  teams: number;
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
