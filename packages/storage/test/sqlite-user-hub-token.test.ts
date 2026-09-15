import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  openSqlite,
  closeSqlite,
  SqliteOrgRepo,
  SqliteUserRepo,
} from '../src/sqlite-storage.js';

let tempDir: string;
let dbPath: string;

function setupDb() {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-user-hub-token-'));
  dbPath = join(tempDir, 'test.db');
  return openSqlite(dbPath);
}

/** Seed the default org so users can reference it (FK) and return a user repo. */
function seedUsers(db: ReturnType<typeof openSqlite>) {
  const orgRepo = new SqliteOrgRepo(db);
  orgRepo.createOrg({ id: 'default', name: 'Default', ownerId: 'user-a' });
  return new SqliteUserRepo(db);
}

beforeEach(() => {
  setupDb();
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SqliteUserRepo hub token (per-user)', () => {
  it('hub_token column exists after schema init (migration present)', () => {
    const db = setupDb();
    const cols = db
      .prepare('PRAGMA table_info(users)')
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('hub_token');
  });

  it('getHubToken returns null when never set', () => {
    const db = setupDb();
    const repo = seedUsers(db);
    repo.create({
      id: 'user-a',
      orgId: 'default',
      name: 'User A',
      role: 'owner',
    });
    expect(repo.getHubToken('user-a')).toBeNull();
  });

  it('setHubToken persists per-user and is isolated across users', () => {
    const db = setupDb();
    const repo = seedUsers(db);
    repo.create({ id: 'user-a', orgId: 'default', name: 'User A', role: 'owner' });
    repo.create({ id: 'user-b', orgId: 'default', name: 'User B', role: 'member' });

    repo.setHubToken('user-a', 'token-A');
    repo.setHubToken('user-b', 'token-B');

    expect(repo.getHubToken('user-a')).toBe('token-A');
    expect(repo.getHubToken('user-b')).toBe('token-B');
    // Isolation — user B must never see A's token
    expect(repo.getHubToken('user-b')).not.toBe('token-A');
  });

  it('setHubToken(null) clears the stored token', () => {
    const db = setupDb();
    const repo = seedUsers(db);
    repo.create({ id: 'user-a', orgId: 'default', name: 'User A', role: 'owner' });
    repo.setHubToken('user-a', 'token-A');
    expect(repo.getHubToken('user-a')).toBe('token-A');
    repo.setHubToken('user-a', null);
    expect(repo.getHubToken('user-a')).toBeNull();
  });

  it('hub_token is NOT exposed via the default user mapping (no leak to /api/users)', () => {
    const db = setupDb();
    const repo = seedUsers(db);
    repo.create({ id: 'user-a', orgId: 'default', name: 'User A', role: 'owner' });
    repo.setHubToken('user-a', 'super-secret');
    const row = repo.findById('user-a') as Record<string, unknown> | null;
    expect(row).not.toBeNull();
    expect((row as { hubToken?: unknown }).hubToken).toBeUndefined();
  });
});