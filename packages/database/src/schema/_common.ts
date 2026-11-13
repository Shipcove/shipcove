import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/** Clé primaire UUIDv7 (fonction native PostgreSQL 18), ordonnable dans le temps. */
export const pk = () => uuid().primaryKey().default(sql`uuidv7()`);

/** Timestamp UTC (timestamptz). */
export const ts = () => timestamp({ withTimezone: true, mode: 'date' });

export const createdAt = () => ts().notNull().defaultNow();
export const updatedAt = () => ts().notNull().defaultNow();
