import { sql } from 'drizzle-orm';
import { index, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common.js';
import { gitConnections, users } from './iam.js';

export const teams = pgTable(
  'teams',
  {
    id: pk(),
    name: text().notNull(),
    slug: text().notNull(),
    description: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts(),
  },
  (t) => [uniqueIndex('teams_slug_uq').on(t.slug)],
);

export const teamMembers = pgTable(
  'team_members',
  {
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text({ enum: ['team_admin', 'member'] }).notNull().default('member'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] }), index().on(t.userId)],
);

export const repositories = pgTable(
  'repositories',
  {
    id: pk(),
    provider: text({ enum: ['github', 'github_enterprise', 'gitlab', 'gitlab_self_managed'] }).notNull(),
    host: text().notNull(),
    fullName: text().notNull(),
    externalId: text(),
    cloneUrl: text().notNull(),
    webUrl: text().notNull(),
    defaultBranch: text().notNull().default('main'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('repositories_host_name_uq').on(t.host, t.fullName)],
);

export const projects = pgTable(
  'projects',
  {
    id: pk(),
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    name: text().notNull(),
    description: text(),
    repositoryId: uuid().references(() => repositories.id, { onDelete: 'set null' }),
    /** Connexion Git ayant servi à rattacher le dépôt (lecture par défaut). */
    defaultGitConnectionId: uuid().references(() => gitConnections.id, { onDelete: 'set null' }),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts(),
    deletedAt: ts(),
  },
  (t) => [index().on(t.teamId), uniqueIndex('projects_team_name_uq').on(t.teamId, sql`lower(${t.name})`).where(sql`${t.deletedAt} is null`)],
);

/**
 * Rôles explicites sur un projet (en plus de l'appartenance à l'équipe, qui donne `member`).
 * `viewer` : peut voir le projet sans créer de workspace.
 */
export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid()
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text({ enum: ['maintainer', 'member', 'viewer'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);
