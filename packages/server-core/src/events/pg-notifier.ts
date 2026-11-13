import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { ENV, type BaseEnv } from '../config/config.js';

export type NotifyChannel = 'cap_agent_events' | 'cap_job_done' | 'cap_run_control' | 'cap_jobs';
type Handler = (payload: string) => void;

/**
 * Connexion LISTEN unique par instance, multiplexée sur plusieurs canaux.
 * Reconnexion automatique ; les abonnés doivent tolérer des notifications manquées
 * (ils relisent toujours l'état en base : NOTIFY n'est qu'un signal de réveil).
 */
@Injectable()
export class PgNotifier implements OnModuleDestroy {
  private readonly logger = new Logger('PgNotifier');
  private client: pg.Client | null = null;
  private connecting: Promise<pg.Client> | null = null;
  private readonly handlers = new Map<NotifyChannel, Set<Handler>>();
  private closed = false;

  constructor(@Inject(ENV) private readonly env: BaseEnv) {}

  async on(channel: NotifyChannel, handler: Handler): Promise<() => void> {
    let set = this.handlers.get(channel);
    const isNew = !set;
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    const client = await this.connect();
    if (isNew) await client.query(`LISTEN ${channel}`);
    return () => {
      set!.delete(handler);
    };
  }

  private async connect(): Promise<pg.Client> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = new pg.Client({ connectionString: this.env.DATABASE_URL, application_name: 'cap-listen', keepAlive: true });
        client.on('notification', (msg) => {
          const set = this.handlers.get(msg.channel as NotifyChannel);
          if (!set) return;
          for (const h of set) {
            try {
              h(msg.payload ?? '');
            } catch (err) {
              this.logger.warn(`handler ${msg.channel}: ${(err as Error).message}`);
            }
          }
        });
        client.on('error', (err) => {
          if (this.closed) return;
          this.logger.error(`Connexion LISTEN perdue : ${err.message} — reconnexion`);
          this.client = null;
          this.connecting = null;
          setTimeout(() => void this.reconnect(), 1000);
        });
        await client.connect();
        for (const ch of this.handlers.keys()) await client.query(`LISTEN ${ch}`);
        this.client = client;
        return client;
      })().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async reconnect(): Promise<void> {
    try {
      await this.connect();
      // Réveille les abonnés pour qu'ils relisent l'état (notifications perdues).
      for (const [, set] of this.handlers) for (const h of set) h('');
    } catch {
      setTimeout(() => void this.reconnect(), 2000);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    await this.client?.end().catch(() => undefined);
  }
}
