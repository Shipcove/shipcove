import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.js';

/** Répertoire des migrations SQL livré avec le package. */
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', 'migrations');

/**
 * Applique les migrations sous verrou consultatif : plusieurs instances peuvent démarrer
 * simultanément sans exécuter deux fois la même migration.
 */
export async function runMigrations(db: Database): Promise<void> {
  const client = await db.$client.connect();
  try {
    await client.query('select pg_advisory_lock(7212024001)');
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await client.query('select pg_advisory_unlock(7212024001)').catch(() => undefined);
    client.release();
  }
}
