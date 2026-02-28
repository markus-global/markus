import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql } from 'drizzle-orm';
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

  // Ensure critical columns exist as a safety net (idempotent, safe to run every time)
  await applyEssentialColumns(db);
}

/**
 * Directly apply any essential column additions that might have been missed by the migrator.
 * Uses IF NOT EXISTS so it's completely safe to run on every startup.
 */
async function applyEssentialColumns(db: ReturnType<typeof getDb>): Promise<void> {
  const statements = [
    // chat_messages: segment metadata for persistent tool-call display
    `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS metadata jsonb`,
    // tasks: notes array for persistent task notes
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS notes jsonb DEFAULT '[]'`,
    // task_logs: structured execution log entries (audit + live display)
    `CREATE TABLE IF NOT EXISTS task_logs (
      id varchar(64) PRIMARY KEY,
      task_id varchar(64) NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id varchar(64) NOT NULL,
      seq integer NOT NULL DEFAULT 0,
      type varchar(32) NOT NULL,
      content text NOT NULL DEFAULT '',
      metadata jsonb DEFAULT '{}',
      created_at timestamp NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_task_logs_task ON task_logs (task_id, seq)`,
  ];
  for (const stmt of statements) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err) {
      log.warn('Failed to apply essential column/table', { error: String(err) });
    }
  }
}
