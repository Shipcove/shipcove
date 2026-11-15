import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { agentRuns, runTokens, type Database } from '@cap/database';
import { DB, sha256Hex } from '@cap/server-core';

export interface RunPrincipal {
  tokenId: string;
  workspaceId: string;
  userId: string;
  runId: string | null;
  runStatus: string | null;
}

/** Authentifie les jetons de run présentés par Pi depuis une sandbox. */
@Injectable()
export class RunTokenService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async authenticate(authorization: string | undefined): Promise<RunPrincipal | null> {
    const m = /^Bearer\s+(cap_rt_[A-Za-z0-9_-]{20,})$/.exec(authorization ?? '');
    if (!m) return null;
    const [t] = await this.db
      .select()
      .from(runTokens)
      .where(and(eq(runTokens.tokenHash, sha256Hex(m[1])), isNull(runTokens.revokedAt), gt(runTokens.expiresAt, sql`now()`)));
    if (!t) return null;
    const [run] = await this.db
      .select({ id: agentRuns.id, status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspaceId, t.workspaceId), inArray(agentRuns.status, ['running', 'interrupting', 'paused_quota', 'queued'])))
      .orderBy(desc(agentRuns.queuedAt))
      .limit(1);
    return { tokenId: t.id, workspaceId: t.workspaceId, userId: t.userId, runId: run?.id ?? null, runStatus: run?.status ?? null };
  }
}
