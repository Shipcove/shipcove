import { z } from 'zod';

export const GitProviderKindSchema = z.enum(['github', 'github_enterprise', 'gitlab', 'gitlab_self_managed']);
export type GitProviderKind = z.infer<typeof GitProviderKindSchema>;

/** Dépôt choisi pour une conversation. */
export const RepositoryRefSchema = z.object({
  /** Connexion Git de l'utilisateur utilisée pour lire le dépôt. */
  gitConnectionId: z.uuid(),
  /** `owner/name` (GitHub) ou chemin complet du projet (GitLab). */
  fullName: z.string().min(1).max(400),
  /** Branche de travail (défaut : branche par défaut du dépôt). */
  branch: z.string().min(1).max(255).optional(),
});
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

export interface RepositoryDto {
  id: string;
  provider: GitProviderKind;
  host: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  webUrl: string;
}

export function toRepositoryDto(r: { id: string; provider: GitProviderKind; host: string; fullName: string; cloneUrl: string; defaultBranch: string; webUrl: string }): RepositoryDto {
  return { id: r.id, provider: r.provider, host: r.host, fullName: r.fullName, cloneUrl: r.cloneUrl, defaultBranch: r.defaultBranch, webUrl: r.webUrl };
}

/** Dépôt vu par l'administration (réglages d'environnement). */
export interface AdminRepositoryDto extends RepositoryDto {
  conversationCount: number;
  lastUsedAt: string | null;
  setupConfigured: boolean;
  variableCount: number;
}

/* ---------- Environnement d'un dépôt : variables, secrets, image, préparation ---------- */

/**
 * Noms réservés : ils piloteraient le réseau, le chargement de code ou l'identité de la sandbox
 * (proxy de sortie, CA, préchargement de bibliothèques, configuration Git/Pi de la plateforme).
 */
const RESERVED_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|HOSTNAME|TERM|BASH_ENV|ENV|PROMPT_COMMAND|IFS|(HTTPS?|ALL|NO|FTP)_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR)|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|GIT_(ASKPASS|SSH|SSH_COMMAND|CONFIG.*|PROXY_COMMAND|EXEC_PATH|DIR|WORK_TREE|SSL_.*|TERMINAL_PROMPT)|GITHUB_TOKEN|GITHUB_ENTERPRISE_TOKEN|GITLAB_TOKEN|(LD|DYLD|CAP|PI|GH|GLAB)_.*)$/i;

export const EnvVarNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Lettres, chiffres et « _ », sans commencer par un chiffre')
  .refine((n) => !RESERVED_ENV.test(n), 'Nom réservé par la plateforme (réseau, chargement de code ou configuration interne)');

export const UpsertEnvVarSchema = z.object({
  name: EnvVarNameSchema,
  /** Valeur ; pour un secret existant, absente = valeur conservée. */
  value: z.string().max(32_768).optional(),
  secret: z.boolean().default(false),
});
export type UpsertEnvVar = z.infer<typeof UpsertEnvVarSchema>;

export interface EnvVarDto {
  id: string;
  name: string;
  secret: boolean;
  /** `null` pour un secret (jamais renvoyé). */
  value: string | null;
  updatedAt: string;
}

export interface SandboxImageOptionDto {
  id: string;
  name: string;
  version: string;
  isDefault: boolean;
}

/** Réglages partagés par toutes les conversations sur le dépôt (administrateur). */
export interface RepositoryEnvironmentDto {
  repository: RepositoryDto;
  sandboxImageId: string | null;
  setupScript: string | null;
  images: SandboxImageOptionDto[];
  variables: EnvVarDto[];
}

export const UpdateRepositoryEnvironmentSchema = z.object({
  sandboxImageId: z.uuid().nullable(),
  setupScript: z.string().max(20_000).nullable(),
});
export type UpdateRepositoryEnvironment = z.infer<typeof UpdateRepositoryEnvironmentSchema>;

/* ---------- Services d'appui (bases de données, files…) ---------- */

export const ServiceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'Minuscules, chiffres et tirets (32 caractères max.)');

export interface ServiceCatalogDto {
  id: string;
  key: string;
  name: string;
  image: string;
  port: number | null;
  healthCommand: string[];
  defaultEnv: Record<string, string>;
  defaultMemoryMb: number;
  maxMemoryMb: number;
  enabled: boolean;
}

export const UpsertServiceCatalogSchema = z.object({
  key: ServiceNameSchema,
  name: z.string().min(1).max(120),
  image: z.string().min(3).max(300).regex(/^[a-z0-9./_:@-]+$/i, 'Référence d’image invalide'),
  port: z.number().int().min(1).max(65_535).nullable().default(null),
  healthCommand: z.array(z.string().min(1).max(500)).max(20).default([]),
  defaultEnv: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4096)).default({}),
  defaultMemoryMb: z.number().int().min(64).max(65_536).default(512),
  maxMemoryMb: z.number().int().min(64).max(65_536).default(2048),
  enabled: z.boolean().default(true),
});
export type UpsertServiceCatalog = z.infer<typeof UpsertServiceCatalogSchema>;



/* ---------- Miroir de registre d'images (services d'appui) ---------- */

const RegistryHostSchema = z
  .string()
  .trim()
  .min(3)
  .max(255)
  .regex(/^(https?:\/\/)?[a-z0-9.-]+(:\d+)?\/?$/i, 'Registre attendu, ex. docker.io ou ghcr.io');

export const RegistryMirrorSchema = z.object({
  /** Registre d'origine : docker.io, ghcr.io, quay.io… */
  registry: RegistryHostSchema,
  /** Préfixe sur le miroir : harbor.corp/dockerhub (hôte[:port][/chemin]). */
  prefix: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .regex(/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)*\/?$/i, 'Préfixe attendu, ex. harbor.corp/dockerhub'),
  username: z.string().max(255).optional(),
  /** Absent : mot de passe actuel conservé (pour ce registre d'origine). */
  password: z.string().max(4000).optional(),
});

export const RegistryMirrorConfigSchema = z.object({
  mirrors: z.array(RegistryMirrorSchema).max(20),
  fallbackToUpstream: z.boolean().default(false),
});
export type RegistryMirrorConfigInput = z.infer<typeof RegistryMirrorConfigSchema>;

export interface RegistryMirrorConfigDto {
  mirrors: Array<{ registry: string; prefix: string; username: string | null; passwordSet: boolean }>;
  fallbackToUpstream: boolean;
}
