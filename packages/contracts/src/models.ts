import { z } from 'zod';
import { DecimalStringSchema } from './common.js';

export interface ModelDto {
  id: string;
  /** Nom du modèle côté LiteLLM (`model_name`). */
  litellmModel: string;
  displayName: string;
  provider: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  supportsReasoning: boolean;
  enabled: boolean;
  isDefault: boolean;
  available: boolean;
  /** Coefficients actifs, en crédits pour 1 000 tokens. */
  coefficients: CoefficientsDto | null;
}

export interface CoefficientsDto {
  version: number;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  effectiveFrom: string;
}

export const CoefficientsInputSchema = z.object({
  input: DecimalStringSchema,
  output: DecimalStringSchema,
  cacheRead: DecimalStringSchema,
  cacheWrite: DecimalStringSchema,
});

/**
 * Réglages d'un modèle découvert dans LiteLLM (la déclaration des modèles se fait dans LiteLLM).
 * `allowedUserIds` vide : modèle accessible à tous les utilisateurs.
 */
export const UpdateModelSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  contextWindow: z.number().int().min(1024).max(10_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(1_000_000).optional(),
  supportsImages: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  enabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  allowedUserIds: z.array(z.uuid()).max(1000).optional(),
  coefficients: CoefficientsInputSchema.optional(),
});
export type UpdateModel = z.infer<typeof UpdateModelSchema>;

/** Modèle vu par l'administration. */
export interface AdminModelDto extends ModelDto {
  allowedUsers: Array<{ id: string; displayName: string; username: string }>;
  lastSyncAt: string | null;
  lastSyncError: string | null;
}

/** Connexion à LiteLLM (URL et clé maître, stockées dans Vault ; la clé n'est jamais renvoyée). */
export const LiteLlmConnectionSchema = z.object({
  url: z.url().max(500).refine((u) => /^https?:\/\//.test(u), 'URL http(s) attendue'),
  /** Clé maître (ou clé virtuelle d'administration) ; absente = clé actuelle conservée. */
  masterKey: z.string().min(1).max(4000).optional(),
});
export type LiteLlmConnection = z.infer<typeof LiteLlmConnectionSchema>;

export interface LiteLlmConnectionDto {
  url: string;
  /** `admin` : réglée dans l'interface ; `env` : valeur de déploiement (LITELLM_URL). */
  source: 'admin' | 'env';
  keyConfigured: boolean;
}

export interface LiteLlmSyncResultDto {
  discovered: number;
  added: string[];
  missing: string[];
}

/* ---------- Consommation & quotas ---------- */

/** Fenêtre de quota en crédits : usage interne et administration uniquement (jamais exposé aux utilisateurs). */
export interface WindowUsageDto {
  window: '5h' | '7d';
  used: string;
  reserved: string;
  limit: string | null;
  remaining: string | null;
  exempt: boolean;
  resetsAt: string | null;
}

/** Fenêtre de quota telle que vue par un utilisateur : pourcentage uniquement. */
export interface QuotaWindowDto {
  window: '5h' | '7d';
  /** Part consommée (réservations incluses), 0–100 ; `null` si la fenêtre est sans limite ou exemptée. */
  percent: number | null;
  resetsAt: string | null;
}

export function toQuotaWindow(w: WindowUsageDto): QuotaWindowDto {
  const limit = w.limit === null ? null : Number(w.limit);
  const percent = w.exempt || limit === null || limit <= 0 ? null : Math.min(100, Math.round(((Number(w.used) + Number(w.reserved)) / limit) * 100));
  return { window: w.window, percent, resetsAt: percent === null ? null : w.resetsAt };
}

/** Quotas personnels uniquement (aucun plafond d'équipe). */
export interface UsageSummaryDto {
  user: { windows: QuotaWindowDto[] };
  quotasEnabled: boolean;
}

/** Répartition relative de la consommation (parts en %, sans valeur absolue). */
export interface UsageBreakdownDto {
  days: number;
  byModel: Array<{ model: string; requests: number; percent: number }>;
  byWorkspace: Array<{ workspaceId: string | null; name: string | null; requests: number; percent: number }>;
}

/** Requête LLM vue par l'utilisateur : ni tokens, ni crédits, ni coût. */
export interface UsageRequestDto {
  id: string;
  workspaceId: string | null;
  runId: string | null;
  model: string;
  status: 'in_progress' | 'completed' | 'failed' | 'rejected';
  latencyMs: number | null;
  createdAt: string;
}

/** Détail complet d'une requête LLM (administration). */
export interface LlmRequestDto {
  id: string;
  workspaceId: string | null;
  runId: string | null;
  model: string;
  status: 'reserved' | 'streaming' | 'settled' | 'failed' | 'pending_reconciliation';
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  credits: string | null;
  providerCostUsd: string | null;
  latencyMs: number | null;
  estimated: boolean;
  createdAt: string;
}

export const QuotaPolicyInputSchema = z.object({
  /** Quotas personnels : limite par défaut pour tous, ou propre à un utilisateur. */
  scope: z.enum(['global_user_default', 'user']),
  subjectId: z.uuid().nullable().default(null),
  limit5h: DecimalStringSchema.nullable(),
  limit7d: DecimalStringSchema.nullable(),
  exempt: z.boolean().default(false),
});
export type QuotaPolicyInput = z.infer<typeof QuotaPolicyInputSchema>;

export const CreditAdjustmentSchema = z.object({
  userId: z.uuid(),
  /** Négatif = crédit rendu, positif = débit. */
  amount: DecimalStringSchema,
  reason: z.string().min(3).max(500),
});
