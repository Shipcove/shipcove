import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import type { RetentionDataType } from '@cap/contracts';
import {
  agentEvents,
  attachments,
  auditEvents,
  deletionJobs,
  emailDeliveries,
  llmRequests,
  notifications,
  retentionPolicies,
  toolCalls,
  workspaceSnapshots,
  workspaces,
  type Database,
} from '@cap/database';
import { AuditService, DB, ObjectStorage } from '@cap/server-core';
import { CheckpointService } from '../sandbox/checkpoint.service.js';

/**
 * Rétention (SPEC §18) : durées fixées **uniquement** par l'administrateur plateforme.
 * - Le gel légal (`legal_hold`) bloque toute purge du type concerné.
 * - Les informations indispensables à la reprise d'une conversation conservée ne sont pas purgées :
 *   la génération courante des checkpoints (qui contient la session Pi) est toujours conservée,
 *   et les messages ne sont supprimés qu'avec leur workspace.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger('Retention');

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly checkpoints: CheckpointService,
    private readonly audit: AuditService,
  ) {}

  async runAll(): Promise<Record<string, number>> {
    const policies = await this.db.select().from(retentionPolicies);
    const stats: Record<string, number> = {};
    for (const p of policies) {
      if (p.retentionDays === null) continue;
      const type = p.dataType as RetentionDataType;
      const [job] = await this.db.insert(deletionJobs).values({ kind: 'retention_purge', dataType: type, status: p.legalHold ? 'blocked' : 'running' }).returning();
      if (p.legalHold) continue;
      try {
        const n = await this.purge(type, p.retentionDays);
        stats[type] = n;
        await this.db.update(deletionJobs).set({ status: 'succeeded', stats: { deleted: n }, finishedAt: new Date() }).where(eq(deletionJobs.id, job.id));
        if (n > 0) await this.audit.record({ action: 'retention.purge', targetType: 'data_type', targetId: type, metadata: { deleted: n, days: p.retentionDays } });
      } catch (err) {
        await this.db.update(deletionJobs).set({ status: 'failed', error: (err as Error).message.slice(0, 1000), finishedAt: new Date() }).where(eq(deletionJobs.id, job.id));
        this.logger.warn(`Purge ${type} : ${(err as Error).message}`);
      }
    }
    return stats;
  }

  private cutoff(days: number) {
    return sql`now() - (${days} * interval '1 day')`;
  }

  async purge(type: RetentionDataType, days: number): Promise<number> {
    switch (type) {
      case 'agent_events':
        return (await this.db.delete(agentEvents).where(lt(agentEvents.createdAt, this.cutoff(days))).returning({ s: agentEvents.seq })).length;
      case 'tool_logs':
        // Les métadonnées (outil, statut, durée, fichiers) sont conservées ; la sortie est effacée.
        return (
          await this.db
            .update(toolCalls)
            .set({ output: '', outputTruncated: true })
            .where(and(lt(toolCalls.startedAt, this.cutoff(days)), sql`${toolCalls.output} <> ''`))
            .returning({ id: toolCalls.id })
        ).length;
      case 'notifications':
        return (await this.db.delete(notifications).where(lt(notifications.createdAt, this.cutoff(days))).returning({ id: notifications.id })).length;
      case 'email_deliveries':
        return (await this.db.delete(emailDeliveries).where(lt(emailDeliveries.createdAt, this.cutoff(days))).returning({ id: emailDeliveries.id })).length;
      case 'llm_requests':
        return (
          await this.db
            .delete(llmRequests)
            .where(and(lt(llmRequests.createdAt, this.cutoff(days)), sql`${llmRequests.status} in ('settled','failed','rejected')`))
            .returning({ id: llmRequests.id })
        ).length;
      case 'audit':
        return (await this.db.delete(auditEvents).where(lt(auditEvents.occurredAt, this.cutoff(days))).returning({ id: auditEvents.id })).length;
      case 'attachments': {
        const rows = await this.db.select().from(attachments).where(lt(attachments.createdAt, this.cutoff(days)));
        if (rows.length) await this.storage.deleteMany(this.storage.attachmentsBucket, rows.map((r) => r.storageKey));
        for (const r of rows) await this.db.delete(attachments).where(eq(attachments.id, r.id));
        return rows.length;
      }
      case 'checkpoints': {
        // Conserve la génération courante et toutes celles plus récentes que la durée.
        const ws = await this.db.select({ id: workspaces.id }).from(workspaces);
        let n = 0;
        for (const w of ws) {
          const recent = await this.db
            .select({ g: workspaceSnapshots.generation })
            .from(workspaceSnapshots)
            .where(and(eq(workspaceSnapshots.workspaceId, w.id), eq(workspaceSnapshots.status, 'validated'), sql`${workspaceSnapshots.createdAt} >= ${this.cutoff(days)}`));
          const r = await this.checkpoints.storage.cleanup(w.id, Math.max(1, recent.length));
          n += r.manifestsDeleted;
        }
        return n;
      }
      case 'archived_workspaces':
      case 'conversations':
      case 'messages': {
        // Suppression définitive des workspaces archivés / supprimés logiquement depuis plus de N jours
        // (conversation, messages, événements, checkpoints S3 compris).
        const rows = await this.db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(
            type === 'archived_workspaces'
              ? and(isNotNull(workspaces.archivedAt), lt(workspaces.archivedAt, this.cutoff(days)))
              : and(isNotNull(workspaces.deletedAt), lt(workspaces.deletedAt, this.cutoff(days))),
          );
        for (const r of rows) await this.hardDeleteWorkspace(r.id);
        return rows.length;
      }
      default:
        return 0;
    }
  }

  async hardDeleteWorkspace(workspaceId: string): Promise<void> {
    const atts = await this.db.select().from(attachments).where(eq(attachments.workspaceId, workspaceId));
    if (atts.length) await this.storage.deleteMany(this.storage.attachmentsBucket, atts.map((a) => a.storageKey));
    await this.checkpoints.storage.purgeAll(workspaceId);
    await this.db.delete(workspaces).where(eq(workspaces.id, workspaceId)); // cascade : conversation, messages, runs, événements…
    await this.audit.record({ action: 'workspace.hard_delete', targetType: 'workspace', targetId: workspaceId });
  }
}
