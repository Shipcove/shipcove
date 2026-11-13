import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common.js';
import { users } from './iam.js';
import { teams } from './teams.js';

export const skills = pgTable(
  'skills',
  {
    id: pk(),
    name: text().notNull(),
    description: text().notNull(),
    scope: text({ enum: ['global', 'team', 'personal'] }).notNull(),
    teamId: uuid().references(() => teams.id, { onDelete: 'cascade' }),
    ownerId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    status: text({ enum: ['draft', 'pending_review', 'published', 'disabled', 'revoked'] }).notNull().default('draft'),
    source: text(),
    latestVersion: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('skills_scope_name_uq').on(
      t.scope,
      sql`coalesce(${t.teamId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(${t.ownerId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.name,
    ),
  ],
);

export const skillVersions = pgTable(
  'skill_versions',
  {
    id: pk(),
    skillId: uuid()
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    /** Fichiers (texte) du skill ; immuables par version. */
    files: jsonb().$type<Array<{ path: string; content: string }>>().notNull(),
    digest: text().notNull(),
    analysis: jsonb().$type<{ findings: string[]; scannedAt: string }>().notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('skill_versions_uq').on(t.skillId, t.version)],
);

/** Activation d'un skill pour un utilisateur ou une équipe. */
export const skillInstallations = pgTable(
  'skill_installations',
  {
    id: pk(),
    skillId: uuid()
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    scope: text({ enum: ['global', 'team', 'personal'] }).notNull(),
    subjectId: uuid(),
    pinnedVersion: integer(),
    enabled: boolean().notNull().default(true),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('skill_installations_uq').on(
      t.skillId,
      t.scope,
      sql`coalesce(${t.subjectId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
  ],
);

export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: pk(),
    name: text().notNull(),
    description: text().notNull().default(''),
    scope: text({ enum: ['global', 'team', 'personal'] }).notNull(),
    teamId: uuid().references(() => teams.id, { onDelete: 'cascade' }),
    ownerId: uuid().references(() => users.id, { onDelete: 'cascade' }),
    transport: text({ enum: ['stdio', 'streamable_http'] }).notNull(),
    url: text(),
    command: text(),
    args: jsonb().$type<string[]>().notNull().default([]),
    headers: jsonb().$type<Record<string, string>>().notNull().default({}),
    secretRef: text(),
    secretKeys: jsonb().$type<string[]>().notNull().default([]),
    version: text(),
    enabled: boolean().notNull().default(true),
    health: text({ enum: ['unknown', 'healthy', 'unhealthy'] }).notNull().default('unknown'),
    healthDetail: text(),
    lastHealthAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mcp_servers_scope_name_uq').on(
      t.scope,
      sql`coalesce(${t.teamId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(${t.ownerId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.name,
    ),
  ],
);

export const mcpTools = pgTable(
  'mcp_tools',
  {
    id: pk(),
    serverId: uuid()
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    description: text().notNull().default(''),
    inputSchema: jsonb(),
    discoveredAt: ts().notNull().defaultNow(),
  },
  (t) => [uniqueIndex('mcp_tools_uq').on(t.serverId, t.name)],
);

export const mcpInstallations = pgTable(
  'mcp_installations',
  {
    id: pk(),
    serverId: uuid()
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    scope: text({ enum: ['global', 'team', 'personal'] }).notNull(),
    subjectId: uuid(),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mcp_installations_uq').on(
      t.serverId,
      t.scope,
      sql`coalesce(${t.subjectId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
  ],
);

/**
 * Permissions par outil. Évaluation : un `deny` global l'emporte toujours ;
 * une portée inférieure ne peut que restreindre (jamais élargir) ce qui est fixé au-dessus.
 */
export const mcpPermissions = pgTable(
  'mcp_permissions',
  {
    id: pk(),
    serverId: uuid()
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    toolName: text().notNull(),
    scope: text({ enum: ['global', 'team', 'personal'] }).notNull(),
    subjectId: uuid(),
    effect: text({ enum: ['allow', 'deny'] }).notNull(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mcp_permissions_uq').on(
      t.serverId,
      t.toolName,
      t.scope,
      sql`coalesce(${t.subjectId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    index().on(t.serverId),
  ],
);
