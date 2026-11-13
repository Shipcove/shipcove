import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema> & { $client: pg.Pool };
/** Transaction Drizzle (même API que `Database`). */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Tx;

// numeric -> string (décimal exact), int8 -> number (séquences < 2^53).
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export interface CreateDatabaseOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
  statementTimeoutMs?: number;
}

export function createPool(opts: CreateDatabaseOptions): pg.Pool {
  return new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    application_name: opts.applicationName ?? 'cap',
    statement_timeout: opts.statementTimeoutMs ?? 30_000,
    idleTimeoutMillis: 30_000,
  });
}

export function createDatabase(opts: CreateDatabaseOptions): Database {
  const pool = createPool(opts);
  return drizzle({ client: pool, schema, casing: 'snake_case' }) as Database;
}
