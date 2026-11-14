import { z } from 'zod';

export const GitProviderKindSchema = z.enum(['github', 'github_enterprise', 'gitlab', 'gitlab_self_managed']);
export type GitProviderKind = z.infer<typeof GitProviderKindSchema>;

export const RepositoryRefSchema = z.object({
  /** Connexion Git de l'utilisateur utilisée pour lire le dépôt. */
  gitConnectionId: z.uuid(),
  /** `owner/name` (GitHub) ou chemin complet du projet (GitLab). */
  fullName: z.string().min(1).max(400),
  defaultBranch: z.string().min(1).max(255).optional(),
});
export type RepositoryRef = z.infer<typeof RepositoryRefSchema>;

export const CreateProjectSchema = z.object({
  teamId: z.uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(4000).optional(),
  /** Absent = projet vierge sans dépôt. */
  repository: RepositoryRefSchema.optional(),
});
export type CreateProject = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(4000).nullable().optional(),
});

export const AttachRepositorySchema = RepositoryRefSchema;

export interface RepositoryDto {
  id: string;
  provider: GitProviderKind;
  host: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  webUrl: string;
}

export interface ProjectDto {
  id: string;
  teamId: string;
  teamName: string;
  name: string;
  description: string | null;
  repository: RepositoryDto | null;
  createdBy: string;
  createdAt: string;
  archivedAt: string | null;
  myWorkspaceCount: number;
}

/* ---------- Environnement des sandboxes : variables, secrets, image, préparation ---------- */

/**
 * Noms réservés : ils piloteraient le réseau, le chargement de code ou l'identité de la sandbox
 * (proxy de sortie, CA, préchargement de bibliothèques, configuration Git/Pi de la plateforme).
 */
const RESERVED_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|HOSTNAME|TERM|BASH_ENV|ENV|PROMPT_COMMAND|IFS|(HTTPS?|ALL|NO|FTP)_PROXY|NODE_EXTRA_CA_CERTS|SSL_CERT_(FILE|DIR)|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|GIT_(ASKPASS|SSH|SSH_COMMAND|CONFIG.*|PROXY_COMMAND|EXEC_PATH|DIR|WORK_TREE)|(LD|DYLD|CAP|PI)_.*)$/i;

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
  scope: 'team' | 'project';
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

export interface ProjectEnvironmentDto {
  sandboxImageId: string | null;
  setupScript: string | null;
  images: SandboxImageOptionDto[];
  /** Variables du projet (modifiables par ses administrateurs). */
  variables: EnvVarDto[];
  /** Variables héritées de l'équipe (lecture ; une variable de projet du même nom l'emporte). */
  teamVariables: EnvVarDto[];
  canManage: boolean;
}

export const UpdateProjectEnvironmentSchema = z.object({
  sandboxImageId: z.uuid().nullable(),
  setupScript: z.string().max(20_000).nullable(),
});
export type UpdateProjectEnvironment = z.infer<typeof UpdateProjectEnvironmentSchema>;
