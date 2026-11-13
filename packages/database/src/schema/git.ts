import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common.js';
import { gitConnections, users } from './iam.js';
import { repositories } from './teams.js';
import { workspaces } from './workspaces.js';

/**
 * Approbation à usage unique, liée à une action exacte.
 * Transitions : pending → approved → consumed | pending → rejected | pending → expired.
 */
export const gitApprovalRequests = pgTable(
  'git_approval_requests',
  {
    id: pk(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    requesterId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    requestedBy: text({ enum: ['agent', 'user'] }).notNull(),
    action: text({
      enum: ['push', 'create_pull_request', 'create_merge_request', 'merge', 'delete_remote_branch'],
    }).notNull(),
    repositoryId: uuid().references(() => repositories.id),
    gitConnectionId: uuid().references(() => gitConnections.id),
    /** Paramètres exacts (branches, titre, corps, numéro, méthode…). */
    params: jsonb().$type<Record<string, unknown>>().notNull(),
    target: text().notNull(),
    commitSha: text(),
    commits: jsonb().$type<Array<{ sha: string; subject: string; author: string }>>().notNull().default([]),
    diffStat: text(),
    patchPreview: text(),
    /** Empreinte SHA-256 de (action, dépôt, params, commitSha) : contrôlée à l'exécution. */
    actionDigest: text().notNull(),
    status: text({ enum: ['pending', 'approved', 'rejected', 'expired', 'consumed'] }).notNull().default('pending'),
    expiresAt: ts().notNull(),
    decidedAt: ts(),
    decidedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    decisionComment: text(),
    consumedAt: ts(),
    toolCallExternalId: text(),
    createdAt: createdAt(),
  },
  (t) => [index().on(t.workspaceId, t.status), index().on(t.status, t.expiresAt)],
);

export const gitOperations = pgTable(
  'git_operations',
  {
    id: pk(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    action: text().notNull(),
    approvalId: uuid().references(() => gitApprovalRequests.id),
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: text({ enum: ['pending', 'awaiting_approval', 'running', 'succeeded', 'failed', 'unknown', 'rejected'] })
      .notNull()
      .default('pending'),
    result: jsonb().$type<Record<string, unknown>>(),
    error: text(),
    attempts: jsonb().$type<Array<{ at: string; outcome: string }>>().notNull().default([]),
    idempotencyKey: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: ts(),
  },
  (t) => [
    index().on(t.workspaceId, t.createdAt),
    uniqueIndex('git_operations_approval_uq').on(t.approvalId).where(sql`${t.approvalId} is not null`),
    uniqueIndex('git_operations_idem_uq').on(t.workspaceId, t.idempotencyKey).where(sql`${t.idempotencyKey} is not null`),
  ],
);
