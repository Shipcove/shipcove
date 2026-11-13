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
