/**
 * 任务级「审核投递」读面 —— 真 Sqlite，不是夹具。
 *
 * 钉住的是判据本身：任务归属读**结构键**（payload.taskId 或轮次化幂等键前缀），
 * 且任务 id 里的 `_` 不能当 LIKE 通配符用 —— 否则 `tsk_a_b` 会把 `tsk_xb` 的行认领过来，
 * UI 就会给这张卡显示**别的任务**的审核记录（最坏的一种错：看起来有、其实是别人的）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite, SqliteMailboxRepo } from '../src/index.js';

let tempDir: string;

beforeEach(() => {
  closeSqlite();
  tempDir = mkdtempSync(join(tmpdir(), 'markus-review-sessions-'));
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const TASK = 'tsk_ab_12';
const OTHER = 'tsk_abX12'; // 与 TASK 只差 `_` 一位 —— LIKE 通配符会把两者混为一谈

function openRepo(): SqliteMailboxRepo {
  const db = openSqlite(join(tempDir, 'review.db'));
  return new SqliteMailboxRepo(db);
}

function seed(repo: SqliteMailboxRepo, over: {
  id: string;
  taskId?: string | null;
  dedupKey?: string | null;
  status?: string;
  queuedAt?: string;
}) {
  const payload: Record<string, unknown> = { extra: { round: 1 } };
  if (over.taskId) payload['taskId'] = over.taskId;
  repo.save({
    id: over.id,
    agentId: 'agt_reviewer',
    sourceType: 'review_request',
    priority: 1,
    status: over.status ?? 'completed',
    payload,
    metadata: {},
    queuedAt: over.queuedAt ?? '2026-11-01T00:00:00.000Z',
    ...(over.dedupKey ? { dedupKey: over.dedupKey } : {}),
  } as never);
}

describe('SqliteMailboxRepo.getReviewRequestsByTask', () => {
  it('returns every review dispatch of the task, oldest first', () => {
    const repo = openRepo();
    seed(repo, { id: 'mbx_2', taskId: TASK, status: 'completed', queuedAt: '2026-11-01T02:00:00.000Z' });
    seed(repo, { id: 'mbx_1', taskId: TASK, status: 'completed', queuedAt: '2026-11-01T01:00:00.000Z' });

    const rows = repo.getReviewRequestsByTask(TASK);
    expect(rows.map(r => r.id)).toEqual(['mbx_1', 'mbx_2']);
  });

  it('picks up legacy rows that only carry the round-scoped dedup key (no payload.taskId)', () => {
    const repo = openRepo();
    seed(repo, { id: 'mbx_legacy', taskId: null, dedupKey: `review_request:${TASK}:2` });

    expect(repo.getReviewRequestsByTask(TASK).map(r => r.id)).toEqual(['mbx_legacy']);
  });

  it('never leaks another task whose id differs only by the LIKE wildcard `_`', () => {
    const repo = openRepo();
    seed(repo, { id: 'mbx_mine', taskId: TASK });
    seed(repo, { id: 'mbx_theirs', taskId: null, dedupKey: `review_request:${OTHER}:1` });

    expect(repo.getReviewRequestsByTask(TASK).map(r => r.id)).toEqual(['mbx_mine']);
    expect(repo.getReviewRequestsByTask(OTHER).map(r => r.id)).toEqual(['mbx_theirs']);
  });

  it('ignores non-review mailbox rows even when they point at the same task', () => {
    const repo = openRepo();
    seed(repo, { id: 'mbx_review', taskId: TASK });
    repo.save({
      id: 'mbx_comment',
      agentId: 'agt_reviewer',
      sourceType: 'task_comment',
      priority: 2,
      status: 'completed',
      payload: { taskId: TASK, content: 'looks good', summary: 'looks good' },
      metadata: {},
      queuedAt: '2026-11-01T00:00:00.000Z',
    } as never);

    expect(repo.getReviewRequestsByTask(TASK).map(r => r.id)).toEqual(['mbx_review']);
  });
});
