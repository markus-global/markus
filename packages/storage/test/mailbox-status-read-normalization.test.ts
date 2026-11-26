/**
 * 第六刀 C3 · 读路径归一在**聚合与筛选**上同样是唯一事实源。
 *
 * 为什么需要这一组测试：状态改名（删 `dropped`、加 `bounced` / `catch_all`）之后，
 * `mapRow()` 已把单行读归一，但两个**聚合/筛选**入口仍读原始列：
 *   ① `getStatusCounts()` 直接 GROUP BY 原始 status → UI 上 `dropped` 计数单独出现，
 *      而 `bounced` / `catch_all` 的计数要么缺失、要么与历史行分叉；
 *   ② `getHistory({ status })` 用 `status = ?` 精确匹配 → 按 `bounced` 筛不到历史
 *      `dropped` 行，「同一个事实两种写法」在筛选路径上复活。
 *
 * 断言方式：走真实 SQLite（夹具会撒谎，所以用真库），断言**对外的行为**而不是 SQL 文本。
 * 断言强度：既断言「会命中」，也断言「不会命中不该命中的」——只测前者时，
 * 把 `status = ?` 换成 `status <> ?` 也能绿。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, closeSqlite, SqliteMailboxRepo } from '../src/sqlite-storage.js';

let tempDir: string;
let db: ReturnType<typeof openSqlite>;
let repo: SqliteMailboxRepo;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-mailbox-norm-'));
  db = openSqlite(join(tempDir, 'test.db'));
  repo = new SqliteMailboxRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const NOW = '2026-11-12T00:00:00.000Z';

function row(id: string, status: string, queuedAt = NOW) {
  return {
    id,
    agentId: 'agt_norm',
    sourceType: 'a2a_message',
    priority: 2,
    status,
    payload: { summary: id, content: id },
    metadata: {},
    queuedAt,
  };
}

/** 造一条**历史** dropped 行（C3 之前落库的形态：没有 drop_reason / bounce_target）。 */
function seedLegacyDropped(id: string, queuedAt = NOW) {
  db.prepare(
    `INSERT INTO mailbox_items (id, agent_id, source_type, priority, status, payload, metadata, queued_at)
     VALUES (?, ?, ?, ?, 'dropped', ?, '{}', ?)`,
  ).run(id, 'agt_norm', 'a2a_message', 2, JSON.stringify({ summary: id, content: id }), queuedAt);
}

describe('getStatusCounts —— 读归一（历史 dropped 合并进 bounced）', () => {
  it('历史 dropped 行计入 bounced，且不再单独出现 dropped 键', () => {
    seedLegacyDropped('legacy_1');
    seedLegacyDropped('legacy_2');
    repo.save(row('bounced_1', 'bounced'));
    repo.save(row('catch_1', 'catch_all'));
    repo.save(row('queued_1', 'queued'));

    const counts = repo.getStatusCounts('agt_norm');

    expect(counts['bounced']).toBe(3); // 2 条历史 dropped + 1 条真 bounced
    expect(counts['catch_all']).toBe(1);
    expect(counts['queued']).toBe(1);
    expect(counts['dropped'], '历史终态不得作为独立键泄漏给调用方').toBeUndefined();
  });

  it('没有历史行时不影响当前计数（回归：不能把 bounced 算两遍）', () => {
    repo.save(row('b1', 'bounced'));
    repo.save(row('c1', 'catch_all'));

    const counts = repo.getStatusCounts('agt_norm');

    expect(counts['bounced']).toBe(1);
    expect(counts['catch_all']).toBe(1);
    expect(Object.keys(counts).sort()).toEqual(['bounced', 'catch_all']);
  });
});

describe('getHistory({ status }) —— 筛选也要命中历史 dropped 行', () => {
  beforeEach(() => {
    seedLegacyDropped('legacy_h1', '2026-11-12T00:00:01.000Z');
    seedLegacyDropped('legacy_h2', '2026-11-12T00:00:02.000Z');
    repo.save(row('real_bounced', 'bounced', '2026-11-12T00:00:03.000Z'));
    repo.save(row('real_queued', 'queued', '2026-11-12T00:00:04.000Z'));
  });

  it('按 bounced 筛选：命中 2 条历史 dropped + 1 条真 bounced，且不夹带 queued', () => {
    const rows = repo.getHistory('agt_norm', { status: 'bounced' });
    const ids = rows.map(r => r.id).sort();

    expect(ids).toEqual(['legacy_h1', 'legacy_h2', 'real_bounced']);
    expect(ids).not.toContain('real_queued');
    // 归一后的对外状态必须是 bounced —— 调用方看不到旧名
    expect(rows.every(r => r.status === 'bounced')).toBe(true);
  });

  it('按 dropped 筛选（旧调用方还没改名）：同样命中，不返回空', () => {
    const rows = repo.getHistory('agt_norm', { status: 'dropped' });
    const ids = rows.map(r => r.id).sort();

    expect(ids).toEqual(['legacy_h1', 'legacy_h2', 'real_bounced']);
  });

  it('按其它状态筛选不受影响（回归：归一不能把 queued 吞掉）', () => {
    const rows = repo.getHistory('agt_norm', { status: 'queued' });
    expect(rows.map(r => r.id)).toEqual(['real_queued']);
  });
});
