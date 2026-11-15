import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { agentRuns, conversations, messages, workspaces, type Database, type DbOrTx } from '@cap/database';
import { DB } from '../tokens.js';
import { EventsService } from '../events/events.service.js';
import { JobsService } from '../jobs/jobs.service.js';
import { isUniqueViolation } from '../common/errors.js';

export interface QueuedMessage {
  messageId: string;
  text: string;
}

/**
 * File d'attente durable des messages envoyés pendant une génération.
 * Un message en attente (`pending_delivery`) ne fait pas encore partie du fil : il est promu
 * en déclencheur d'un nouveau run dès que la conversation n'a plus de run actif.
 * L'index unique « un run actif par conversation » garantit qu'un seul run est créé
 * même si l'API et le worker tentent la promotion simultanément.
 */
@Injectable()
export class RunQueueService {
  private readonly logger = new Logger(RunQueueService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly events: EventsService,
    private readonly jobs: JobsService,
  ) {}

  async list(conversationId: string, tx: DbOrTx = this.db): Promise<QueuedMessage[]> {
    const rows = await tx
      .select({ messageId: messages.id, text: messages.text })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.pendingDelivery, true), sql`${messages.deletedAt} is null`))
      .orderBy(asc(messages.createdAt));
    return rows;
  }

  /** Lance un run pour le plus ancien message en attente, si aucun run n'est actif. */
  async startNext(conversationId: string): Promise<string | null> {
    try {
      return await this.db.transaction(async (tx) => {
        const [m] = await tx
          .select()
          .from(messages)
          .where(and(eq(messages.conversationId, conversationId), eq(messages.pendingDelivery, true), sql`${messages.deletedAt} is null`))
          .orderBy(asc(messages.createdAt))
          .limit(1)
          .for('update', { skipLocked: true });
        if (!m) return null;
        const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
        const [w] = await tx.select().from(workspaces).where(eq(workspaces.id, conv.workspaceId));
        if (!w || w.status === 'archived' || w.deletedAt) return null;
        const [run] = await tx
          .insert(agentRuns)
          .values({
            conversationId,
            workspaceId: w.id,
            userId: m.authorId ?? conv.ownerId,
            modelId: w.modelId,
            agentMode: w.agentMode,
            thinkingLevel: w.thinkingLevel,
            triggerMessageId: m.id,
          })
          .returning();
        // Le message rejoint le fil à sa position de traitement.
        await tx.update(messages).set({ pendingDelivery: false, runId: run.id, createdAt: new Date() }).where(eq(messages.id, m.id));
        const remaining = await this.list(conversationId, tx);
        await this.events.append(
          w.id,
          [
            { type: 'message.created', runId: run.id, data: { messageId: m.id, role: 'user', text: m.text, attachmentIds: [] } },
            { type: 'queue.updated', runId: run.id, data: { messages: remaining } },
            { type: 'run.queued', runId: run.id, data: { runId: run.id } },
          ],
          tx,
        );
        await this.jobs.enqueue('run.start', { runId: run.id }, { dedupeKey: `run:${run.id}`, maxAttempts: 1 }, tx);
        return run.id;
      });
    } catch (err) {
      // Un run est déjà actif : le message reste en file, il sera promu à la fin de ce run.
      if (isUniqueViolation(err)) return null;
      this.logger.error(`Promotion de la file d'attente impossible : ${(err as Error).message}`);
      throw err;
    }
  }
}
