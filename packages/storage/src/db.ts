/**
 * PostgreSQL support has been removed — Markus uses SQLite exclusively.
 * This module is kept as a stub so existing repo type definitions still compile.
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export function getDb(_url?: string): Database {
  throw new Error(
    'PostgreSQL support has been removed. Markus now uses SQLite exclusively. ' +
      'Do not set DATABASE_URL to a postgresql:// URL.'
  );
}

export async function closeDb(): Promise<void> {
  // no-op
}
