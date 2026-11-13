import { sql } from 'drizzle-orm';
import type { Database } from '@cap/database';

export interface Lease {
  workspaceId: string;
  holder: string;
  fencingToken: number;
  expiresAt: Date;
}

/**
 * Lease d'écriture exclusif par workspace avec fencing token monotone (SPEC §11, §20).
 * - `acquire` réussit si le lease est libre, expiré, ou déjà détenu par le même holder ;
 *   chaque nouvelle acquisition incrémente le fencing token.
 * - Toute écriture durable vérifie le token : un ancien détenteur (pause GC, partition réseau)
 *   ne peut plus publier après qu'un autre a acquis le lease.
 */
export class LeaseService {
  constructor(private readonly db: Database) {}

  async acquire(workspaceId: string, holder: string, ttlMs: number): Promise<Lease | null> {
    const res = await this.db.execute<{ holder: string; fencing_token: number; expires_at: Date }>(sql`
      insert into workspace_leases (workspace_id, holder, fencing_token, expires_at, acquired_at, updated_at)
      values (${workspaceId}, ${holder}, 1, now() + (${ttlMs} * interval '1 millisecond'), now(), now())
      on conflict (workspace_id) do update set
        holder = excluded.holder,
        fencing_token = workspace_leases.fencing_token + 1,
        expires_at = excluded.expires_at,
        acquired_at = now(),
        updated_at = now()
      where workspace_leases.holder is null
         or workspace_leases.expires_at is null
         or workspace_leases.expires_at < now()
      returning holder, fencing_token, expires_at`);
    const row = res.rows[0];
    if (!row) return null;
    return { workspaceId, holder: row.holder, fencingToken: Number(row.fencing_token), expiresAt: new Date(row.expires_at) };
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    const res = await this.db.execute(sql`
      update workspace_leases set expires_at = now() + (${ttlMs} * interval '1 millisecond'), updated_at = now()
      where workspace_id = ${lease.workspaceId} and holder = ${lease.holder} and fencing_token = ${lease.fencingToken}`);
    return (res.rowCount ?? 0) > 0;
  }

  async release(lease: Lease): Promise<void> {
    await this.db.execute(sql`
      update workspace_leases set holder = null, expires_at = null, updated_at = now()
      where workspace_id = ${lease.workspaceId} and holder = ${lease.holder} and fencing_token = ${lease.fencingToken}`);
  }

  async current(workspaceId: string): Promise<{ holder: string | null; fencingToken: number; expiresAt: Date | null } | null> {
    const res = await this.db.execute<{ holder: string | null; fencing_token: number; expires_at: Date | null }>(
      sql`select holder, fencing_token, expires_at from workspace_leases where workspace_id = ${workspaceId}`,
    );
    const r = res.rows[0];
    return r ? { holder: r.holder, fencingToken: Number(r.fencing_token), expiresAt: r.expires_at } : null;
  }
}
