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
    let meta;
    try {
      meta = await this.git.getRepository(conn, ref.fullName);
    } catch (err) {
      if (err instanceof GitProviderError) throw new AppError('not_found', `Dépôt inaccessible avec cette connexion (${err.message})`);
      throw err;
    }
    const clone = await this.git.assertTransport(meta.cloneUrl);
    if (clone.host.toLowerCase() !== conn.host.toLowerCase()) {
      throw new AppError('validation_failed', `URL de clonage sur un hôte inattendu (${clone.host}, connexion ${conn.host})`);
    }
    const [row] = await tx
      .insert(repositories)
      .values({
        provider: meta.provider,
        host: meta.host,
        fullName: meta.fullName,
        externalId: meta.externalId,
        cloneUrl: meta.cloneUrl,
        webUrl: meta.webUrl,
        defaultBranch: meta.defaultBranch,
      })
      .onConflictDoUpdate({
        target: [repositories.host, repositories.fullName],
        set: { cloneUrl: meta.cloneUrl, webUrl: meta.webUrl, externalId: meta.externalId, defaultBranch: meta.defaultBranch },
      })
      .returning({ id: repositories.id });
    return { repositoryId: row.id, gitConnectionId: conn.id, branch: ref.branch ?? meta.defaultBranch };
  }

  /**
   * Titre automatique à partir du premier message : modèle choisi par l'administrateur (appel court,
   * non décompté des quotas), sinon début du message. N'écrase jamais un titre choisi par l'utilisateur.
   */
  async generateTitle(workspaceId: string, firstMessage: string): Promise<void> {
    const fallback = shortTitle(firstMessage);
    let title = fallback;
    const { titleModelId } = await this.settings.section('conversations');
    if (titleModelId) {
      const [m] = await this.db.select().from(llmModels).where(and(eq(llmModels.id, titleModelId), eq(llmModels.enabled, true), isNull(llmModels.deletedAt)));
      if (m) {
        try {
          const text = await this.litellm.complete(
            m.litellmModel,
            [
              {
                role: 'system',
                content:
                  'Tu donnes un titre à une conversation entre un développeur et un agent de code. Réponds uniquement par le titre : ' +
                  '3 à 7 mots, dans la langue du message, sans guillemets, sans point final, sans préfixe.',
              },
              { role: 'user', content: firstMessage.slice(0, 4000) },
            ],
            40,
          );
          const cleaned = cleanTitle(text);
          if (cleaned) title = cleaned;
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

/** Début du message, sur une ligne, coupé proprement. */
export function shortTitle(text: string): string {
  const line = text.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return DEFAULT_TITLE;
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40)).trim()}…`;
}

/** Réponse du modèle ramenée à un titre : première ligne, sans guillemets ni balises de raisonnement. */
export function cleanTitle(text: string): string {
  const t = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
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
