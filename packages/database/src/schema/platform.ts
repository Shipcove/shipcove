import { sql } from 'drizzle-orm';
import { bigserial, boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common.js';
import { users } from './iam.js';

/** Paramètres plateforme versionnés (une ligne active par section). */
export const platformSettings = pgTable(
  'platform_settings',
  {
    id: pk(),
    section: text().notNull(),
    values: jsonb().$type<Record<string, unknown>>().notNull(),
    version: integer().notNull(),
    active: boolean().notNull().default(true),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('platform_settings_section_version_uq').on(t.section, t.version),
    uniqueIndex('platform_settings_active_uq').on(t.section).where(sql`${t.active}`),
  ],
);

/** Références de secrets techniques (SMTP, LiteLLM…) : métadonnées, jamais la valeur. */
export const secretRefs = pgTable('secret_refs', {
  name: text().primaryKey(),
  ref: text().notNull(),
  description: text(),
  rotatedAt: ts(),
  updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

export const notifications = pgTable(
  'notifications',
  {
    id: pk(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    title: text().notNull(),
    body: text().notNull(),
    link: text(),
    dedupeKey: text(),
    readAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    index().on(t.userId, t.createdAt),
    uniqueIndex('notifications_dedupe_uq').on(t.userId, t.dedupeKey).where(sql`${t.dedupeKey} is not null`),
  ],
);

export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    inApp: boolean().notNull().default(true),
    email: boolean().notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.type] })],
);

export const emailTemplates = pgTable(
  'email_templates',
  {
    key: text().notNull(),
    locale: text().notNull().default('fr'),
    subject: text().notNull(),
    bodyText: text().notNull(),
    bodyHtml: text(),
    version: integer().notNull().default(1),
    updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.key, t.locale] })],
);

export const emailDeliveries = pgTable(
  'email_deliveries',
  {
    id: pk(),
    idempotencyKey: text().notNull(),
    userId: uuid().references(() => users.id, { onDelete: 'set null' }),
    toAddress: text().notNull(),
    template: text().notNull(),
    subject: text().notNull(),
    status: text({ enum: ['pending', 'sending', 'sent', 'failed', 'dead'] }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    providerMessageId: text(),
    createdAt: createdAt(),
    sentAt: ts(),
  },
  (t) => [uniqueIndex('email_deliveries_idem_uq').on(t.idempotencyKey), index().on(t.status)],
);

export const retentionPolicies = pgTable('retention_policies', {
  dataType: text().primaryKey(),
  retentionDays: integer(),
  legalHold: boolean().notNull().default(false),
  updatedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  updatedAt: updatedAt(),
});

export const deletionJobs = pgTable(
  'deletion_jobs',
  {
    id: pk(),
    kind: text({ enum: ['retention_purge', 'user_deletion', 'workspace_deletion', 'project_deletion'] }).notNull(),
    targetType: text(),
    targetId: text(),
    dataType: text(),
    status: text({ enum: ['pending', 'running', 'succeeded', 'failed', 'blocked'] }).notNull().default('pending'),
    stats: jsonb().$type<Record<string, number>>().notNull().default({}),
    error: text(),
    requestedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    finishedAt: ts(),
  },
  (t) => [index().on(t.status)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: pk(),
    occurredAt: ts().notNull().defaultNow(),
    actorId: uuid(),
    actorLabel: text(),
    action: text().notNull(),
    targetType: text(),
    targetId: text(),
    outcome: text({ enum: ['success', 'failure'] }).notNull().default('success'),
    ip: text(),
    userAgent: text(),
    correlationId: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index().on(t.occurredAt), index().on(t.actorId, t.occurredAt), index().on(t.action, t.occurredAt), index().on(t.targetId)],
);

/** Outbox transactionnelle : publiée par le worker (au moins une fois, consommateurs idempotents). */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    topic: text().notNull(),
    payload: jsonb().notNull(),
    createdAt: createdAt(),
    publishedAt: ts(),
  },
  (t) => [index('outbox_unpublished_idx').on(t.id).where(sql`${t.publishedAt} is null`)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    key: text().notNull(),
    userId: uuid().notNull(),
    route: text().notNull(),
    requestHash: text().notNull(),
    status: text({ enum: ['in_progress', 'completed'] }).notNull().default('in_progress'),
    responseStatus: integer(),
    responseBody: jsonb(),
    createdAt: createdAt(),
    expiresAt: ts().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] }), index().on(t.expiresAt)],
);

/** File de jobs durable (SKIP LOCKED), retries avec backoff, idempotence par `dedupeKey`. */
export const jobs = pgTable(
  'jobs',
  {
    id: pk(),
    queue: text().notNull(),
    payload: jsonb().notNull(),
    dedupeKey: text(),
    status: text({ enum: ['pending', 'running', 'succeeded', 'failed', 'dead', 'cancelled'] }).notNull().default('pending'),
    priority: integer().notNull().default(0),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(8),
    runAt: ts().notNull().defaultNow(),
    lockedBy: text(),
    lockedUntil: ts(),
    lastError: text(),
    /** Résultat d'un job « RPC » attendu par l'API (opérations exécutées dans la sandbox). */
    result: jsonb(),
    createdAt: createdAt(),
    finishedAt: ts(),
  },
  (t) => [
    index('jobs_ready_idx').on(t.queue, t.runAt).where(sql`${t.status} = 'pending'`),
    index('jobs_running_idx').on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    uniqueIndex('jobs_dedupe_uq')
      .on(t.queue, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.status} in ('pending','running')`),
  ],
);

/** Présence des instances (worker / api / gateway) pour la supervision et la reprise. */
export const serviceInstances = pgTable('service_instances', {
  id: text().primaryKey(),
  kind: text().notNull(),
  hostname: text(),
  version: text(),
  startedAt: ts().notNull().defaultNow(),
  heartbeatAt: ts().notNull().defaultNow(),
});
