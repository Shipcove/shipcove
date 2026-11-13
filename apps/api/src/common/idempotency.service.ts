import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { idempotencyKeys, type Database } from '@cap/database';
import { AppError, DB, canonicalJson, sha256Hex } from '@cap/server-core';

const KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * En-tête `Idempotency-Key` pour les opérations critiques : une même clé rejouée avec la même
 * requête renvoie la réponse initiale sans ré-exécuter ; avec une requête différente → 409.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async run<T>(userId: string, key: string | undefined, route: string, body: unknown, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    if (!KEY_RE.test(key)) throw new AppError('validation_failed', 'Idempotency-Key invalide');
    const hash = sha256Hex(canonicalJson({ route, body }));
    const inserted = await this.db
      .insert(idempotencyKeys)
      .values({ key, userId, route, requestHash: hash, expiresAt: new Date(Date.now() + 24 * 3600_000) })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      const [row] = await this.db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
      if (row.requestHash !== hash) throw new AppError('idempotency_conflict', 'Clé d’idempotence déjà utilisée pour une autre requête');
      if (row.status === 'completed') return row.responseBody as T;
      throw new AppError('conflict', 'Requête identique en cours de traitement');
    }
    try {
      const result = await fn();
      await this.db
        .update(idempotencyKeys)
        .set({ status: 'completed', responseStatus: 200, responseBody: (result ?? null) as object })
        .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
      return result;
    } catch (err) {
      // Échec : la clé est libérée pour permettre un nouvel essai explicite.
      await this.db.execute(sql`delete from idempotency_keys where user_id = ${userId} and key = ${key}`);
      throw err;
    }
  }
}
