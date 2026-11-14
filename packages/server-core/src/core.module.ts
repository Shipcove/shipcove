import { Global, Inject, Injectable, Logger, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { createDatabase, runMigrations, type Database } from '@cap/database';
import { InMemorySecretProvider, VaultSecretProvider, type SecretProvider } from '@cap/secrets';
import { ENV, type BaseEnv } from './config/config.js';
import { DB, SECRETS } from './tokens.js';
import { AuditService } from './audit/audit.service.js';
import { SettingsService } from './settings/settings.service.js';
import { JobsService } from './jobs/jobs.service.js';
import { EventsService } from './events/events.service.js';
import { QuotaService } from './quota/quota.service.js';
import { NotificationService } from './notifications/notification.service.js';
import { ObjectStorage } from './storage/object-storage.js';
import { PgNotifier } from './events/pg-notifier.js';
import { GitProviderClient } from './git/git-provider.client.js';
import { RunQueueService } from './runs/run-queue.service.js';
import { EnvironmentService } from './environment/environment.service.js';


export interface CoreModuleOptions {
  env: BaseEnv;
  serviceName: string;
  /** Tests : fournir un SecretProvider (ex. InMemory). */
  secretProvider?: SecretProvider;
}

export function createSecretProvider(env: BaseEnv): SecretProvider {
  if (env.VAULT_AUTH_METHOD === 'token') {
    if (!env.VAULT_TOKEN) throw new Error('VAULT_TOKEN requis avec VAULT_AUTH_METHOD=token');
    return new VaultSecretProvider({ address: env.VAULT_ADDR, auth: { method: 'token', token: env.VAULT_TOKEN }, kvMount: env.VAULT_KV_MOUNT, namespace: env.VAULT_NAMESPACE });
  }
  if (env.VAULT_AUTH_METHOD === 'kubernetes') {
    if (!env.VAULT_K8S_ROLE) throw new Error('VAULT_K8S_ROLE requis');
    return new VaultSecretProvider({ address: env.VAULT_ADDR, auth: { method: 'kubernetes', role: env.VAULT_K8S_ROLE }, kvMount: env.VAULT_KV_MOUNT, namespace: env.VAULT_NAMESPACE });
  }
  return new VaultSecretProvider({
    address: env.VAULT_ADDR,
    auth: { method: 'approle', roleIdFile: env.VAULT_ROLE_ID_FILE, secretIdFile: env.VAULT_SECRET_ID_FILE },
    kvMount: env.VAULT_KV_MOUNT,
    namespace: env.VAULT_NAMESPACE,
  });
}

@Injectable()
class DbLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Database) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.$client.end().catch(() => undefined);
  }
}

@Global()
@Module({})
export class CoreModule {
  static forRoot(opts: CoreModuleOptions): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: ENV, useValue: opts.env },
        { provide: 'CAP_SERVICE_NAME', useValue: opts.serviceName },
        {
          provide: DB,
          useFactory: async () => {
            const db = createDatabase({
              connectionString: opts.env.DATABASE_URL,
              max: opts.env.DATABASE_POOL_MAX,
              applicationName: `cap-${opts.serviceName}`,
            });
            if (opts.env.DATABASE_MIGRATE_ON_START) {
              new Logger('Database').log('Application des migrations…');
              await runMigrations(db);
            }
            return db;
          },
        },
        {
          provide: SECRETS,
          useFactory: () => opts.secretProvider ?? createSecretProvider(opts.env),
        },
        DbLifecycle,
        PgNotifier,
        ObjectStorage,
        AuditService,
        SettingsService,
        JobsService,
        EventsService,
        QuotaService,
        NotificationService,
        GitProviderClient,
        RunQueueService,
        EnvironmentService,
      ],
      exports: [
        ENV,
        'CAP_SERVICE_NAME',
        DB,
        SECRETS,
        PgNotifier,
        ObjectStorage,
        AuditService,
        SettingsService,
        JobsService,
        EventsService,
        QuotaService,
        NotificationService,
        GitProviderClient,
        RunQueueService,
        EnvironmentService,
      ],
    };
  }
}

export { InMemorySecretProvider };
