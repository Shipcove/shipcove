import { z } from 'zod';

/* ---------- Skills ---------- */

export const SkillScopeSchema = z.enum(['global', 'personal']);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'nom de skill : minuscules, chiffres, tirets');

export const CreateSkillSchema = z.object({
  name: SkillNameSchema,
  description: z.string().min(1).max(1024),
  scope: SkillScopeSchema,
  /** Contenu de SKILL.md (frontmatter inclus) et fichiers annexes texte. */
  files: z
    .array(z.object({ path: z.string().min(1).max(256), content: z.string().max(500_000) }))
    .min(1)
    .max(50),
  source: z.string().max(500).optional(),
});
export type CreateSkill = z.infer<typeof CreateSkillSchema>;

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
  enabledForMe: boolean;
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
