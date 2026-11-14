import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { RewindSchema, type Rewind } from '@cap/contracts';
import { agentRuns, conversations, messages, workspaceSnapshots, type Database } from '@cap/database';
import { AppError, AuditService, DB, EventsService } from '@cap/server-core';
import { CurrentUser, ReqCtx, type RequestContext } from '../common/decorators.js';
import type { AuthUser } from '../common/request.js';
import { AccessService } from '../access/access.service.js';
import { SandboxRpcClient } from './sandbox-rpc.client.js';

const uuid = { schema: z.uuid() };

/**
 * Retour en arrière (« annuler ce que l'agent a fait ») : les fichiers du workspace sont ramenés
 * à l'état d'avant un run, à partir des checkpoints. La conversation est conservée et un message
 * système l'indique (avec de quoi annuler le retour en arrière) ; Pi en est informé au run suivant.
 */
@ApiTags('workspaces')
@Controller('workspaces/:id/rewind')
export class RewindController {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly access: AccessService,
    private readonly rpc: SandboxRpcClient,
    private readonly events: EventsService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(200)
  async rewind(@Param('id', uuid) id: string, @Body({ schema: RewindSchema }) body: Rewind, @CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext) {
    await this.access.requireWorkspaceOwner(user, id);
    const [active] = await this.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspaceId, id), inArray(agentRuns.status, ['queued', 'running', 'interrupting'])));
    if (active) throw new AppError('workspace_busy', 'Pi est en cours d’exécution : interrompez-le ou attendez la fin avant de revenir en arrière');

    let generation: number;
    let label: string;
    let runId: string | null = null;
    if (body.runId) {
      const [run] = await this.db.select().from(agentRuns).where(and(eq(agentRuns.id, body.runId), eq(agentRuns.workspaceId, id)));
      if (!run) throw new AppError('not_found', 'Run introuvable');
      if (run.startGeneration === null) throw new AppError('conflict', 'Aucun point de restauration pour ce run');
      generation = run.startGeneration;
      runId = run.id;
      const [m] = run.triggerMessageId ? await this.db.select({ text: messages.text }).from(messages).where(eq(messages.id, run.triggerMessageId)) : [];
      const excerpt = (m?.text ?? '').replace(/\s+/g, ' ').trim();
      label = `Fichiers restaurés à l’état d’avant « ${excerpt.length > 80 ? `${excerpt.slice(0, 80)}…` : excerpt} »`;
    } else {
      generation = body.generation!;
      label = 'Retour en arrière annulé : fichiers restaurés à l’état précédent';
    }
    const [snap] = await this.db
      .select({ id: workspaceSnapshots.id })
      .from(workspaceSnapshots)
      .where(and(eq(workspaceSnapshots.workspaceId, id), eq(workspaceSnapshots.generation, generation), eq(workspaceSnapshots.status, 'validated')));
    if (!snap) throw new AppError('conflict', 'Ce point de restauration n’est plus disponible (purgé par la rétention)');

    const r = await this.rpc.call<{ busy: boolean; fromGeneration?: number; toGeneration?: number; generation?: number; deleted?: number; written?: number }>(
      { op: 'workspace.rewind', workspaceId: id, generation, userId: user.id },
      300_000,
    );
    if (r.busy) throw new AppError('workspace_busy', 'Pi a démarré entre-temps : réessayez à la fin du run');

    const [conv] = await this.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.workspaceId, id));
    const meta = { kind: 'rewind', runId, fromGeneration: r.fromGeneration, toGeneration: generation, generation: r.generation, deleted: r.deleted, written: r.written };
    const [msg] = await this.db.insert(messages).values({ conversationId: conv.id, role: 'system', authorId: user.id, text: label, meta }).returning();
    await this.events.emit(id, 'message.created', { messageId: msg.id, role: 'system', text: label, attachmentIds: [], meta });
    await this.audit.record({ actorId: user.id, action: 'workspace.rewind', targetType: 'workspace', targetId: id, ip: ctx.ip, metadata: meta });
    return { messageId: msg.id, ...meta };
  }
}
