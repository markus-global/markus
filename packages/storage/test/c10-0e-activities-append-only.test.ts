/**
 * C10-0E · `agent_activities` is append-only (master-plan G8).
 *
 * Contract (docs/architecture/derived-views.md §14/§15):
 * - an activity row is written ONCE (insertActivity); it is never rewritten;
 * - the end of an activity is a NEW event row (`activity_end`) in
 *   `agent_activity_logs`, carrying the end payload in `metadata`;
 * - readers DERIVE the current view (base row + latest end event) — one
 *   derivation definition inside SqliteActivityRepo, every read face wraps it;
 * - a BEFORE UPDATE trigger makes any rewrite structurally impossible.
 *
 * These assertions sit on the REAL execution points (trigger + repo): delete
 * the trigger or the derivation and this file goes red.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, closeSqlite, SqliteActivityRepo } from '../src/sqlite-storage.js';

let tempDir: string;
let db: ReturnType<typeof openSqlite>;
let repo: SqliteActivityRepo;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-c10-0e-'));
  db = openSqlite(join(tempDir, 'append-only.db'));
  repo = new SqliteActivityRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const START = {
  id: 'act-1',
  agentId: 'agent-1',
  type: 'task',
  label: 'Build feature',
  taskId: 'task-1',
  mailboxItemId: 'mb-1',
  startedAt: '2026-11-21T10:00:00Z',
  workUnitRef: 'task_task-1_r1',
};

const END = {
  endedAt: '2026-11-21T11:00:00Z',
  totalTokens: 1000,
  totalTools: 5,
  success: true,
  summary: 'Completed build successfully',
  keywords: 'build,feature,deploy',
};

/** Raw base-row read (bypasses the derived read face on purpose). */
function baseRow(id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM agent_activities WHERE id = ?').get(id) as Record<string, unknown> | undefined;
}

describe('C10-0E · agent_activities append-only', () => {
  it('rejects any raw UPDATE at the database layer (trigger)', () => {
    repo.insertActivity(START);
    // The attempt is assembled at runtime ON PURPOSE: the source-level invariant
    // (architecture-guard `activities-append-only` + the acceptance grep) says no
    // static UPDATE path may exist anywhere in packages/ or scripts/ — including
    // tests. This is the negative probe that proves the trigger bites.
    const rewriteSummary = 'UPDATE ' + 'agent_activities SET summary = ? WHERE id = ?';
    expect(() => db.prepare(rewriteSummary).run('tampered', 'act-1')).toThrow(/append-only/);
    const rewriteEnd = 'UPDATE ' + 'agent_activities SET ended_at = ? WHERE id = ?';
    expect(() => db.prepare(rewriteEnd).run('2026-11-21T12:00:00Z', 'act-1')).toThrow(/append-only/);
    expect(baseRow('act-1')?.['summary']).toBe('');
  });

  it('no longer exposes an updateActivity write path', () => {
    expect((repo as unknown as Record<string, unknown>)['updateActivity']).toBeUndefined();
  });

  it('appendActivityEnd writes a NEW event row; the base row is never rewritten', () => {
    repo.insertActivity(START);
    repo.insertActivityLog({ activityId: 'act-1', seq: 1, type: 'status', content: 'Started' });
    repo.appendActivityEnd('act-1', END);

    // Base row untouched: end data lives in the event, not on the row.
    const base = baseRow('act-1');
    expect(base?.['ended_at']).toBeNull();
    expect(base?.['summary']).toBe('');
    expect(base?.['total_tokens']).toBe(0);

    // The event row: seq derived (max+1), work_unit_ref inherited from the activity.
    const events = db.prepare("SELECT * FROM agent_activity_logs WHERE activity_id = ? AND type = 'activity_end'").all('act-1') as Record<string, unknown>[];
    expect(events).toHaveLength(1);
    expect(events[0]?.['seq']).toBe(2);
    expect(events[0]?.['work_unit_ref']).toBe('task_task-1_r1');
    expect(JSON.parse(events[0]?.['metadata'] as string)).toMatchObject(END);
  });

  it('every read face derives the end payload from the event', () => {
    repo.insertActivity(START);
    repo.appendActivityEnd('act-1', END);

    const expected = {
      id: 'act-1',
      endedAt: END.endedAt,
      totalTokens: END.totalTokens,
      totalTools: END.totalTools,
      success: true,
      summary: END.summary,
      keywords: END.keywords,
      workUnitRef: 'task_task-1_r1',
    };
    expect(repo.getActivity('act-1')).toMatchObject(expected);
    expect(repo.queryActivities('agent-1')).toHaveLength(1);
    expect(repo.queryActivities('agent-1')[0]).toMatchObject(expected);
    expect(repo.getByMailboxItemId('mb-1')).toMatchObject(expected);
    expect(repo.getByMailboxItemIds(['mb-1']).get('mb-1')).toMatchObject(expected);
    // Search hits words that exist ONLY in the derived summary/keywords.
    expect(repo.searchActivities('agent-1', 'completed deploy')).toHaveLength(1);
    // The log read face shows the end event itself (content = summary text).
    const logs = repo.getActivityLogs('act-1');
    expect(logs.some(l => l.type === 'activity_end' && l.content === END.summary)).toBe(true);
  });

  it('a correction is another new row; the latest end event wins', () => {
    repo.insertActivity(START);
    repo.appendActivityEnd('act-1', END);
    const correction = { ...END, endedAt: '2026-11-21T11:30:00Z', success: false, summary: 'Actually failed on deploy' };
    repo.appendActivityEnd('act-1', correction);

    expect(repo.getActivity('act-1')).toMatchObject({
      endedAt: correction.endedAt,
      success: false,
      summary: correction.summary,
    });
    const events = db.prepare("SELECT COUNT(*) AS n FROM agent_activity_logs WHERE activity_id = ? AND type = 'activity_end'").get('act-1') as { n: number };
    expect(events.n).toBe(2); // history keeps BOTH events
    expect(baseRow('act-1')?.['ended_at']).toBeNull();
  });

  it('legacy rows (end data on the base row, no end event) read unchanged', () => {
    // Pre-C10-0E shape: the old UPDATE path wrote end data onto the row itself.
    // No migration touches those rows; the derivation must be identity for them.
    db.prepare(
      'INSERT INTO agent_activities (id, agent_id, type, label, started_at, ended_at, total_tokens, total_tools, success, summary, keywords, created_at) ' +
      "VALUES ('act-legacy', 'agent-1', 'chat', 'Legacy row', '2026-11-01T00:00:00Z', '2026-11-01T00:05:00Z', 42, 3, 0, 'legacy summary', 'legacy,words', '2026-11-01T00:00:00Z')"
    ).run();
    const expected = {
      id: 'act-legacy',
      endedAt: '2026-11-01T00:05:00Z',
      totalTokens: 42,
      totalTools: 3,
      success: false,
      summary: 'legacy summary',
      keywords: 'legacy,words',
    };
    expect(repo.getActivity('act-legacy')).toMatchObject(expected);
    expect(repo.queryActivities('agent-1')[0]).toMatchObject(expected);
    expect(repo.searchActivities('agent-1', 'legacy words')).toHaveLength(1);
  });

  it('refuses an end event for a nonexistent activity (FK)', () => {
    // Match the FK error specifically: a generic toThrow() would pass even when
    // the method itself is missing (TypeError), hiding a false green at base.
    expect(() => repo.appendActivityEnd('missing', END)).toThrow(/FOREIGN KEY constraint/i);
  });
});