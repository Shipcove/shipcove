import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AuthProviderPublic } from '@cap/contracts';
import { authProviders, type Database } from '@cap/database';
import { DB } from '@cap/server-core';

/**
 * Registre des fournisseurs d'identité fédérés.
 * Seuls les types dont l'implémentation est enregistrée sont exposés publiquement.
 */
@Injectable()
export class ProvidersRegistry {
  private readonly implemented = new Set<string>();

  constructor(@Inject(DB) private readonly db: Database) {}

  register(type: string): void {
    this.implemented.add(type);
  }

  async publicList(): Promise<AuthProviderPublic[]> {
    const rows = await this.db.select().from(authProviders).where(eq(authProviders.enabled, true));
    return rows
      .filter((r) => this.implemented.has(r.type))
      .filter((r) => r.type !== 'github' && r.type !== 'gitlab' ? true : (r.config as { allowLogin?: boolean }).allowLogin !== false)
      .map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        startUrl: r.type === 'ldap' ? undefined : `/api/v1/auth/sso/${r.id}/start`,
      }));
  }
}
