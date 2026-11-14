import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AuthProviderPublic } from '@cap/contracts';
import { authProviders, type Database } from '@cap/database';
import { DB } from '@cap/server-core';

/** Liste publique (page de connexion) des fournisseurs d'identité activés. */
@Injectable()
export class ProvidersRegistry {
  constructor(@Inject(DB) private readonly db: Database) {}

  async publicList(): Promise<AuthProviderPublic[]> {
    const rows = await this.db.select().from(authProviders).where(eq(authProviders.enabled, true)).orderBy(authProviders.name);
    return rows
      .filter((r) => (r.type === 'github' || r.type === 'gitlab' ? (r.config as { allowLogin?: boolean }).allowLogin !== false : true))
      .map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        startUrl: r.type === 'ldap' ? undefined : `/api/v1/auth/sso/${r.id}/start`,
      }));
  }
}
