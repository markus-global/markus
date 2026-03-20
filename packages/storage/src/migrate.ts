/**
 * PostgreSQL migration runner — removed.
 * SQLite handles schema creation on open via sqlite-storage.ts.
 */
export async function runMigrations(_databaseUrl?: string): Promise<void> {
  // no-op: SQLite creates tables automatically on connection
}
