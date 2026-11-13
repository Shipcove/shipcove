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

export const UpsertModelSchema = z.object({
  litellmModel: z.string().min(1).max(200).regex(/^[\w.:/@-]+$/),
  displayName: z.string().min(1).max(120),
  /** Paramètres LiteLLM (`litellm_params`) hors secrets, ex. `{ "model": "anthropic/claude-x" }`. */
  litellmParams: z.record(z.string(), z.unknown()).default({}),
  /** Clé provider : écrite dans Vault, jamais relue. */
  apiKey: z.string().min(1).max(4000).optional(),
  contextWindow: z.number().int().min(1024).max(10_000_000),
  maxOutputTokens: z.number().int().min(1).max(1_000_000),
  supportsImages: z.boolean().default(false),
  supportsReasoning: z.boolean().default(false),
  enabled: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  /** Restriction facultative à des équipes (vide = toutes). */
  allowedTeamIds: z.array(z.uuid()).default([]),
  coefficients: CoefficientsInputSchema,
});
export type UpsertModel = z.infer<typeof UpsertModelSchema>;

/* ---------- Consommation & quotas ---------- */

export interface WindowUsageDto {
  window: '5h' | '7d';
  used: string;
  reserved: string;
  limit: string | null;
  remaining: string | null;
  exempt: boolean;
  resetsAt: string | null;
}

export interface UsageSummaryDto {
  user: { windows: WindowUsageDto[] };
  teams: Array<{ teamId: string; teamName: string; windows: WindowUsageDto[] }>;
  quotasEnabled: boolean;
}

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
  scope: z.enum(['global_user_default', 'user', 'team']),
  subjectId: z.uuid().nullable().default(null),
  limit5h: DecimalStringSchema.nullable(),
  limit7d: DecimalStringSchema.nullable(),
  exempt: z.boolean().default(false),
});
export type QuotaPolicyInput = z.infer<typeof QuotaPolicyInputSchema>;

export const CreditAdjustmentSchema = z.object({
  userId: z.uuid(),
  teamId: z.uuid().nullable().default(null),
  /** Négatif = crédit rendu, positif = débit. */
  amount: DecimalStringSchema,
  reason: z.string().min(3).max(500),
});
