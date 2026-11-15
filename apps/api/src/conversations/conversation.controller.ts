import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Query, Sse, type MessageEvent } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Observable } from 'rxjs';
import { z } from 'zod';
import {
  CreateShareSchema,
  SendMessageSchema,
  type ConversationDto,
  type ConversationShareDto,
  type EventEnvelope,
  type MessageDto,
  type SendMessage,
} from '@cap/contracts';
import {
  agentRuns,
  attachments,
  conversationShares,
  conversations,
  llmModels,
  messages,
  teamMembers,
  toolCalls,
  users,
  type Database,
} from '@cap/database';
import { AppError, AuditService, DB, EventsService, JobsService, QuotaService, RunQueueService } from '@cap/server-core';
import { isUniqueViolation } from '@cap/server-core';
import { CurrentUser, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';
import { IdempotencyService } from '../common/idempotency.service.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';

const uuid = { schema: z.uuid() };

/** Message de réponse à un formulaire de questions de Pi (`ask_user`). */
function answersMeta(body: { answersTo?: string }): Record<string, unknown> | null {
  return body.answersTo ? { kind: 'answers', toolCallId: body.answersTo } : null;
}

@ApiTags('conversation')
@Controller('workspaces/:id')
export class ConversationController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly events: EventsService,
    private readonly jobs: JobsService,
    private readonly idempotency: IdempotencyService,
    private readonly quotas: QuotaService,
    private readonly audit: AuditService,
    private readonly workspacesService: WorkspacesService,
    private readonly runQueue: RunQueueService,
  ) {}

  /** Conversation complète (lecture : propriétaire ou partage nominatif actif). */
  @Get('conversation')
  async conversation(@Param('id', uuid) id: string, @CurrentUser() user: AuthUser): Promise<ConversationDto> {
    await this.access.requireWorkspaceRead(user, id);
    const [conv] = await this.db.select().from(conversations).where(eq(conversations.workspaceId, id));
    const lastEventId = await this.events.lastSeq(id);
    const msgs = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conv.id), isNull(messages.deletedAt), eq(messages.pendingDelivery, false)))
      .orderBy(asc(messages.createdAt));
    const ids = msgs.map((m) => m.id);
    const runs = await this.db
      .select({ r: agentRuns, modelName: llmModels.displayName })
      .from(agentRuns)
      .leftJoin(llmModels, eq(llmModels.id, agentRuns.modelId))
      .where(eq(agentRuns.conversationId, conv.id))
      .orderBy(asc(agentRuns.queuedAt));
    const calls = runs.length
      ? await this.db.select().from(toolCalls).where(inArray(toolCalls.runId, runs.map((r) => r.r.id))).orderBy(asc(toolCalls.startedAt))
      : [];
    const atts = ids.length ? await this.db.select().from(attachments).where(and(inArray(attachments.messageId, ids), isNull(attachments.deletedAt))) : [];
    const dto: MessageDto[] = msgs.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      runId: m.runId,
      role: m.role,
      authorId: m.authorId,
      text: m.text,
      thinking: m.thinking,
      model: m.model,
      stopReason: m.stopReason,
      meta: m.meta ?? null,
      createdAt: m.createdAt.toISOString(),
      completedAt: m.completedAt?.toISOString() ?? null,
      attachments: atts
        .filter((a) => a.messageId === m.id)
        .map((a) => ({ id: a.id, fileName: a.fileName, mimeType: a.detectedMimeType, size: a.size, kind: a.kind, status: a.status, rejectionReason: a.rejectionReason, createdAt: a.createdAt.toISOString() })),
      toolCalls: calls
        .filter((c) => c.messageId === m.id)
        .map((c) => ({
          id: c.externalId,
          runId: c.runId,
          messageId: c.messageId,
          toolName: c.toolName,
          args: c.args,
          status: c.status,
          output: c.output,
          outputTruncated: c.outputTruncated,
          isError: c.isError,
          filesTouched: c.filesTouched,
          images: c.images,
          startedAt: c.startedAt.toISOString(),
          completedAt: c.completedAt?.toISOString() ?? null,
          durationMs: c.durationMs,
        })),
    }));
    return {
      id: conv.id,
      workspaceId: id,
      ownerId: conv.ownerId,
      messages: dto,
      runs: runs.map(({ r, modelName }) => ({
        id: r.id,
        workspaceId: r.workspaceId,
        status: r.status,
        modelId: r.modelId,
        modelName,
        agentMode: r.agentMode,
        startedAt: r.startedAt?.toISOString() ?? null,
        endedAt: r.endedAt?.toISOString() ?? null,
        error: r.error,
        pausedReason: r.pausedReason,
      })),
      queued: await this.runQueue.list(conv.id),
      lastEventId,
      context: {
        percent: conv.contextTokens && conv.contextWindow ? Math.round((conv.contextTokens / conv.contextWindow) * 100) : null,
      },
    };
  }

  /**
   * Nouveau message. Un seul run actif par workspace : l'index unique partiel en base garantit
   * l'invariant même entre plusieurs instances API. `Idempotency-Key` évite les doublons au rejeu.
   */
  @Post('messages')
  async send(
    @Param('id', uuid) id: string,
    @Body({ schema: SendMessageSchema }) body: SendMessage,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const w = await this.access.requireWorkspaceOwner(user, id);
    if (w.status === 'archived') throw new AppError('conflict', 'Workspace archivé');
    return this.idempotency.run(user.id, idemKey, `POST /workspaces/${id}/messages`, body, async () => {
      const [conv] = await this.db.select().from(conversations).where(eq(conversations.workspaceId, id));
      const modelId = body.modelId ?? w.modelId ?? null;
      const model = modelId ? await this.workspacesService.assertModelAllowed(modelId, w.teamId) : null;
      if (body.attachmentIds.length) {
        const owned = await this.db
          .select({ id: attachments.id, kind: attachments.kind })
          .from(attachments)
          .where(and(inArray(attachments.id, body.attachmentIds), eq(attachments.ownerId, user.id), eq(attachments.workspaceId, id), eq(attachments.status, 'ready'), eq(attachments.source, 'user'), isNull(attachments.messageId)));
        if (owned.length !== body.attachmentIds.length) throw new AppError('attachment_rejected', 'Pièce jointe invalide ou déjà utilisée');
        // Capacités du modèle LiteLLM sélectionné : images refusées si non supportées.
        if (model && !model.supportsImages && owned.some((a) => a.kind === 'image')) {
          throw new AppError('attachment_rejected', `Le modèle ${model.displayName} n’accepte pas les images`);
        }
      }
      if (body.delivery === 'follow_up') {
        // File d'attente durable : le message sera traité par un nouveau run à la fin du run courant.
        const queued = await this.db.transaction(async (tx) => {
          const [m] = await tx.insert(messages).values({ conversationId: conv.id, role: 'user', authorId: user.id, text: body.text, pendingDelivery: true, meta: answersMeta(body) }).returning();
          if (body.attachmentIds.length) await tx.update(attachments).set({ messageId: m.id }).where(inArray(attachments.id, body.attachmentIds));
          await this.events.emit(id, 'queue.updated', { messages: await this.runQueue.list(conv.id, tx) }, null, tx);
          return m;
        });
        // Le run a pu se terminer entre-temps (ou aucun n'était actif) : promotion immédiate.
        const runId = await this.runQueue.startNext(conv.id);
        return { messageId: queued.id, runId, queued: runId === null };
      }
      if (body.delivery === 'steer') {
        const [active] = await this.db
          .select()
          .from(agentRuns)
          .where(and(eq(agentRuns.workspaceId, id), eq(agentRuns.status, 'running')));
        if (!active) throw new AppError('conflict', 'Aucun run actif pour recevoir ce message');
        const [m] = await this.db.insert(messages).values({ conversationId: conv.id, runId: active.id, role: 'user', authorId: user.id, text: body.text, meta: answersMeta(body) }).returning();
        await this.events.emit(id, 'message.created', { messageId: m.id, role: 'user', text: body.text, attachmentIds: [], meta: answersMeta(body) }, active.id);
        await this.db.execute(sql`select pg_notify('cap_run_control', ${JSON.stringify({ runId: active.id, action: body.delivery, messageId: m.id })})`);
        return { messageId: m.id, runId: active.id };
      }
      // Pas de lancement si le quota est déjà atteint (vérification préalable, l'autorité reste la gateway).
      const quota = await this.quotas.canProceed(user.id, w.teamId);
      if (!quota.ok) throw new AppError('quota_exceeded', 'Quota atteint', { window: quota.window, resetsAt: quota.resetsAt });
      return this.db.transaction(async (tx) => {
        const [m] = await tx.insert(messages).values({ conversationId: conv.id, role: 'user', authorId: user.id, text: body.text, meta: answersMeta(body) }).returning();
        if (body.attachmentIds.length) await tx.update(attachments).set({ messageId: m.id }).where(inArray(attachments.id, body.attachmentIds));
        const [run] = await tx
          .insert(agentRuns)
          .values({
            conversationId: conv.id,
            workspaceId: id,
            userId: user.id,
            modelId,
            agentMode: w.agentMode,
            thinkingLevel: w.thinkingLevel,
            triggerMessageId: m.id,
            idempotencyKey: idemKey ?? null,
          })
          .returning()
          .catch((err: unknown) => {
            if (isUniqueViolation(err)) throw new AppError('run_already_active', 'Un run est déjà actif : attendez sa fin, interrompez-le ou envoyez un message de guidage');
            throw err;
          });
        await tx.update(messages).set({ runId: run.id }).where(eq(messages.id, m.id));
        await this.events.append(
          id,
          [
            { type: 'message.created', runId: run.id, data: { messageId: m.id, role: 'user', text: body.text, attachmentIds: body.attachmentIds, meta: answersMeta(body) } },
            { type: 'run.queued', runId: run.id, data: { runId: run.id } },
          ],
          tx,
        );
        await this.jobs.enqueue('run.start', { runId: run.id }, { dedupeKey: `run:${run.id}`, maxAttempts: 1 }, tx);
        return { messageId: m.id, runId: run.id };
      });
    });
  }

  @Post('runs/:runId/interrupt')
  @HttpCode(202)
  async interrupt(@Param('id', uuid) id: string, @Param('runId', uuid) runId: string, @CurrentUser() user: AuthUser) {
    await this.access.requireWorkspaceOwner(user, id);
    const [r] = await this.db
      .update(agentRuns)
      .set({ status: 'interrupting' })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, id), inArray(agentRuns.status, ['running', 'queued'])))
      .returning();
    if (!r) {
      // Run en pause quota : simple annulation.
      const [p] = await this.db
        .update(agentRuns)
        .set({ status: 'interrupted', endedAt: new Date(), error: 'Annulé par l’utilisateur' })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, id), eq(agentRuns.status, 'paused_quota')))
        .returning();
      if (!p) throw new AppError('conflict', 'Aucun run actif à interrompre');
      await this.events.emit(id, 'run.interrupted', { runId, reason: 'Annulé par l’utilisateur' }, runId);
      await this.runQueue.startNext(p.conversationId);
      return { status: 'interrupted' };
    }
    await this.db.execute(sql`select pg_notify('cap_run_control', ${JSON.stringify({ runId, action: 'interrupt' })})`);
    return { status: 'interrupting' };
  }

  /** Reprise après pause quota, lorsque toutes les fenêtres le permettent. */
  @Post('runs/:runId/resume')
  @HttpCode(202)
  async resume(@Param('id', uuid) id: string, @Param('runId', uuid) runId: string, @CurrentUser() user: AuthUser) {
    const w = await this.access.requireWorkspaceOwner(user, id);
    const check = await this.quotas.canProceed(user.id, w.teamId);
    if (!check.ok) throw new AppError('quota_exceeded', 'Quota toujours atteint', { window: check.window, resetsAt: check.resetsAt });
    const [r] = await this.db
      .update(agentRuns)
      .set({ status: 'queued', pausedReason: 'resuming' })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, id), eq(agentRuns.status, 'paused_quota')))
      .returning();
    if (!r) throw new AppError('conflict', 'Ce run n’est pas suspendu');
    await this.events.emit(id, 'quota.resumed', {}, runId);
    await this.jobs.enqueue('run.start', { runId }, { dedupeKey: `run:${runId}:resume:${Date.now()}`, maxAttempts: 1 });
    return { status: 'queued' };
  }

  /**
   * Flux SSE des événements agentiques (contrat v1, docs/api/sse-events.md).
   * Reprise via `Last-Event-ID` sans relancer Pi : le flux est relu depuis PostgreSQL.
   */
  @Sse('events')
  async stream(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthUser,
    @Headers('last-event-id') lastEventHeader?: string,
    @Query('lastEventId') lastEventQuery?: string,
  ): Promise<Observable<MessageEvent>> {
    await this.access.requireWorkspaceRead(user, id);
    const from = Number(lastEventHeader ?? lastEventQuery ?? 0) || 0;
    return new Observable<MessageEvent>((sub) => {
      let lastSent = from;
      let closed = false;
      let reading = false;
      let again = false;
      const send = (e: EventEnvelope) => {
        lastSent = e.id;
        sub.next({ id: String(e.id), data: e });
      };
      const drain = async () => {
        if (reading) {
          again = true;
          return;
        }
        reading = true;
        try {
          do {
            again = false;
            for (;;) {
              const batch = await this.events.readAfter(id, lastSent, 500);
              if (closed) return;
              for (const e of batch) send(e);
              if (batch.length < 500) break;
            }
          } while (again && !closed);
        } catch (err) {
          sub.error(err);
        } finally {
          reading = false;
        }
      };
      let unsubscribe: (() => void) | undefined;
      void (async () => {
        // Événements expirés (rétention) : demande de resynchronisation explicite.
        const oldest = await this.events.oldestSeq(id);
        if (from > 0 && oldest !== null && from < oldest - 1) {
          const last = await this.events.lastSeq(id);
          sub.next({ id: String(last), data: { v: 1, id: last, workspaceId: id, runId: null, type: 'stream.resync', ts: new Date().toISOString(), data: { fromId: last, reason: 'expired' } } });
          lastSent = last;
        }
        unsubscribe = await this.events.subscribe((ws) => {
          if (ws === id || ws === '') void drain();
        });
        await drain();
      })();
      // Maintien de connexion + revérification des droits (partage révoqué, retrait d'équipe).
      const keepAlive = setInterval(() => sub.next({ comment: 'keepalive', data: '' } as MessageEvent), 15_000);
      const recheck = setInterval(() => {
        this.access.requireWorkspaceRead(user, id).catch(() => sub.complete());
      }, 30_000);
      return () => {
        closed = true;
        clearInterval(keepAlive);
        clearInterval(recheck);
        unsubscribe?.();
      };
    });
  }
}

/** Partage nominatif en lecture seule, révocable (SPEC §5). */
@ApiTags('conversation')
@Controller('conversations/:conversationId/shares')
export class SharesController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private async ownedConversation(user: AuthUser, conversationId: string) {
    const [c] = await this.db.select().from(conversations).where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt)));
    if (!c) throw new AppError('not_found', 'Conversation introuvable');
    const w = await this.access.requireWorkspaceOwner(user, c.workspaceId);
    return { c, w };
  }

  @Get()
  async list(@Param('conversationId', uuid) conversationId: string, @CurrentUser() user: AuthUser): Promise<ConversationShareDto[]> {
    await this.ownedConversation(user, conversationId);
    const rows = await this.db
      .select({ s: conversationShares, u: users })
      .from(conversationShares)
      .innerJoin(users, eq(users.id, conversationShares.userId))
      .where(eq(conversationShares.conversationId, conversationId))
      .orderBy(desc(conversationShares.createdAt));
    return rows.map(({ s, u }) => ({
      id: s.id,
      conversationId,
      user: { id: u.id, username: u.username, displayName: u.displayName },
      permission: 'READ',
      createdAt: s.createdAt.toISOString(),
      revokedAt: s.revokedAt?.toISOString() ?? null,
    }));
  }

  @Post()
  async create(@Param('conversationId', uuid) conversationId: string, @Body({ schema: CreateShareSchema }) body: { userId: string }, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    const { w } = await this.ownedConversation(user, conversationId);
    if (body.userId === user.id) throw new AppError('validation_failed', 'Impossible de partager avec soi-même');
    const [member] = await this.db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, w.teamId), eq(teamMembers.userId, body.userId)));
    if (!member) throw new AppError('forbidden', 'Le destinataire doit être membre de l’équipe du projet');
    const [s] = await this.db
      .insert(conversationShares)
      .values({ conversationId, userId: body.userId, createdBy: user.id })
      .onConflictDoNothing()
      .returning();
    if (!s) throw new AppError('conflict', 'Déjà partagé avec cet utilisateur');
    await this.audit.record({ actorId: user.id, action: 'conversation.share', targetType: 'conversation', targetId: conversationId, ip: ctx.ip, metadata: { userId: body.userId } });
    return { id: s.id };
  }

  @Delete(':shareId')
  @HttpCode(204)
  async revoke(@Param('conversationId', uuid) conversationId: string, @Param('shareId', uuid) shareId: string, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.ownedConversation(user, conversationId);
    const res = await this.db
      .update(conversationShares)
      .set({ revokedAt: new Date() })
      .where(and(eq(conversationShares.id, shareId), eq(conversationShares.conversationId, conversationId), isNull(conversationShares.revokedAt)))
      .returning();
    if (res.length === 0) throw new AppError('not_found', 'Partage introuvable');
    await this.audit.record({ actorId: user.id, action: 'conversation.share_revoke', targetType: 'conversation', targetId: conversationId, ip: ctx.ip, metadata: { shareId } });
  }
}

