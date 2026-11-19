import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { ACTIVE_RUN_STATUSES, type RepositoryRef, type WorkspaceDto } from '@cap/contracts';
import { agentRuns, conversations, llmModels, repositories, workspaces, type Database, type DbOrTx } from '@cap/database';
import { AppError, DB, EventsService, GitProviderClient, GitProviderError, SettingsService, modelAllowedFor } from '@cap/server-core';
import type { AuthUser } from '../common/request.js';
import { LiteLlmAdminService } from '../admin/litellm.service.js';
import { toRepoDto } from '../repositories/repositories.controller.js';

type Ws = typeof workspaces.$inferSelect;

/** Titre d'une conversation qui n'a pas encore reçu de message. */
export const DEFAULT_TITLE = 'Nouvelle conversation';

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger('Workspaces');

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly git: GitProviderClient,
    private readonly settings: SettingsService,
    private readonly litellm: LiteLlmAdminService,
    private readonly events: EventsService,
  ) {}

  async toDto(w: Ws, access: 'owner' | 'shared_read'): Promise<WorkspaceDto> {
    const [repo] = w.repositoryId ? await this.db.select().from(repositories).where(eq(repositories.id, w.repositoryId)) : [];
    const [c] = await this.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.workspaceId, w.id));
    const [run] = await this.db
      .select({ id: agentRuns.id, status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspaceId, w.id), inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES])))
      .orderBy(desc(agentRuns.queuedAt))
      .limit(1);
    return {
      id: w.id,
      ownerId: w.ownerId,
      name: w.name,
      titleSource: w.titleSource,
      repository: repo ? toRepoDto(repo) : null,
      status: w.status,
      syncState: w.syncState,
      branch: w.branch,
      modelId: w.modelId,
      thinkingLevel: w.thinkingLevel,
      agentMode: w.agentMode,
      conversationId: c?.id ?? '',
      activeRunId: run?.id ?? null,
      activeRunStatus: run?.status ?? null,
      lastActivityAt: w.lastActivityAt?.toISOString() ?? null,
      lastCheckpointAt: w.lastCheckpointAt?.toISOString() ?? null,
      createdAt: w.createdAt.toISOString(),
      archivedAt: w.archivedAt?.toISOString() ?? null,
      access,
    };
  }

  /** Modèle activé et accessible à l'utilisateur (liste blanche vide = tous). */
  async assertModelAllowed(modelId: string, userId: string) {
    const [m] = await this.db.select().from(llmModels).where(and(eq(llmModels.id, modelId), isNull(llmModels.deletedAt)));
    if (!m || !m.enabled || !modelAllowedFor(m, userId)) throw new AppError('model_not_allowed', 'Modèle non autorisé');
    return m;
  }

  /**
   * Dépôt choisi pour une conversation : lisible avec la connexion Git de l'utilisateur, URL de
   * clonage sur le même hôte que la connexion (le jeton n'est jamais présenté à un autre hôte).
   * Le dépôt rejoint le catalogue partagé (réglages d'environnement communs).
   */
  async resolveRepository(tx: DbOrTx, user: AuthUser, ref: RepositoryRef): Promise<{ repositoryId: string; gitConnectionId: string; branch: string }> {
    const conn = await this.git.connection(ref.gitConnectionId, user.id);
    try {
      const row = await this.git.upsertRepository(tx, conn, ref.fullName);
      return { repositoryId: row.id, gitConnectionId: conn.id, branch: ref.branch ?? row.defaultBranch };
    } catch (err) {
      if (err instanceof GitProviderError) throw new AppError('not_found', `Dépôt inaccessible avec cette connexion (${err.message})`);
      throw err;
    }
  }

  /**
   * Titre automatique à partir du premier message : modèle choisi par l'administrateur (appel court,
   * non décompté des quotas), sinon début du message. N'écrase jamais un titre choisi par l'utilisateur.
   */
  async generateTitle(workspaceId: string, firstMessage: string): Promise<void> {
    const { titleModelId, titleMaxLength } = await this.settings.section('conversations');
    const fallback = shortTitle(firstMessage, titleMaxLength);
    let title = fallback;
    if (titleModelId) {
      const [m] = await this.db.select().from(llmModels).where(and(eq(llmModels.id, titleModelId), eq(llmModels.enabled, true), isNull(llmModels.deletedAt)));
      if (m) {
        const messages = [
          {
            role: 'system' as const,
            content:
              'Tu donnes un titre à une conversation entre un développeur et un agent de code. ' +
              `Titre de 3 à 7 mots, ${titleMaxLength} caractères au plus, dans la langue du message, sans guillemets ni point final. ` +
              'Réponds uniquement en JSON : {"title": "<titre>"}.',
          },
          { role: 'user' as const, content: firstMessage.slice(0, 4000) },
        ];
        try {
          // Sortie contrainte (JSON Schema, longueur maximale) ; sans limite de tokens, pour qu'un
          // modèle qui raisonne avant de répondre aille jusqu'au titre.
          let r;
          try {
            r = await this.litellm.complete(m.litellmModel, messages, { responseFormat: titleResponseFormat(titleMaxLength) });
          } catch (err) {
            // Fournisseur sans sortie structurée : même consigne, réponse libre (longueur vérifiée ensuite).
            if (!/HTTP (400|422)\b/.test((err as Error).message)) throw err;
            r = await this.litellm.complete(m.litellmModel, messages);
          }
          const parsed = parseTitle(r.content, titleMaxLength);
          if (parsed) title = parsed;
          else
            this.logger.warn(
              `Titre automatique (${workspaceId}) : réponse vide de ${m.litellmModel} (arrêt : ${r.finishReason ?? 'inconnu'}${r.reasoning ? ', raisonnement seul' : ''}) ; début du message utilisé`,
            );
        } catch (err) {
          this.logger.warn(`Titre automatique (${workspaceId}) : ${(err as Error).message}`);
        }
      }
    }
    const [u] = await this.db
      .update(workspaces)
      .set({ name: title, updatedAt: new Date() })
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.titleSource, 'auto')))
      .returning({ id: workspaces.id });
    if (u) await this.events.emit(workspaceId, 'workspace.renamed', { name: title, titleSource: 'auto' });
  }
}

/** Sortie contrainte des titres : un objet `{ title }` d'au plus `maxLength` caractères. */
export function titleResponseFormat(maxLength: number): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'conversation_title',
      strict: true,
      schema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1, maxLength } },
        required: ['title'],
        additionalProperties: false,
      },
    },
  };
}

/** Coupe un texte à `max` caractères, sur une fin de mot si possible. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

/** Début du message, sur une ligne, coupé proprement. */
export function shortTitle(text: string, max = 60): string {
  const line = text.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return DEFAULT_TITLE;
  return clip(line, max);
}

/**
 * Titre lu dans la réponse : JSON `{ title }` (sortie contrainte) ou texte libre (repli), sans
 * raisonnement, puis borné à `max` caractères (au cas où le fournisseur ignorerait la contrainte).
 */
export function parseTitle(content: string, max: number): string {
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
  let candidate = text;
  const json = text.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const t = (JSON.parse(json[0]) as { title?: unknown }).title;
      if (typeof t === 'string') candidate = t;
    } catch {
      /* texte libre */
    }
  }
  const cleaned = cleanTitle(candidate);
  return cleaned ? clip(cleaned, max) : '';
}

/** Réponse du modèle ramenée à un titre : première ligne, sans guillemets ni balises de raisonnement. */
export function cleanTitle(text: string): string {
  const t = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Raisonnement coupé avant sa fin (budget épuisé) : aucun titre dedans.
    .replace(/<think>[\s\S]*$/i, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!t) return '';
  return t
    .replace(/^(titre|title)\s*:\s*/i, '')
    .replace(/^["'«»*#\s]+|["'«».*#\s]+$/g, '')
    .slice(0, 120)
    .trim();
}
