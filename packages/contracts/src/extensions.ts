import { z } from 'zod';

/* ---------- Skills ---------- */

export const SkillScopeSchema = z.enum(['global', 'personal']);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'nom de skill : minuscules, chiffres, tirets');

/** Limites d'un skill (fichiers markdown, taille, profondeur des dossiers). */
export const SKILL_LIMITS = {
  maxFiles: 300,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 5 * 1024 * 1024,
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

/** Un skill ne contient que des fichiers markdown (aucun script ni binaire). */
export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

export const SkillPathSchema = z
  .string()
  .min(1)
  .max(SKILL_LIMITS.maxPathLength)
  .refine(isSafeSkillPath, 'Chemin invalide (relatif, sans « .. », sans antislash)')
  .refine(isMarkdownPath, 'Seuls les fichiers markdown (.md) sont acceptés dans un skill');

/** Fichier markdown avec son contenu. */
export const SkillFileContentSchema = z.object({
  path: SkillPathSchema,
  content: z.string().max(SKILL_LIMITS.maxFileBytes),
});

/** Nouvelle version : fichier fourni, ou repris tel quel de la version actuelle (éventuellement renommé). */
export const SkillFileInputSchema = z.union([SkillFileContentSchema, z.object({ path: SkillPathSchema, sourcePath: z.string().min(1).max(SKILL_LIMITS.maxPathLength) })]);
export type SkillFileInput = z.infer<typeof SkillFileInputSchema>;

/** Fichier tel que stocké (les anciennes versions ont pu contenir d'autres champs, ignorés). */
export interface StoredSkillFile {
  path: string;
  content: string;
}

export const CreateSkillSchema = z.object({
  name: SkillNameSchema,
  /** Facultative : reprise du frontmatter de SKILL.md (champ `description`) si présent. */
  description: z.string().min(1).max(1024).optional(),
  categoryId: z.uuid().nullable().optional(),
  /** SKILL.md (frontmatter inclus) et fichiers markdown annexes, dossiers compris (« references/api.md »). */
  files: z.array(SkillFileContentSchema).min(1).max(SKILL_LIMITS.maxFiles),
  source: z.string().max(500).optional(),
});
export type CreateSkill = z.infer<typeof CreateSkillSchema>;

/** Enregistrement du contenu (remplace le contenu actuel ; fichiers inchangés repris par `sourcePath`). */
export const SaveSkillFilesSchema = z.object({
  files: z.array(SkillFileInputSchema).min(1).max(SKILL_LIMITS.maxFiles),
});
export type SaveSkillFiles = z.infer<typeof SaveSkillFilesSchema>;

export const UpdateSkillSchema = z.object({ categoryId: z.uuid().nullable() });

export interface SkillDto {
  id: string;
  name: string;
  description: string;
  scope: SkillScope;
  ownerId: string | null;
  /** `pending_review` : skill personnel en attente de validation (si l'administrateur l'impose). */
  status: 'pending_review' | 'published';
  digest: string;
  source: string | null;
  findings: string[];
  createdAt: string;
  updatedAt: string;
  /** Activé pour l'utilisateur : son choix, sinon le réglage par défaut de l'administrateur. */
  enabledForMe: boolean;
  /** Skill global : activé par défaut pour tous (réglage administrateur, chacun peut le changer pour soi). */
  enabledByDefault: boolean;
  fileCount: number;
  categoryId: string | null;
  /** L'utilisateur peut modifier ce skill (propriétaire, ou administrateur pour un skill global). */
  canManage: boolean;
}

export interface SkillFileDto {
  path: string;
  size: number;
  content: string;
}

export interface SkillDetailDto {
  skill: SkillDto;
  files: SkillFileDto[];
}

/* ---------- Catégories de skills (administrateur) ---------- */

export const UpsertSkillCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(''),
});
export type UpsertSkillCategory = z.infer<typeof UpsertSkillCategorySchema>;

export const ReorderSkillCategoriesSchema = z.object({ ids: z.array(z.uuid()).max(200) });

export interface SkillCategoryDto {
  id: string;
  name: string;
  description: string;
  position: number;
  skillCount: number;
}

/* ---------- MCP ---------- */

export const McpScopeSchema = z.enum(['global', 'personal']);
export type McpScope = z.infer<typeof McpScopeSchema>;

/**
 * Seul transport proposé : Streamable HTTP (les secrets restent côté plateforme). Le transport
 * stdio, qui lançait le serveur dans la sandbox avec ses secrets, n'est plus pris en charge.
 */
export const McpTransportSchema = z.literal('streamable_http');
/** Nom d'un serveur MCP : lettres (majuscules comprises), chiffres, - et _. */
export const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;

export const CreateMcpServerSchema = z.object({
  name: z.string().min(1).max(64).regex(MCP_SERVER_NAME),
  description: z.string().max(1000).default(''),
  scope: McpScopeSchema,
  transport: McpTransportSchema,
  url: z.url().max(2000),
  headers: z.record(z.string().max(200), z.string().max(4000)).default({}),
  /** En-têtes marqués secrets dans le formulaire : stockés dans Vault (en plus des noms sensibles de `headers`). */
  secretHeaders: z.record(z.string().max(200), z.string().max(4000)).default({}),
  version: z.string().max(100).optional(),
});
export type CreateMcpServer = z.infer<typeof CreateMcpServerSchema>;

/**
 * Modification d'un serveur. `headers` remplace tous les en-têtes publics ; `secretHeaders` /
 * `secretEnv` posent ou remplacent des secrets (les autres sont conservés) ; `removeSecrets` en retire
 * (noms tels que dans `secretKeys` : `header:Nom` ou `VARIABLE`).
 */
export const UpdateMcpServerSchema = z.object({
  enabled: z.boolean().optional(),
  description: z.string().max(1000).optional(),
  url: z.url().max(2000).optional(),
  headers: z.record(z.string().max(200), z.string().max(4000)).optional(),
  secretHeaders: z.record(z.string().max(200), z.string().max(4000)).optional(),
  removeSecrets: z.array(z.string().max(210)).max(100).optional(),
});
export type UpdateMcpServer = z.infer<typeof UpdateMcpServerSchema>;

/**
 * Test d'une configuration Streamable HTTP sans l'enregistrer. `serverId` : serveur en cours de
 * modification, dont les secrets enregistrés complètent ceux du formulaire.
 */
export const TestMcpServerSchema = z.object({
  scope: McpScopeSchema,
  url: z.url().max(2000),
  headers: z.record(z.string().max(200), z.string().max(4000)).default({}),
  secretHeaders: z.record(z.string().max(200), z.string().max(4000)).default({}),
  serverId: z.uuid().optional(),
});
export type TestMcpServer = z.infer<typeof TestMcpServerSchema>;

/** Résultat d'un test ou d'une découverte. */
export interface McpDiscoveryResult {
  ok: boolean;
  /** Nom et version annoncés par le serveur. */
  server?: string | null;
  tools?: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
  detail?: string;
}

/**
 * Outils décochés d'un serveur, enregistrés en une fois : ils deviennent des refus de la portée
 * (personnelle : pour soi ; globale : pour tous, administrateurs). Les autres règles de la portée
 * sont remplacées.
 */
export const McpSelectionSchema = z.object({
  scope: McpScopeSchema,
  denied: z.array(z.string().min(1).max(200)).max(500),
});

export interface McpServerDto {
  id: string;
  name: string;
  description: string;
  scope: McpScope;
  ownerId: string | null;
  /** `stdio` : ancien serveur, désactivé (transport retiré) ; à supprimer ou recréer en HTTP. */
  transport: 'stdio' | 'streamable_http';
  url: string | null;
  command: string | null;
  args: string[];
  /** En-têtes publics (non secrets), pour la modification ; masqués comme le reste de la configuration. */
  headers: Record<string, string>;
  secretKeys: string[];
  version: string | null;
  enabled: boolean;
  health: 'unknown' | 'healthy' | 'unhealthy';
  /** Détail du dernier contrôle (version annoncée, ou erreur). */
  healthDetail: string | null;
  lastHealthAt: string | null;
  tools: McpToolDto[];
}

export interface McpToolDto {
  id: string;
  name: string;
  description: string;
  /** Résultat effectif après héritage des politiques (global > personnel). */
  effective: 'allowed' | 'denied';
  /** Refusé par une règle globale : l'utilisateur ne peut pas l'autoriser pour lui. */
  lockedByAdmin: boolean;
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
