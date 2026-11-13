import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import type { SecretProvider } from '@cap/secrets';
import type { Database } from '@cap/database';
import { DB, ObjectStorage, SECRETS } from '@cap/server-core';
import { Public } from '../common/decorators.js';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SECRETS) private readonly secrets: SecretProvider,
    private readonly storage: ObjectStorage,
  ) {}

  /** Vivacité : le processus répond (sans dépendances externes). */
  @Public()
  @Get('live')
  live() {
    return { status: 'up' };
  }

  /** Disponibilité : PostgreSQL, Vault et S3 joignables. */
  @Public()
  @Get('ready')
  async ready() {
    const checks: Record<string, { status: 'up' | 'down'; detail?: string }> = {};
    try {
      await this.db.execute(sql`select 1`);
      checks.database = { status: 'up' };
    } catch (err) {
      checks.database = { status: 'down', detail: (err as Error).message };
    }
    const vault = await this.secrets.health();
    checks.secrets = vault.ok ? { status: 'up' } : { status: 'down', detail: vault.detail };
    const s3 = await this.storage.health();
    checks.storage = s3.ok ? { status: 'up' } : { status: 'down', detail: 'S3 indisponible' };
    const ok = Object.values(checks).every((c) => c.status === 'up');
    // Détails internes non exposés publiquement.
    const body = { status: ok ? 'up' : 'down', checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.status])) };
    if (!ok) throw new ServiceUnavailableException(body);
    return body;
  }
}
