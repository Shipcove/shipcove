import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common.js';
import { users } from './iam.js';
import { teams } from './teams.js';

/** Montants de crédits : décimal exact, 8 décimales. */
const credits = () => numeric({ precision: 20, scale: 8 });

export const llmModels = pgTable(
  'llm_models',
  {
    id: pk(),
    litellmModel: text().notNull(),
    displayName: text().notNull(),
    provider: text().notNull(),
    litellmParams: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    secretRef: text(),
    contextWindow: integer().notNull(),
    maxOutputTokens: integer().notNull(),
    supportsImages: boolean().notNull().default(false),
    supportsReasoning: boolean().notNull().default(false),
    enabled: boolean().notNull().default(true),
    isDefault: boolean().notNull().default(false),
    allowedTeamIds: jsonb().$type<string[]>().notNull().default([]),
    available: boolean().notNull().default(true),
    lastSyncAt: ts(),
    lastSyncError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts(),
  },
  (t) => [
    uniqueIndex('llm_models_litellm_uq').on(t.litellmModel).where(sql`${t.deletedAt} is null`),
    uniqueIndex('llm_models_one_default_uq').on(t.isDefault).where(sql`${t.isDefault} and ${t.deletedAt} is null`),
  ],
);

/**
 * Coefficients versionnés en **crédits pour 1 000 tokens**.
 * Une nouvelle version ne modifie jamais les consommations passées (le ledger référence la version).
 */
export const modelCoefficients = pgTable(
  'model_coefficients',
  {
    id: pk(),
    modelId: uuid()
      .notNull()
      .references(() => llmModels.id, { onDelete: 'restrict' }),
    version: integer().notNull(),
    input: credits().notNull(),
    output: credits().notNull(),
    cacheRead: credits().notNull(),
    cacheWrite: credits().notNull(),
    effectiveFrom: ts().notNull().defaultNow(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('model_coefficients_version_uq').on(t.modelId, t.version)],
);

export const quotaPolicies = pgTable(
  'quota_policies',
  {
    id: pk(),
    scope: text({ enum: ['global_user_default', 'user', 'team'] }).notNull(),
    subjectId: uuid(),
    limit5h: credits(),
    limit7d: credits(),
    exempt: boolean().notNull().default(false),
    version: integer().notNull().default(1),
    active: boolean().notNull().default(true),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('quota_policies_active_uq')
      .on(t.scope, sql`coalesce(${t.subjectId}, '00000000-0000-0000-0000-000000000000'::uuid)`)
      .where(sql`${t.active}`),
  ],
);

/** Lignes de verrouillage (SELECT … FOR UPDATE) pour sérialiser les réservations par sujet. */
export const quotaLocks = pgTable('quota_locks', {
  subjectKey: text().primaryKey(),
  updatedAt: updatedAt(),
});

export const llmRequests = pgTable(
  'llm_requests',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    teamId: uuid().references(() => teams.id, { onDelete: 'restrict' }),
    workspaceId: uuid(),
    runId: uuid(),
    modelId: uuid().references(() => llmModels.id),
    litellmModel: text().notNull(),
    coefficientId: uuid().references(() => modelCoefficients.id),
    status: text({ enum: ['reserved', 'streaming', 'settled', 'failed', 'pending_reconciliation', 'rejected'] })
      .notNull()
      .default('reserved'),
    litellmCallId: text(),
    inputTokens: integer(),
    outputTokens: integer(),
    cacheReadTokens: integer(),
    cacheWriteTokens: integer(),
    credits: credits(),
    providerCostUsd: numeric({ precision: 20, scale: 10 }),
    estimated: boolean().notNull().default(false),
    latencyMs: integer(),
    httpStatus: integer(),
    error: text(),
    createdAt: createdAt(),
    settledAt: ts(),
  },
  (t) => [index().on(t.userId, t.createdAt), index().on(t.status), index().on(t.runId)],
);

export const creditReservations = pgTable(
  'credit_reservations',
  {
    id: pk(),
    llmRequestId: uuid()
      .notNull()
      .references(() => llmRequests.id, { onDelete: 'cascade' }),
    userId: uuid().notNull(),
    teamId: uuid(),
    amount: credits().notNull(),
    status: text({ enum: ['open', 'settled', 'released', 'expired'] }).notNull().default('open'),
    expiresAt: ts().notNull(),
    createdAt: createdAt(),
    closedAt: ts(),
  },
  (t) => [
    uniqueIndex('credit_reservations_request_uq').on(t.llmRequestId),
    index('credit_reservations_open_user_idx').on(t.userId).where(sql`${t.status} = 'open'`),
    index('credit_reservations_open_team_idx').on(t.teamId).where(sql`${t.status} = 'open'`),
  ],
);

/**
 * Ledger immuable et idempotent (trigger SQL interdisant UPDATE/DELETE hors purge contrôlée).
 * Montant positif = débit ; négatif = crédit (ajustement).
 */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: pk(),
    idempotencyKey: text().notNull(),
    userId: uuid().notNull(),
    teamId: uuid(),
    kind: text({ enum: ['usage', 'adjustment', 'reconciliation'] }).notNull(),
    amount: credits().notNull(),
    llmRequestId: uuid(),
    coefficientId: uuid(),
    inputTokens: integer(),
    outputTokens: integer(),
    cacheReadTokens: integer(),
    cacheWriteTokens: integer(),
    estimated: boolean().notNull().default(false),
    reason: text(),
    createdBy: uuid(),
    occurredAt: ts().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('credit_ledger_idem_uq').on(t.idempotencyKey),
    index().on(t.userId, t.occurredAt),
    index().on(t.teamId, t.occurredAt),
  ],
);

/** Jetons de run : authentifient Pi auprès de la gateway LLM (hachés). */
export const runTokens = pgTable(
  'run_tokens',
  {
    id: pk(),
    tokenHash: text().notNull(),
    workspaceId: uuid().notNull(),
    userId: uuid().notNull(),
    teamId: uuid().notNull(),
    sandboxInstanceId: uuid(),
    expiresAt: ts().notNull(),
    revokedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('run_tokens_hash_uq').on(t.tokenHash), index().on(t.workspaceId)],
);
