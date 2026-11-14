import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { ACTIVE_RUN_STATUSES, type WorkspaceDto } from '@cap/contracts';
import { agentRuns, conversations, llmModels, projects, workspaces, type Database } from '@cap/database';
import { AppError, DB } from '@cap/server-core';

type Ws = typeof workspaces.$inferSelect;

@Injectable()
export class WorkspacesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async toDto(w: Ws, access: 'owner' | 'shared_read'): Promise<WorkspaceDto> {
    const [p] = await this.db.select({ name: projects.name }).from(projects).where(eq(projects.id, w.projectId));
    const [c] = await this.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.workspaceId, w.id));
    const [run] = await this.db
      .select({ id: agentRuns.id, status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspaceId, w.id), inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES])))
      .orderBy(desc(agentRuns.queuedAt))
      .limit(1);
    return {
      id: w.id,
      projectId: w.projectId,
      projectName: p?.name ?? '',
      teamId: w.teamId,
      ownerId: w.ownerId,
      name: w.name,
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

  /** Modèle autorisé pour l'équipe (permissions administrées). */
  async assertModelAllowed(modelId: string, teamId: string) {
    const [m] = await this.db.select().from(llmModels).where(and(eq(llmModels.id, modelId), isNull(llmModels.deletedAt)));
    if (!m || !m.enabled || (m.allowedTeamIds.length > 0 && !m.allowedTeamIds.includes(teamId))) {
      throw new AppError('model_not_allowed', 'Modèle non autorisé');
    }
    return m;
  }
}
