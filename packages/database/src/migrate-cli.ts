import { createDatabase } from './client.js';
import { runMigrations } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL manquant');
  process.exit(1);
}
const db = createDatabase({ connectionString: url, max: 2, applicationName: 'cap-migrate' });
try {
  await runMigrations(db);
  console.log('Migrations appliquées');
} finally {
  await db.$client.end();
}
