import { Inject, Injectable, Logger } from '@nestjs/common';
import { auditEvents, type Database, type DbOrTx } from '@cap/database';
import { DB } from '../tokens.js';
import { redact } from '../common/redact.js';

export interface AuditEntry {
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome?: 'success' | 'failure';
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Journal d'audit append-only. Les métadonnées sont expurgées des secrets. */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');
  constructor(@Inject(DB) private readonly db: Database) {}

  async record(entry: AuditEntry, tx?: DbOrTx): Promise<void> {
    const exec = tx ?? this.db;
    try {
      await exec.insert(auditEvents).values({
        actorId: entry.actorId ?? null,
        actorLabel: entry.actorLabel ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        outcome: entry.outcome ?? 'success',
        ip: entry.ip ?? null,
        userAgent: entry.userAgent?.slice(0, 500) ?? null,
        correlationId: entry.correlationId ?? null,
        metadata: redact(entry.metadata ?? {}),
      });
    } catch (err) {
      // Dans une transaction, l'erreur doit remonter (atomicité) ; hors transaction on journalise.
      if (tx) throw err;
      this.logger.error(`Échec d'écriture d'audit ${entry.action}: ${(err as Error).message}`);
    }
  }
}
