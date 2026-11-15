import { z } from 'zod';

/* ---------- Skills ---------- */

export const SkillScopeSchema = z.enum(['global', 'personal']);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'nom de skill : minuscules, chiffres, tirets');

/** Limites d'un skill (fichiers, taille, profondeur des dossiers). */
export const SKILL_LIMITS = {
  maxFiles: 300,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
  maxPathLength: 256,
  maxDepth: 8,
} as const;

/**
 * Chemin relatif sûr dans un skill (« references/api/guide.md ») : ni absolu, ni « .. », ni
 * antislash, ni segment vide, ni caractère de contrôle, ni dossier `.git`.
 */
export function isSafeSkillPath(p: string): boolean {
  if (!p || p.length > SKILL_LIMITS.maxPathLength || p.startsWith('/') || p.includes('\\')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return false;
  const parts = p.split('/');
  if (parts.length > SKILL_LIMITS.maxDepth) return false;
  return parts.every((s) => s.length > 0 && s.length <= 100 && s !== '.' && s !== '..' && s.toLowerCase() !== '.git');
}

export const SkillPathSchema = z.string().min(1).max(SKILL_LIMITS.maxPathLength).refine(isSafeSkillPath, 'Chemin invalide (relatif, sans « .. », sans antislash)');

/** Fichier avec son contenu : texte (utf8) ou binaire (base64). */
export const SkillFileContentSchema = z.object({
  path: SkillPathSchema,
  content: z.string().max(Math.ceil((SKILL_LIMITS.maxFileBytes * 4) / 3) + 4),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  executable: z.boolean().optional(),
});

/** Nouvelle version : fichier fourni, ou repris tel quel de la version actuelle (éventuellement renommé). */
export const SkillFileInputSchema = z.union([
  SkillFileContentSchema,
  z.object({ path: SkillPathSchema, sourcePath: SkillPathSchema, executable: z.boolean().optional() }),
]);
export type SkillFileInput = z.infer<typeof SkillFileInputSchema>;

/** Fichier tel que stocké (le texte n'a pas d'encodage explicite). */
export interface StoredSkillFile {
  path: string;
  content: string;
  encoding?: 'base64';
  executable?: boolean;
}

export const CreateSkillSchema = z.object({
  name: SkillNameSchema,
  /** Facultative : reprise du frontmatter de SKILL.md (champ `description`) si présent. */
  description: z.string().min(1).max(1024).optional(),
  scope: SkillScopeSchema,
  /** SKILL.md (frontmatter inclus) et fichiers annexes, dossiers compris (« scripts/build.sh »). */
  files: z.array(SkillFileContentSchema).min(1).max(SKILL_LIMITS.maxFiles),
  source: z.string().max(500).optional(),
});
export type CreateSkill = z.infer<typeof CreateSkillSchema>;

export const NewSkillVersionSchema = z.object({
  description: z.string().min(1).max(1024).optional(),
  files: z.array(SkillFileInputSchema).min(1).max(SKILL_LIMITS.maxFiles),
});
export type NewSkillVersion = z.infer<typeof NewSkillVersionSchema>;

export interface SkillDto {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  ownerId: string | null;
  status: 'draft' | 'pending_review' | 'published' | 'disabled' | 'revoked';
  latestVersion: number;
  digest: string;
  source: string | null;
  findings: string[];
  createdAt: string;
  updatedAt: string;
  enabledForMe: boolean;
  fileCount: number;
  /** L'utilisateur peut modifier ce skill (propriétaire, ou administrateur pour un skill global). */
  canManage: boolean;
}

export interface SkillFileDto {
  path: string;
  size: number;
  encoding: 'utf8' | 'base64';
  executable: boolean;
  /** Texte, ou base64 pour un fichier binaire. */
  content: string;
}

export interface SkillDetailDto {
  skill: SkillDto;
  version: number;
  files: SkillFileDto[];
  versions: Array<{ version: number; digest: string; findings: string[]; createdAt: string; fileCount: number }>;
}

/* ---------- MCP ---------- */

export const McpScopeSchema = z.enum(['global', 'personal']);
export type McpScope = z.infer<typeof McpScopeSchema>;

export const McpTransportSchema = z.enum(['stdio', 'streamable_http']);

export const CreateMcpServerSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/),
  description: z.string().max(1000).default(''),
  scope: McpScopeSchema,
  transport: McpTransportSchema,
  url: z.url().max(2000).optional(),
  command: z.string().max(500).optional(),
  args: z.array(z.string().max(500)).max(50).default([]),
  /** Variables / en-têtes sensibles : stockés dans Vault. */
  secretEnv: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4000)).default({}),
  headers: z.record(z.string().max(200), z.string().max(4000)).default({}),
  version: z.string().max(100).optional(),
});
export type CreateMcpServer = z.infer<typeof CreateMcpServerSchema>;

export interface McpServerDto {
  id: string;
  name: string;
  description: string;
  scope: McpScope;
  ownerId: string | null;
  transport: 'stdio' | 'streamable_http';
  url: string | null;
  command: string | null;
  args: string[];
  secretKeys: string[];
  version: string | null;
  enabled: boolean;
  health: 'unknown' | 'healthy' | 'unhealthy';
  lastHealthAt: string | null;
  tools: McpToolDto[];
}

export interface McpToolDto {
  id: string;
  name: string;
  description: string;
  /** Résultat effectif après héritage des politiques (global > personnel). */
  effective: 'allowed' | 'denied';
}

export const McpPermissionSchema = z.object({
  toolName: z.string().min(1).max(200),
  scope: McpScopeSchema,
  effect: z.enum(['allow', 'deny']),
});

/* ---------- Notifications ---------- */

export const NotificationTypes = [
  'run.completed',
  'run.failed',
  'approval.required',
  'quota.reached',
  'quota.available',
  'checkpoint.failed',
  'invitation',
  'security',
] as const;
export type NotificationType = (typeof NotificationTypes)[number];

export interface NotificationDto {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export const NotificationPreferenceSchema = z.object({
  type: z.enum(NotificationTypes),
  inApp: z.boolean(),
  email: z.boolean(),
});
export interface NotificationPreferenceDto {
  type: NotificationType;
  inApp: boolean;
  email: boolean;
  /** Imposé par la politique globale (non modifiable). */
  locked: boolean;
}
