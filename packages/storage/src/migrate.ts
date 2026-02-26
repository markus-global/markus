import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createLogger } from '@markus/shared';
import { getDb } from './db.js';

const log = createLogger('migrations');

/**
 * Run pending drizzle migrations.
 * Idempotent: safe to call on every startup.
 * Migration files live in packages/storage/drizzle/
 */
export async function runMigrations(databaseUrl?: string): Promise<void> {
  const db = getDb(databaseUrl);
  try {
    // __dirname is not available in ESM; resolve relative to import.meta.url
    const migrationsFolder = new URL('../drizzle', import.meta.url).pathname;
    await migrate(db, { migrationsFolder });
    log.info('Database migrations applied successfully');
  } catch (err) {
    log.warn('Migration runner encountered an issue (tables may already exist via db:push)', {
      error: String(err),
    });
    // Non-fatal: if tables were created via db:push they are already up-to-date
  }
}
