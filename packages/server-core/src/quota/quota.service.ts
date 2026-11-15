import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lte, or, sql } from 'drizzle-orm';
import type { WindowUsageDto } from '@cap/contracts';
import {
  creditLedger,
  creditReservations,
  llmModels,
  llmRequests,
  modelCoefficients,
  quotaPolicies,
  type Database,
  type Tx,
} from '@cap/database';
import { DB } from '../tokens.js';
import { SettingsService } from '../settings/settings.service.js';
import { computeCredits, Decimal, toFixed8, type Coefficients, type NormalizedUsage } from './credits.js';

export const WINDOWS = [
  { key: '5h', ms: 5 * 3600_000 },
  { key: '7d', ms: 7 * 24 * 3600_000 },
] as const;
export type WindowKey = (typeof WINDOWS)[number]['key'];

export class QuotaExceededError extends Error {
  constructor(
    readonly window: '5h' | '7d' | 'disabled',
    readonly resetsAt: Date | null,
  ) {
    super(`Quota de crédits atteint (${window})`);
    this.name = 'QuotaExceededError';
  }
}

export interface ReserveInput {
  userId: string;
  workspaceId: string | null;
  runId: string | null;
  modelId: string;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

export interface Reservation {
  requestId: string;
  reservationId: string;
  amount: string;
  coefficientId: string;
  coefficients: Coefficients;
  litellmModel: string;
}

interface Limits {
  limit5h: string | null;
  limit7d: string | null;
  exempt: boolean;
}

const RESERVATION_TTL_MS = 30 * 60_000;

/**
 * Service de quotas en crédits pondérés (SPEC §9, ADR 0005).
 * Toutes les décisions sont prises dans des transactions PostgreSQL verrouillant les sujets
 * concernés (ordre déterministe) : cohérent sur toutes les instances.
 */
@Injectable()
export class QuotaService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly settings: SettingsService,
  ) {}

  /** Coefficients actifs d'un modèle (dernière version effective). */
  async activeCoefficients(modelId: string, tx: Tx | Database = this.db) {
    const [row] = await tx
      .select()
      .from(modelCoefficients)
      .where(and(eq(modelCoefficients.modelId, modelId), lte(modelCoefficients.effectiveFrom, sql`now()`)))
      .orderBy(desc(modelCoefficients.version))
      .limit(1);
    return row ?? null;
  }

  async reserve(input: ReserveInput): Promise<Reservation> {
    const settings = await this.settings.section('quotas');
    const result = await this.db.transaction(async (tx): Promise<Reservation | { rejected: QuotaExceededError; litellmModel: string; coefficientId: string }> => {
      const [model] = await tx.select().from(llmModels).where(eq(llmModels.id, input.modelId));
      if (!model || model.deletedAt) throw new Error('Modèle inconnu');
      const coeff = await this.activeCoefficients(input.modelId, tx);
      if (!coeff) throw new Error(`Aucun coefficient pour le modèle ${model.litellmModel}`);
      const coefficients: Coefficients = {
        input: coeff.input,
        output: coeff.output,
        cacheRead: coeff.cacheRead,
        cacheWrite: coeff.cacheWrite,
      };
      const amount = computeCredits(
        {
          inputTokens: input.estimatedInputTokens,
          outputTokens: input.estimatedOutputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        coefficients,
      );

      if (settings.enabled) {
        await this.lockSubjects(tx, input.userId);
        const userLimits = await this.userLimits(tx, input.userId);
        if (!userLimits.exempt) {
          for (const w of WINDOWS) {
            const limit = w.key === '5h' ? userLimits.limit5h : userLimits.limit7d;
            if (limit === null) continue;
            const used = await this.usedInWindow(tx, 'user', input.userId, w.ms);
            if (used.add(amount).gt(limit)) {
              return { rejected: new QuotaExceededError(w.key, await this.resetsAt(tx, 'user', input.userId, w.ms)), litellmModel: model.litellmModel, coefficientId: coeff.id };
            }
          }
        }
      }

      const [req] = await tx
        .insert(llmRequests)
        .values({
          userId: input.userId,
          workspaceId: input.workspaceId,
          runId: input.runId,
          modelId: input.modelId,
          litellmModel: model.litellmModel,
          coefficientId: coeff.id,
          status: 'reserved',
          estimatedInputTokens: input.estimatedInputTokens,
        })
        .returning({ id: llmRequests.id });
      const [res] = await tx
        .insert(creditReservations)
        .values({
          llmRequestId: req.id,
          userId: input.userId,
          amount: toFixed8(amount),
          expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
        })
        .returning({ id: creditReservations.id });
      return {
        requestId: req.id,
        reservationId: res.id,
        amount: toFixed8(amount),
        coefficientId: coeff.id,
        coefficients,
        litellmModel: model.litellmModel,
      };
    });
    if ('rejected' in result) {
      // Trace durable du refus (hors de la transaction de réservation).
      await this.db.insert(llmRequests).values({
        userId: input.userId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        modelId: input.modelId,
        litellmModel: result.litellmModel,
        coefficientId: result.coefficientId,
        status: 'rejected',
        error: result.rejected.message,
        httpStatus: 402,
        settledAt: new Date(),
      });
      throw result.rejected;
    }
    return result;
  }

  /**
   * Régularisation idempotente : écrit l'usage réel au ledger (clé `usage:<requestId>`),
   * ferme la réservation et libère l'excédent. Un second appel est sans effet.
   */
  async settle(
    requestId: string,
    usage: NormalizedUsage,
    extra: { providerCostUsd?: string | null; latencyMs?: number | null; litellmCallId?: string | null; estimated?: boolean } = {},
  ): Promise<{ credits: string; alreadySettled: boolean }> {
    return this.db.transaction(async (tx) => {
      const [req] = await tx.select().from(llmRequests).where(eq(llmRequests.id, requestId)).for('update');
      if (!req) throw new Error('Requête LLM inconnue');
      if (req.status === 'settled') return { credits: req.credits ?? '0', alreadySettled: true };
      const [coeff] = await tx.select().from(modelCoefficients).where(eq(modelCoefficients.id, req.coefficientId!));
      const credits = computeCredits(usage, coeff);
      await tx
        .insert(creditLedger)
        .values({
          idempotencyKey: `usage:${requestId}`,
          userId: req.userId,
          kind: 'usage',
          amount: toFixed8(credits),
          llmRequestId: requestId,
          coefficientId: req.coefficientId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          estimated: extra.estimated ?? false,
        })
        .onConflictDoNothing();
      await tx
        .update(llmRequests)
        .set({
          status: 'settled',
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          credits: toFixed8(credits),
          providerCostUsd: extra.providerCostUsd ?? null,
          latencyMs: extra.latencyMs ?? req.latencyMs,
          litellmCallId: extra.litellmCallId ?? req.litellmCallId,
          estimated: extra.estimated ?? false,
          settledAt: new Date(),
        })
        .where(eq(llmRequests.id, requestId));
      await tx
        .update(creditReservations)
        .set({ status: 'settled', closedAt: new Date() })
        .where(and(eq(creditReservations.llmRequestId, requestId), eq(creditReservations.status, 'open')));
      return { credits: toFixed8(credits), alreadySettled: false };
    });
  }

  /** Libère une réservation sans débit (échec avant toute génération facturable). */
  async release(requestId: string, error: string, httpStatus?: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(llmRequests)
        .set({ status: 'failed', error: error.slice(0, 2000), httpStatus: httpStatus ?? null, settledAt: new Date() })
        .where(and(eq(llmRequests.id, requestId), sql`${llmRequests.status} in ('reserved','streaming')`));
      await tx
        .update(creditReservations)
        .set({ status: 'released', closedAt: new Date() })
        .where(and(eq(creditReservations.llmRequestId, requestId), eq(creditReservations.status, 'open')));
    });
  }

  /**
   * Usage inconnu (flux interrompu, usage absent) : la réservation reste ouverte (elle continue de
   * compter) jusqu'à réconciliation ; aucune consommation n'est inventée.
   */
  async markPendingReconciliation(requestId: string, info: { litellmCallId?: string | null; error?: string }): Promise<void> {
    await this.db
      .update(llmRequests)
      .set({ status: 'pending_reconciliation', litellmCallId: info.litellmCallId ?? null, error: info.error?.slice(0, 2000) ?? null })
      .where(and(eq(llmRequests.id, requestId), sql`${llmRequests.status} in ('reserved','streaming')`));
  }

  /** Ajustement administratif (ledger, idempotent par clé fournie). */
  async adjust(input: { userId: string; amount: string; reason: string; actorId: string; idempotencyKey: string }) {
    await this.db
      .insert(creditLedger)
      .values({
        idempotencyKey: `adjust:${input.idempotencyKey}`,
        userId: input.userId,
        kind: 'adjustment',
        amount: toFixed8(input.amount),
        reason: input.reason,
        createdBy: input.actorId,
      })
      .onConflictDoNothing();
  }

  /* ---------------------------- Lecture ---------------------------- */

  async userWindows(userId: string): Promise<WindowUsageDto[]> {
    const limits = await this.userLimits(this.db, userId);
    return this.windowsFor('user', userId, limits);
  }

  /** L'utilisateur peut-il reprendre (toutes ses fenêtres sous la limite) ? Les quotas sont personnels. */
  async canProceed(userId: string): Promise<{ ok: boolean; window?: QuotaExceededError['window']; resetsAt?: Date | null }> {
    const settings = await this.settings.section('quotas');
    if (!settings.enabled) return { ok: true };
    for (const w of await this.userWindows(userId)) {
      if (!w.exempt && w.remaining !== null && new Decimal(w.remaining).lte(0)) {
        return { ok: false, window: w.window, resetsAt: w.resetsAt ? new Date(w.resetsAt) : null };
      }
    }
    return { ok: true };
  }

  private async windowsFor(kind: 'user', id: string, limits: Limits): Promise<WindowUsageDto[]> {
    const out: WindowUsageDto[] = [];
    for (const w of WINDOWS) {
      const used = await this.sumLedger(this.db, kind, id, w.ms);
      const reserved = await this.sumOpenReservations(this.db, kind, id);
      const limit = w.key === '5h' ? limits.limit5h : limits.limit7d;
      out.push({
        window: w.key,
        used: toFixed8(used),
        reserved: toFixed8(reserved),
        limit: limit === null ? null : toFixed8(limit),
        remaining: limit === null ? null : toFixed8(Decimal.max(0, new Decimal(limit).sub(used).sub(reserved))),
        exempt: limits.exempt,
        resetsAt: (await this.resetsAt(this.db, kind, id, w.ms))?.toISOString() ?? null,
      });
    }
    return out;
  }

  private async lockSubjects(tx: Tx, userId: string): Promise<void> {
    const keys = [`user:${userId}`];
    for (const k of keys) {
      await tx.execute(sql`insert into quota_locks(subject_key) values (${k}) on conflict do nothing`);
    }
    await tx.execute(
      sql`select subject_key from quota_locks where subject_key in (${sql.join(keys.map((k) => sql`${k}`), sql`, `)}) order by subject_key for update`,
    );
  }

  private async userLimits(tx: Tx | Database, userId: string): Promise<Limits> {
    const rows = await tx
      .select()
      .from(quotaPolicies)
      .where(
        and(
          eq(quotaPolicies.active, true),
          or(and(eq(quotaPolicies.scope, 'user'), eq(quotaPolicies.subjectId, userId)), eq(quotaPolicies.scope, 'global_user_default')),
        ),
      );
    const own = rows.find((r) => r.scope === 'user');
    const def = rows.find((r) => r.scope === 'global_user_default');
    const p = own ?? def;
    if (!p) return { limit5h: null, limit7d: null, exempt: false };
    return { limit5h: p.limit5h, limit7d: p.limit7d, exempt: p.exempt };
  }

  private async usedInWindow(tx: Tx, kind: 'user', id: string, ms: number): Promise<Decimal> {
    const [ledger, open] = await Promise.all([this.sumLedger(tx, kind, id, ms), this.sumOpenReservations(tx, kind, id)]);
    return ledger.add(open);
  }

  private async sumLedger(tx: Tx | Database, kind: 'user', id: string, ms: number): Promise<Decimal> {
    const col = creditLedger.userId;
    void kind;
    const [r] = await tx
      .select({ s: sql<string>`coalesce(sum(${creditLedger.amount}), 0)::text` })
      .from(creditLedger)
      .where(and(eq(col, id), sql`${creditLedger.occurredAt} > now() - (${ms} * interval '1 millisecond')`));
    return new Decimal(r.s);
  }

  private async sumOpenReservations(tx: Tx | Database, kind: 'user', id: string): Promise<Decimal> {
    const col = creditReservations.userId;
    void kind;
    const [r] = await tx
      .select({ s: sql<string>`coalesce(sum(${creditReservations.amount}), 0)::text` })
      .from(creditReservations)
      .where(and(eq(col, id), eq(creditReservations.status, 'open')));
    return new Decimal(r.s);
  }

  /** Instant où la plus ancienne consommation de la fenêtre en sortira. */
  private async resetsAt(tx: Tx | Database, kind: 'user', id: string, ms: number): Promise<Date | null> {
    const col = creditLedger.userId;
    void kind;
    const [r] = await tx
      .select({ t: sql<Date | null>`min(${creditLedger.occurredAt})` })
      .from(creditLedger)
      .where(and(eq(col, id), sql`${creditLedger.amount} > 0`, sql`${creditLedger.occurredAt} > now() - (${ms} * interval '1 millisecond')`));
    return r?.t ? new Date(new Date(r.t).getTime() + ms) : null;
  }

  /** Réservations expirées (gateway disparue) : passage en réconciliation. */
  async expireStaleReservations(): Promise<number> {
    const res = await this.db.execute(sql`
      with expired as (
        update credit_reservations set status = 'expired', closed_at = now()
        where status = 'open' and expires_at < now()
        returning llm_request_id
      )
      update llm_requests set status = 'pending_reconciliation'
      where id in (select llm_request_id from expired) and status in ('reserved','streaming')`);
    return res.rowCount ?? 0;
  }

  async pendingReconciliation(limit = 50) {
    return this.db
      .select()
      .from(llmRequests)
      .where(eq(llmRequests.status, 'pending_reconciliation'))
      .limit(limit);
  }

  /** Utilitaire de tests / admin. */
  async ledgerTotal(userId: string): Promise<string> {
    const [r] = await this.db
      .select({ s: sql<string>`coalesce(sum(${creditLedger.amount}), 0)::text` })
      .from(creditLedger)
      .where(eq(creditLedger.userId, userId));
    return toFixed8(r.s);
  }
}
