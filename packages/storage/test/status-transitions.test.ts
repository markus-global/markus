import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite, SqliteStatusTransitionRepo } from '../src/sqlite-storage.js';

let tempDir: string;
let db: ReturnType<typeof openSqlite>;
let repo: SqliteStatusTransitionRepo;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-st-test-'));
  db = openSqlite(join(tempDir, 'test.db'));
  repo = new SqliteStatusTransitionRepo(db);
});

afterEach(() => {
  closeSqlite(db);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SqliteStatusTransitionRepo', () => {
  it('records and retrieves a task transition', () => {
    repo.record({
      entityType: 'task',
      entityId: 'task-1',
      fromStatus: 'pending',
      toStatus: 'in_progress',
      changedById: 'user-1',
      changedByType: 'human',
      changedByName: 'Alice',
      reason: 'Approved',
    });

    const rows = repo.getByEntity('task', 'task-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: 'task',
      entityId: 'task-1',
      fromStatus: 'pending',
      toStatus: 'in_progress',
      changedById: 'user-1',
      changedByType: 'human',
      changedByName: 'Alice',
      reason: 'Approved',
    });
    expect(rows[0]!.createdAt).toBeTruthy();
    expect(rows[0]!.id).toBeGreaterThan(0);
  });

  it('records transitions with nullable fields', () => {
    repo.record({
      entityType: 'task',
      entityId: 'task-2',
      fromStatus: 'in_progress',
      toStatus: 'completed',
      changedByType: 'system',
    });

    const rows = repo.getByEntity('task', 'task-2');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.changedById).toBeNull();
    expect(rows[0]!.changedByName).toBeNull();
    expect(rows[0]!.reason).toBeNull();
    expect(rows[0]!.changedByType).toBe('system');
  });

  it('records and retrieves requirement transitions', () => {
    repo.record({
      entityType: 'requirement',
      entityId: 'req-1',
      fromStatus: 'pending',
      toStatus: 'in_progress',
      changedById: 'admin-1',
      changedByType: 'human',
      changedByName: 'Bob',
      reason: 'Approved by manager',
    });

    const rows = repo.getByEntity('requirement', 'req-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entityType: 'requirement',
      entityId: 'req-1',
      fromStatus: 'pending',
      toStatus: 'in_progress',
      changedByType: 'human',
    });
  });

  it('returns only transitions for the requested entity', () => {
    repo.record({ entityType: 'task', entityId: 'task-A', fromStatus: 'pending', toStatus: 'in_progress', changedByType: 'agent' });
    repo.record({ entityType: 'task', entityId: 'task-B', fromStatus: 'pending', toStatus: 'in_progress', changedByType: 'agent' });
    repo.record({ entityType: 'requirement', entityId: 'task-A', fromStatus: 'pending', toStatus: 'in_progress', changedByType: 'agent' });

    expect(repo.getByEntity('task', 'task-A')).toHaveLength(1);
    expect(repo.getByEntity('task', 'task-B')).toHaveLength(1);
    expect(repo.getByEntity('requirement', 'task-A')).toHaveLength(1);
  });

  it('returns transitions in chronological order', () => {
    repo.record({ entityType: 'task', entityId: 'task-1', fromStatus: 'pending', toStatus: 'in_progress', changedByType: 'human', changedByName: 'Step 1' });
    repo.record({ entityType: 'task', entityId: 'task-1', fromStatus: 'in_progress', toStatus: 'review', changedByType: 'agent', changedByName: 'Step 2' });
    repo.record({ entityType: 'task', entityId: 'task-1', fromStatus: 'review', toStatus: 'completed', changedByType: 'human', changedByName: 'Step 3' });

    const rows = repo.getByEntity('task', 'task-1');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.toStatus).toBe('in_progress');
    expect(rows[1]!.toStatus).toBe('review');
    expect(rows[2]!.toStatus).toBe('completed');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      repo.record({ entityType: 'task', entityId: 'task-many', fromStatus: `s${i}`, toStatus: `s${i + 1}`, changedByType: 'system' });
    }

    const limited = repo.getByEntity('task', 'task-many', 3);
    expect(limited).toHaveLength(3);
    expect(limited[0]!.fromStatus).toBe('s0');
  });

  it('covers all three actor types', () => {
    repo.record({ entityType: 'task', entityId: 't1', fromStatus: 'a', toStatus: 'b', changedByType: 'human', changedByName: 'User' });
    repo.record({ entityType: 'task', entityId: 't1', fromStatus: 'b', toStatus: 'c', changedByType: 'agent', changedById: 'agent-1' });
    repo.record({ entityType: 'task', entityId: 't1', fromStatus: 'c', toStatus: 'd', changedByType: 'system' });

    const rows = repo.getByEntity('task', 't1');
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.changedByType)).toEqual(['human', 'agent', 'system']);
  });

  it('returns empty array for nonexistent entity', () => {
    expect(repo.getByEntity('task', 'nonexistent')).toEqual([]);
    expect(repo.getByEntity('requirement', 'nonexistent')).toEqual([]);
  });
});
