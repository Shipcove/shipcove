import { boolean, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, updatedAt } from './_common.js';
import { users } from './iam.js';

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
    /** Image de sandbox des conversations sur ce dépôt (parmi les images actives ; sinon : défaut). */
    sandboxImageId: uuid(),
    /** Script de préparation exécuté dans la sandbox (dépendances, outils) ; rejoué s'il change. */
    setupScript: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('repositories_host_name_uq').on(t.host, t.fullName)],
);

/**
 * Variables d'environnement d'un dépôt, injectées dans les sandboxes de toutes les conversations sur
 * ce dépôt (processus de Pi et ses commandes). Les secrets sont dans Vault (`secretRef`), jamais
 * relus par l'interface.
 */
export const environmentVariables = pgTable(
  'environment_variables',
  {
    id: pk(),
    scope: text({ enum: ['repository'] }).notNull().default('repository'),
    subjectId: uuid().notNull(),
    name: text().notNull(),
    secret: boolean().notNull().default(false),
    /** Valeur en clair (variables non secrètes uniquement). */
    value: text(),
    secretRef: text(),
    createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('environment_variables_uq').on(t.scope, t.subjectId, t.name), index().on(t.subjectId)],
);

