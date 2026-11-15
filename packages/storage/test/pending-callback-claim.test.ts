import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite, SqlitePendingCallbackRepo } from '../src/sqlite-storage.js';
import type { DatabaseSync } from 'node:sqlite';

/**
 * P3 precondition — no duplicate wakeup delivery across processes.
 *
 * Why this file exists: `pendingCallbackRegistry.setPersistence(...)` is wired in
 * production (api-server.ts:2046), and `setPersistence` calls `loadAll()`, so EVERY
 * process holds a full copy of every pending callback in its own memory. The sweep
 * then iterates that local copy. Before this change nothing arbitrated between
 * processes: two of them would each see the same wakeup as due and each deliver it.
 * Duplicate delivery is not cosmetic — a wakeup IS work, so it got done twice.
 *
 * The sibling table `mailbox_items` already carried claimed_by/lease_until for
 * exactly this reason; the callback queue simply never got the same pair. These
 * tests pin the claim, and the fact that it needs NO data rewrite: both columns are
 * nullable, so rows written before the change read as unclaimed and become claimable.
 */

let dir: string;
let db: DatabaseSync;
let repo: SqlitePendingCallbackRepo;

beforeEach(() => {
  closeSqlite();
  dir = mkdtempSync(join(tmpdir(), 'p3-claim-'));
  db = openSqlite(join(dir, 'data.db'));
  repo = new SqlitePendingCallbackRepo(db);
});
afterEach(() => {
  closeSqlite();
  rmSync(dir, { recursive: true, force: true });
});

const dueWakeup = (id: string): Parameters<SqlitePendingCallbackRepo['save']>[0] => ({
  id,
  agentId: 'agt_a',
  originSessionId: 'sess_1',
  type: 'wakeup',
  deliveryMode: 'mailbox',
  wakeAt: Date.now() - 1_000,
  registeredAt: Date.now() - 60_000,
  timeoutMs: 600_000,
});

describe('P3 — a due wakeup can be claimed exactly once', () => {
  it('the first claimer wins and every other process is refused', () => {
    repo.save(dueWakeup('cb_1'));

    expect(repo.claim('cb_1', 'proc-A#1', 60_000)).toBe(true);
    // The other process loaded the same row into its own memory; the claim is the
    // only thing that stops it delivering too.
    expect(repo.claim('cb_1', 'proc-B#2', 60_000)).toBe(false);
    expect(repo.claim('cb_1', 'proc-C#3', 60_000)).toBe(false);
  });

  it('a lease that expired becomes claimable again, so a crashed holder does not strand work', () => {
    repo.save(dueWakeup('cb_1'));

    const now = Date.now();
    expect(repo.claim('cb_1', 'proc-A', 60_000, now)).toBe(true);
    // Still inside the lease: nobody else may take it.
    expect(repo.claim('cb_1', 'proc-B', 60_000, now + 30_000)).toBe(false);
    // Past the lease: the holder is presumed gone, and the work resumes.
    expect(repo.claim('cb_1', 'proc-B', 60_000, now + 61_000)).toBe(true);
  });

  it('a row written before this change is readable AND claimable (no data rewrite)', () => {
    // Legacy shape: saved through the old code path, so no claim columns are set.
    repo.save(dueWakeup('cb_legacy'));

    const loaded = repo.loadAll().find((r) => r.id === 'cb_legacy');
    // Old rows still load exactly as before.
    expect(loaded).toBeDefined();
    expect(loaded?.wakeAt).toBeTypeOf('number');
    // And they are claimable, because NULL means unclaimed — the predicate treats
    // "no claim recorded" as "free", which is what keeps existing installs working.
    expect(repo.claim('cb_legacy', 'proc-A', 60_000)).toBe(true);
  });

  it('claiming a row that does not exist is refused, not silently "succeeded"', () => {
    // A silent success here would let a process deliver a callback it never owned.
    expect(repo.claim('cb_missing', 'proc-A', 60_000)).toBe(false);
  });

  it('two different callbacks do not block each other', () => {
    repo.save(dueWakeup('cb_1'));
    repo.save(dueWakeup('cb_2'));

    expect(repo.claim('cb_1', 'proc-A', 60_000)).toBe(true);
    // One claimed row must not lock the whole queue.
    expect(repo.claim('cb_2', 'proc-B', 60_000)).toBe(true);
  });
});
