import { readFileSync } from 'node:fs';
import { createDatabase } from './client.js';
import { runMigrations } from './migrate.js';

// DATABASE_URL ou DATABASE_URL_FILE (secret Docker / Kubernetes monté en fichier).
const url = process.env.DATABASE_URL ?? (process.env.DATABASE_URL_FILE ? readFileSync(process.env.DATABASE_URL_FILE, 'utf8').trim() : undefined);
if (!url) {
  console.error('DATABASE_URL (ou DATABASE_URL_FILE) manquant');
  process.exit(1);
}
const db = createDatabase({ connectionString: url, max: 2, applicationName: 'cap-migrate' });
try {
  await runMigrations(db);
  console.log('Migrations appliquées');
} finally {
  await db.$client.end();
}
