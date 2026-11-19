import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, pk, ts, updatedAt } from './_common.js';
import { gitConnections, users } from './iam.js';
import { repositories } from './repositories.js';

export const workspaces = pgTable(
  'workspaces',
  {
    id: pk(),
    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Dépôt Git associé à la conversation (facultatif). */
    repositoryId: uuid().references(() => repositories.id, { onDelete: 'set null' }),
    /** Connexion Git du propriétaire utilisée pour ce dépôt. */
    gitConnectionId: uuid().references(() => gitConnections.id, { onDelete: 'set null' }),
    /** Titre de la conversation. */
    name: text().notNull(),
    /** `auto` : titre généré (remplaçable) ; `user` : choisi par l'utilisateur. */
    titleSource: text({ enum: ['auto', 'user'] }).notNull().default('auto'),
    status: text({ enum: ['ready', 'starting', 'running', 'stopping', 'archived', 'error'] })
      .notNull()
      .default('ready'),
    statusDetail: text(),
    syncState: text({ enum: ['synced', 'syncing', 'unsynced'] }).notNull().default('synced'),
    branch: text(),
    modelId: uuid(),
    /** Niveau de raisonnement de Pi (« effort ») pour les modèles qui le supportent. */
    thinkingLevel: text({ enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] }).notNull().default('medium'),
    /** Mode d'exécution : autonome (défaut) ou plan (outils en lecture seule). */
    agentMode: text({ enum: ['autonomous', 'plan'] }).notNull().default('autonomous'),
    /** Empreinte du script de préparation déjà exécuté avec succès (rejoué s'il change). */
    setupHash: text(),
    setupStatus: text({ enum: ['none', 'running', 'succeeded', 'failed'] }).notNull().default('none'),
    /** Instance de sandbox ayant exécuté la préparation (rejouée dans chaque nouvelle sandbox). */
    setupInstanceId: uuid(),
    setupAt: ts(),
    /** Initialisé (clone ou répertoire vierge) au moins une fois. */
    initialized: boolean().notNull().default(false),
    /** Dernier manifeste validé (génération) ; publication conditionnée au fencing token. */
    currentSnapshotId: uuid(),
    currentGeneration: integer().notNull().default(0),
    /** Génération de référence pour le panneau « depuis le début de la conversation ». */
    baselineGeneration: integer(),
    /** Séquence monotone des événements SSE du workspace. */
    lastEventSeq: bigint({ mode: 'number' }).notNull().default(0),
    lastActivityAt: ts(),
    lastCheckpointAt: ts(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    archivedAt: ts(),
    deletedAt: ts(),
  },
  (t) => [index().on(t.ownerId), index().on(t.repositoryId), index().on(t.status)],
);

/** Une seule conversation par workspace (contrainte d'unicité). */
export const conversations = pgTable(
  'conversations',
  {
    id: pk(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Chemin du fichier de session Pi dans `/workspace-state`. */
    piSessionPath: text(),
    contextTokens: integer(),
    contextWindow: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: ts(),
  },
  (t) => [uniqueIndex('conversations_workspace_uq').on(t.workspaceId)],
);

/** Partage nominatif avec un autre utilisateur, en lecture seule, révocable. */
export const conversationShares = pgTable(
  'conversation_shares',
  {
    id: pk(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: text({ enum: ['READ'] }).notNull().default('READ'),
    createdBy: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    revokedAt: ts(),
  },
  (t) => [
    uniqueIndex('conversation_shares_active_uq')
      .on(t.conversationId, t.userId)
      .where(sql`${t.revokedAt} is null`),
    index().on(t.userId),
  ],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: pk(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text({
      enum: ['queued', 'running', 'paused_quota', 'interrupting', 'completed', 'failed', 'interrupted'],
    })
      .notNull()
      .default('queued'),
    modelId: uuid(),
    /** Mode et effort effectivement appliqués à ce run (traçabilité). */
    agentMode: text({ enum: ['autonomous', 'plan'] }).notNull().default('autonomous'),
    thinkingLevel: text(),
    triggerMessageId: uuid(),
    /** Instance worker détenant le run + fencing token (reprise après panne). */
    workerId: text(),
    leaseToken: bigint({ mode: 'number' }).notNull().default(0),
    leaseExpiresAt: ts(),
    /** Génération de checkpoint au démarrage du run (panneau « dernier run »). */
    startGeneration: integer(),
    pausedReason: text(),
    error: text(),
    idempotencyKey: text(),
    queuedAt: ts().notNull().defaultNow(),
    startedAt: ts(),
    endedAt: ts(),
  },
  (t) => [
    // Invariant : pas de runs concurrents actifs sur la même conversation.
    uniqueIndex('agent_runs_one_active_uq')
      .on(t.conversationId)
      .where(sql`${t.status} in ('queued','running','paused_quota','interrupting')`),
    index().on(t.workspaceId, t.queuedAt),
    index().on(t.status, t.leaseExpiresAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: pk(),
    conversationId: uuid()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    runId: uuid().references(() => agentRuns.id, { onDelete: 'set null' }),
    role: text({ enum: ['user', 'assistant', 'system'] }).notNull(),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    text: text().notNull().default(''),
    /**
     * Message envoyé pendant une génération : en file d'attente, il déclenchera un nouveau run
     * à la fin du run courant (file durable, indépendante du processus Pi).
     */
    pendingDelivery: boolean().notNull().default(false),
    /** Données structurées d'un message système (ex. retour en arrière : générations concernées). */
    meta: jsonb().$type<Record<string, unknown>>(),
    thinking: text(),
    model: text(),
    stopReason: text(),
    usage: jsonb().$type<{
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
    }>(),
    createdAt: createdAt(),
    completedAt: ts(),
    deletedAt: ts(),
  },
  (t) => [index().on(t.conversationId, t.createdAt)],
);

export const toolCalls = pgTable(
  'tool_calls',
  {
    id: pk(),
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    messageId: uuid().references(() => messages.id, { onDelete: 'set null' }),
    /** Identifiant de l'appel côté Pi/LLM. */
    externalId: text().notNull(),
    toolName: text().notNull(),
    args: jsonb(),
    status: text({ enum: ['running', 'completed', 'failed', 'blocked'] }).notNull().default('running'),
    output: text().notNull().default(''),
    outputTruncated: boolean().notNull().default(false),
    isError: boolean().notNull().default(false),
    filesTouched: jsonb().$type<string[]>().notNull().default([]),
    /** Captures d'écran produites pendant l'appel (pièces jointes `source = agent`). */
    images: jsonb().$type<Array<{ attachmentId: string; fileName: string; width: number | null; height: number | null }>>().notNull().default([]),
    /** Fichiers proposés au téléchargement par Pi (outil `share_files`, pièces jointes `source = agent`). */
    files: jsonb().$type<Array<{ attachmentId: string; fileName: string; path: string; size: number; kind: 'image' | 'text' | 'archive' | 'binary' }>>().notNull().default([]),
    /** Données structurées de certains outils (ex. progression des sous-agents), pour l'interface. */
    details: jsonb().$type<Record<string, unknown>>(),
    startedAt: ts().notNull().defaultNow(),
    completedAt: ts(),
    durationMs: integer(),
  },
  (t) => [uniqueIndex('tool_calls_run_external_uq').on(t.runId, t.externalId), index().on(t.messageId)],
);

/** Événements SSE persistés ; `seq` monotone par workspace. */
export const agentEvents = pgTable(
  'agent_events',
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    seq: bigint({ mode: 'number' }).notNull(),
    runId: uuid(),
    type: text().notNull(),
    data: jsonb().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.seq] }), index().on(t.createdAt)],
);

export const attachments = pgTable(
  'attachments',
  {
    id: pk(),
    ownerId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    messageId: uuid().references(() => messages.id, { onDelete: 'set null' }),
    fileName: text().notNull(),
    declaredMimeType: text(),
    detectedMimeType: text().notNull(),
    kind: text({ enum: ['image', 'text', 'archive', 'binary'] }).notNull(),
    /** `user` : déposée par l'utilisateur ; `agent` : produite par Pi (capture d'écran). */
    source: text({ enum: ['user', 'agent'] }).notNull().default('user'),
    size: bigint({ mode: 'number' }).notNull(),
    sha256: text().notNull(),
    /** Clé S3 dans le préfixe `attachments/` (permissions distinctes des snapshots). */
    storageKey: text().notNull(),
    status: text({ enum: ['pending', 'ready', 'rejected'] }).notNull().default('pending'),
    rejectionReason: text(),
    scan: jsonb().$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    deletedAt: ts(),
  },
  (t) => [index().on(t.workspaceId), index().on(t.messageId)],
);
