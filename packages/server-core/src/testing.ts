import { sql } from 'drizzle-orm';
import { createDatabase, runMigrations, type Database } from '@cap/database';

/** Base d'intégration partagée par les tests (`TEST_DATABASE_URL`). */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://cap:cap@localhost:5432/cap_test';

export async function createTestDatabase(): Promise<Database> {
  const db = createDatabase({ connectionString: TEST_DATABASE_URL, max: 20, applicationName: 'cap-test' });
  await runMigrations(db);
  return db;
}

/** Vide toutes les tables applicatives (hors journal de migrations). */
export async function truncateAll(db: Database): Promise<void> {
  const res = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = res.rows.map((r) => `"${r.tablename}"`).join(', ');
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
}
