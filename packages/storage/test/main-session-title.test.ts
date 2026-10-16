import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite, SqliteChatSessionRepo } from '../src/sqlite-storage.js';

/**
 * The main chat session used to be created with the *literal* title 'Main', which
 * the UI then compared against (`titled !== 'Main'`) to decide "has a real title".
 * That is structure inferred from a payload value. `is_main` is the real flag, so
 * the title must stay NULL until something genuinely gives the session a name.
 */

let tempDir: string;
let dbPath: string;
let repo: SqliteChatSessionRepo;

function seedOrgAndAgent() {
  const db = openSqlite(dbPath);
  db.prepare('INSERT INTO organizations (id, name, owner_id) VALUES (?, ?, ?)').run('org-1', 'Org', 'owner-1');
  db.prepare('INSERT INTO agents (id, name, org_id, role_id, role_name) VALUES (?, ?, ?, ?, ?)')
    .run('agt-1', 'Agent', 'org-1', 'role-1', 'worker');
  return db;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-main-session-'));
  dbPath = join(tempDir, 'data.db');
  repo = new SqliteChatSessionRepo(seedOrgAndAgent());
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('getOrCreateMainSession — never fabricates a title', () => {
  it('creates the main session with a NULL title', () => {
    const s = repo.getOrCreateMainSession('agt-1');
    expect(s.isMain).toBe(true);
    expect(s.title).toBeNull();

    // NULL in storage, not merely in the mapped object.
    const row = openSqlite(dbPath)
      .prepare('SELECT title FROM chat_sessions WHERE id = ?')
      .get(s.id) as { title: string | null };
    expect(row.title).toBeNull();
  });

  it('promoting an existing session to main leaves its title untouched', () => {
    openSqlite(dbPath)
      .prepare('INSERT INTO chat_sessions (id, agent_id, user_id, title, is_main, created_at, last_message_at) VALUES (?,?,?,?,0,?,?)')
      .run('cs-x', 'agt-1', 'user-1', null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    const promoted = repo.getOrCreateMainSession('agt-1', 'user-1');
    expect(promoted.id).toBe('cs-x');
    expect(promoted.isMain).toBe(true);
    expect(promoted.title).toBeNull();
  });

  it('the v4 migration clears a legacy fabricated "Main" title on upgrade', () => {
    openSqlite(dbPath)
      .prepare('INSERT INTO chat_sessions (id, agent_id, user_id, title, is_main, created_at, last_message_at) VALUES (?,?,?,?,? ,?,?)')
      .run('cs-legacy', 'agt-1', 'user-1', 'Main', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    // Pretend this install already ran v3 (the gateway migration).
    openSqlite(dbPath).exec('PRAGMA user_version = 3');

    closeSqlite();
    const db = openSqlite(dbPath);

    const row = db.prepare('SELECT title FROM chat_sessions WHERE id = ?').get('cs-legacy') as { title: string | null };
    expect(row.title).toBeNull();
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4);
  });
});
