import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import pg from 'pg';
import { EVENT_SCHEMA_VERSION, type AgentEventDataMap, type AgentEventType, type EventEnvelope } from '@cap/contracts';
import { agentEvents, type Database, type DbOrTx } from '@cap/database';
import { ENV, type BaseEnv } from '../config/config.js';
import { DB } from '../tokens.js';
import { redact } from '../common/redact.js';

export interface NewEvent<T extends AgentEventType = AgentEventType> {
  type: T;
  runId?: string | null;
  data: AgentEventDataMap[T];
}

type Listener = (workspaceId: string, lastSeq: number) => void;

/**
 * Journal d'événements agentiques persistant + diffusion inter-instances (LISTEN/NOTIFY).
 * La séquence est allouée atomiquement sur la ligne du workspace (monotone, sans trou).
 */
@Injectable()
export class EventsService implements OnModuleDestroy {
  private readonly logger = new Logger('Events');
  private listenClient: pg.Client | null = null;
  private listenPromise: Promise<void> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: BaseEnv,
  ) {}

  /** Ajoute des événements (expurgés) et notifie toutes les instances. */
  async append(workspaceId: string, events: NewEvent[], tx?: DbOrTx): Promise<EventEnvelope[]> {
    if (events.length === 0) return [];
    const run = async (t: DbOrTx) => {
      const res = await t.execute<{ last_event_seq: number }>(sql`
        update workspaces set last_event_seq = last_event_seq + ${events.length}
        where id = ${workspaceId}
        returning last_event_seq`);
      const last = Number(res.rows[0]?.last_event_seq);
      if (!Number.isFinite(last)) throw new Error(`workspace ${workspaceId} introuvable`);
      const first = last - events.length + 1;
      const now = new Date();
      const rows = events.map((e, i) => ({
        workspaceId,
        seq: first + i,
        runId: e.runId ?? null,
        type: e.type,
        data: redact(e.data) as object,
        createdAt: now,
      }));
      await t.insert(agentEvents).values(rows);
      await t.execute(sql`select pg_notify('cap_agent_events', ${`${workspaceId}:${last}`})`);
      return rows.map((r) => this.toEnvelope(r));
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  async emit<T extends AgentEventType>(workspaceId: string, type: T, data: AgentEventDataMap[T], runId?: string | null, tx?: DbOrTx) {
    const [e] = await this.append(workspaceId, [{ type, data, runId }], tx);
    return e;
  }

  async readAfter(workspaceId: string, afterSeq: number, limit = 500): Promise<EventEnvelope[]> {
    const rows = await this.db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.workspaceId, workspaceId), gt(agentEvents.seq, afterSeq)))
      .orderBy(asc(agentEvents.seq))
      .limit(limit);
    return rows.map((r) => this.toEnvelope(r));
  }

  /** Plus petit seq encore disponible (après purge de rétention). */
  async oldestSeq(workspaceId: string): Promise<number | null> {
    const res = await this.db.execute<{ m: number | null }>(
      sql`select min(seq) as m from agent_events where workspace_id = ${workspaceId}`,
    );
    const m = res.rows[0]?.m;
    return m === null || m === undefined ? null : Number(m);
  }

  async lastSeq(workspaceId: string): Promise<number> {
    const res = await this.db.execute<{ s: number }>(sql`select last_event_seq as s from workspaces where id = ${workspaceId}`);
    return Number(res.rows[0]?.s ?? 0);
  }

  /** Abonnement aux notifications inter-instances (connexion LISTEN dédiée, partagée). */
  async subscribe(listener: Listener): Promise<() => void> {
    await this.ensureListening();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async ensureListening(): Promise<void> {
    if (this.listenClient) return;
    if (!this.listenPromise) {
      this.listenPromise = (async () => {
        const client = new pg.Client({ connectionString: this.env.DATABASE_URL, application_name: 'cap-listen' });
        client.on('notification', (msg) => {
          if (msg.channel !== 'cap_agent_events' || !msg.payload) return;
          const idx = msg.payload.lastIndexOf(':');
          const ws = msg.payload.slice(0, idx);
          const seq = Number(msg.payload.slice(idx + 1));
          for (const l of this.listeners) {
            try {
              l(ws, seq);
            } catch (err) {
              this.logger.warn(`listener: ${(err as Error).message}`);
            }
          }
        });
        client.on('error', (err) => {
          this.logger.error(`Connexion LISTEN perdue : ${err.message} — reconnexion`);
          this.listenClient = null;
          this.listenPromise = null;
          setTimeout(() => void this.ensureListening().catch(() => undefined), 1000);
        });
        await client.connect();
        await client.query('LISTEN cap_agent_events');
        this.listenClient = client;
      })().catch((err) => {
        this.listenPromise = null;
        throw err;
      });
    }
    await this.listenPromise;
  }

  async onModuleDestroy(): Promise<void> {
    await this.listenClient?.end().catch(() => undefined);
  }

  private toEnvelope(r: { workspaceId: string; seq: number; runId: string | null; type: string; data: unknown; createdAt: Date }): EventEnvelope {
    return {
      v: EVENT_SCHEMA_VERSION,
      id: Number(r.seq),
      workspaceId: r.workspaceId,
      runId: r.runId,
      type: r.type as AgentEventType,
      ts: r.createdAt.toISOString(),
      data: r.data as never,
    };
  }
}
