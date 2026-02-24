import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { createLogger } from '@markus/shared';

const log = createLogger('database');

let dbInstance: ReturnType<typeof drizzle> | null = null;
let sqlClient: ReturnType<typeof postgres> | null = null;

export function getDb(url?: string) {
  if (dbInstance) return dbInstance;

  const connectionUrl = url ?? process.env['DATABASE_URL'] ?? 'postgresql://markus:markus@localhost:5432/markus';
  sqlClient = postgres(connectionUrl, { max: 10 });
  dbInstance = drizzle(sqlClient, { schema });

  log.info('Database connection established');
  return dbInstance;
}

export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = null;
    dbInstance = null;
    log.info('Database connection closed');
  }
}

export type Database = ReturnType<typeof getDb>;
