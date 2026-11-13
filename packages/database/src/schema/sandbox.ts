import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common.js';
import { users } from './iam.js';
import { workspaces } from './workspaces.js';

/** Images officielles, versionnées et verrouillées par digest. */
export const sandboxImages = pgTable(
  'sandbox_images',
  {
    id: pk(),
    name: text().notNull(),
    version: text().notNull(),
    reference: text().notNull(),
    digest: text(),
    piVersion: text().notNull(),
    nodeVersion: text(),
    status: text({ enum: ['candidate', 'active', 'deprecated', 'revoked'] }).notNull().default('candidate'),
    isDefault: boolean().notNull().default(false),
    verifiedAt: ts(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('sandbox_images_name_version_uq').on(t.name, t.version),
    uniqueIndex('sandbox_images_one_default_uq').on(t.isDefault).where(sql`${t.isDefault}`),
  ],
);

export const sandboxInstances = pgTable(
  'sandbox_instances',
  {
    id: pk(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text({ enum: ['docker', 'kubernetes'] }).notNull(),
    externalId: text(),
    imageId: uuid().references(() => sandboxImages.id),
    status: text({ enum: ['creating', 'restoring', 'running', 'stopping', 'destroyed', 'failed'] })
      .notNull()
      .default('creating'),
    internalHost: text(),
    resources: jsonb().$type<{ cpu: number; memoryMb: number; diskMb: number; pidsLimit: number }>(),
    leaseToken: bigint({ mode: 'number' }),
    workerId: text(),
    lastActivityAt: ts().notNull().defaultNow(),
    createdAt: createdAt(),
    destroyedAt: ts(),
    destroyReason: text(),
  },
  (t) => [
    uniqueIndex('sandbox_instances_one_live_uq')
      .on(t.workspaceId)
      .where(sql`${t.status} in ('creating','restoring','running','stopping')`),
    index().on(t.status, t.lastActivityAt),
  ],
);

/** Lease d'écriture exclusif par workspace avec fencing token monotone. */
export const workspaceLeases = pgTable('workspace_leases', {
  workspaceId: uuid()
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  holder: text(),
  /** Incrémenté à chaque acquisition ; toute écriture durable le vérifie. */
  fencingToken: bigint({ mode: 'number' }).notNull().default(0),
  expiresAt: ts(),
  acquiredAt: ts(),
  updatedAt: updatedAt(),
});

export const workspaceSnapshots = pgTable(
  'workspace_snapshots',
  {
    id: pk(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    generation: integer().notNull(),
    parentGeneration: integer(),
    manifestKey: text().notNull(),
    manifestSha256: text().notNull(),
    fileCount: integer().notNull(),
    totalBytes: bigint({ mode: 'number' }).notNull(),
    changedFiles: integer().notNull(),
    bytesUploaded: bigint({ mode: 'number' }).notNull(),
    fencingToken: bigint({ mode: 'number' }).notNull(),
    reason: text().notNull(),
    /** Identifiant de l'événement d'écriture source (idempotence). */
    triggerKey: text(),
    status: text({ enum: ['validated', 'superseded', 'purged'] }).notNull().default('validated'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('workspace_snapshots_gen_uq').on(t.workspaceId, t.generation),
    uniqueIndex('workspace_snapshots_trigger_uq')
      .on(t.workspaceId, t.triggerKey)
      .where(sql`${t.triggerKey} is not null`),
  ],
);

export const checkpointJobs = pgTable(
  'checkpoint_jobs',
  {
    id: pk(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    triggerKey: text().notNull(),
    reason: text().notNull(),
    status: text({ enum: ['pending', 'running', 'succeeded', 'failed', 'skipped'] }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    resultGeneration: integer(),
    createdAt: createdAt(),
    finishedAt: ts(),
  },
  (t) => [uniqueIndex('checkpoint_jobs_trigger_uq').on(t.workspaceId, t.triggerKey), index().on(t.status)],
);

export const previewPorts = pgTable(
  'preview_ports',
  {
    id: pk(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    port: integer().notNull(),
    label: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    closedAt: ts(),
  },
  (t) => [
    uniqueIndex('preview_ports_open_uq')
      .on(t.workspaceId, t.port)
      .where(sql`${t.closedAt} is null`),
  ],
);
