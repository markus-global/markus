/**
 * P1.x · 重投/恢复不丢 review_request —— storage 层集成测试（真实 SQLite）
 *
 * 锁定本卡 (a)(b)(d) 的持久层契约：
 *  1. `requeueItem(id,{queuedAt})` 是**无条件**回队（关键：不校验认领者）+ 刷新 `queued_at`；
 *     —— 与 `releaseClaim(id,ownerId)` 的 `WHERE claimed_by=?` 形成对照（跨实例必然 no-op）。
 *  2. `requeueItem` 不复活已收口行（`completed`/`merged`）；行不存在 → false。
 *  3. `findByDedupKey` 只读、只回最小字段、命中唯一索引 `uq_mailbox_agent_dedup`。
 *  4. (d) 启动清理**按类型分流**：strict-state 孤儿/过期租约 → 回队；
 *     非 strict-state → **逐字保持 drop**；租约未过期 → 不清理。
 *  5. (b) 存量运行期回队路径 `releaseExpiredLeases` 也必须刷新 `queued_at`。
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
  tempDir = mkdtempSync(join(tmpdir(), 'markus-mailbox-requeue-'));
  db = openSqlite(join(tempDir, 'test.db'));
  repo = new SqliteMailboxRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const NOW = '2026-09-12T00:00:00.000Z';
const PAST = '2026-09-01T00:00:00.000Z';
const FUTURE = '2026-09-13T00:00:00.000Z';

function row(id: string, sourceType = 'review_request', agentId = 'agt_1', dedupKey?: string) {
  return {
    id,
    agentId,
    sourceType,
    priority: 1,
    status: 'queued',
    payload: { summary: id, content: id, taskId: 'task_1', extra: { round: 1 } },
    metadata: {},
    queuedAt: NOW,
    dedupKey,
  };
}

/** 造「processing + 租约已过期」行（认领者用**异构 ownerId**，以贴近重启后的真实形态）。 */
function seedExpiredLeaseClaim(id: string, owner = 'agt_1#999#7') {
  repo.save(row(id, 'review_request', 'agt_1', `review_request:${id}:1`));
  repo.claimItem(id, owner, PAST, NOW);
}

describe('P1.x storage · requeueItem（最小写 API，(a)(b)(d)）', () => {
  it('无条件回队：释放**异构 ownerId** 的认领（不校验认领者）并刷新 queued_at', () => {
    seedExpiredLeaseClaim('q1');
    db.prepare('UPDATE mailbox_items SET queued_at = ? WHERE id = ?').run(PAST, 'q1');

    const before = repo.getById('q1')!;
    expect(before.status).toBe('processing');
    expect(before.claimedBy).toBe('agt_1#999#7');

    expect(repo.requeueItem('q1', { queuedAt: NOW })).toBe(true);

    const after = repo.getById('q1')!;
    expect(after.status).toBe('queued');
    expect(after.claimedBy, '认领者与调用方无关，必须被释放').toBeNull();
    expect(after.leaseUntil).toBeNull();
    expect(after.startedAt).toBeNull();
    expect(after.queuedAt, '(b) 必须刷新 queued_at，否则同轮恢复即被判 expired').toBe(NOW);
  });

  it('不复活已收口行（completed/merged）；行不存在返回 false', () => {
    repo.save(row('c1', 'review_request', 'agt_1', 'review_request:c1:1'));
    repo.updateStatus('c1', 'completed', { completedAt: NOW });

    expect(repo.requeueItem('c1')).toBe(false);
    expect(repo.getById('c1')!.status).toBe('completed');

    expect(repo.requeueItem('does_not_exist')).toBe(false);
  });
});

describe('P1.x storage · findByDedupKey（最小只读 API，(c)）', () => {
  it('只读 + 最小字段 + 命中唯一索引 uq_mailbox_agent_dedup', () => {
    repo.save(row('d1', 'review_request', 'agt_1', 'review_request:t3:1'));

    const plan = JSON.stringify(
      db.prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, status, claimed_by, lease_until, queued_at
           FROM mailbox_items WHERE agent_id = ? AND dedup_key = ? LIMIT 1`
      ).all('agt_1', 'review_request:t3:1'),
    );
    expect(plan, '必须命中部分唯一索引，不得退化为全表扫').toContain('uq_mailbox_agent_dedup');

    const before = repo.getById('d1')!;
    const found = repo.findByDedupKey('agt_1', 'review_request:t3:1')!;
    expect(found).toBeDefined();
    expect(Object.keys(found).sort()).toEqual(['claimedBy', 'id', 'leaseUntil', 'queuedAt', 'status']);
    expect((found as unknown as Record<string, unknown>)['payload'], '不得回传全量负载').toBeUndefined();
    expect(found.id).toBe('d1');
    expect(found.status).toBe('queued');

    // 只读：调用前后整行未变
    expect(repo.getById('d1')).toEqual(before);

    // agent 维度隔离 + 未命中
    expect(repo.findByDedupKey('agt_other', 'review_request:t3:1')).toBeUndefined();
    expect(repo.findByDedupKey('agt_1', 'review_request:nope:9')).toBeUndefined();
  });
});

describe('P1.x (d) · 启动清理按类型分流', () => {
  it('⑥a strict-state + 过期租约 → 回队（不再 drop），并刷新 queued_at + 清认领', () => {
    seedExpiredLeaseClaim('s1');
    db.prepare('UPDATE mailbox_items SET queued_at = ? WHERE id = ?').run(PAST, 's1');

    const dropped = repo.markStaleProcessingAsDropped('agt_1', NOW);

    expect(dropped, 'strict-state 不计入 dropped').toBe(0);
    const after = repo.getById('s1')!;
    expect(after.status).toBe('queued');
    expect(after.claimedBy).toBeNull();
    expect(after.leaseUntil).toBeNull();
    expect(after.startedAt).toBeNull();
    expect(after.queuedAt).toBe(NOW);
  });

  it('⑦ strict-state 孤儿行（claimed_by/lease_until 皆 NULL）→ 回队，不得无条件 dropped', () => {
    repo.save(row('o1', 'review_request', 'agt_1', 'review_request:o1:1'));
    db.prepare("UPDATE mailbox_items SET status = 'processing', started_at = ? WHERE id = ?").run(PAST, 'o1');

    expect(repo.markStaleProcessingAsDropped('agt_1', NOW)).toBe(0);
    const after = repo.getById('o1')!;
    expect(after.status).toBe('queued');
    expect(after.claimedBy).toBeNull();
    expect(after.leaseUntil).toBeNull();
    expect(after.queuedAt).toBe(NOW);
  });

  it('非 strict-state（heartbeat / a2a_message）维持 drop —— 行为逐字不变', () => {
    // heartbeat 孤儿 + a2a_message 过期租约，均为「候选行」但类型不属 strict-state
    repo.save(row('n1', 'heartbeat', 'agt_1'));
    db.prepare("UPDATE mailbox_items SET status = 'processing' WHERE id = ?").run('n1');
    repo.save(row('n2', 'a2a_message', 'agt_1'));
    repo.claimItem('n2', 'agt_1#999#7', PAST, NOW);

    expect(repo.markStaleProcessingAsDropped('agt_1', NOW)).toBe(2);
    expect(repo.getById('n1')!.status).toBe('dropped');
    expect(repo.getById('n2')!.status).toBe('dropped');
  });

  it('租约未过期的 strict-state 行不得被清理（保持 processing）', () => {
    repo.save(row('v1', 'review_request', 'agt_1', 'review_request:v1:1'));
    repo.claimItem('v1', 'agt_1#10#1', FUTURE, NOW);

    expect(repo.markStaleProcessingAsDropped('agt_1', NOW)).toBe(0);
    const after = repo.getById('v1')!;
    expect(after.status).toBe('processing');
    expect(after.claimedBy).toBe('agt_1#10#1');
    expect(after.leaseUntil).toBe(FUTURE);
  });

  it('混合批次：strict 回队、非 strict drop，计数只含 drop', () => {
    seedExpiredLeaseClaim('m1');          // strict → requeue
    repo.save(row('m2', 'heartbeat', 'agt_1'));
    db.prepare("UPDATE mailbox_items SET status = 'processing' WHERE id = ?").run('m2');

    expect(repo.markStaleProcessingAsDropped('agt_1', NOW)).toBe(1);
    expect(repo.getById('m1')!.status).toBe('queued');
    expect(repo.getById('m2')!.status).toBe('dropped');
  });
});

describe('P1.x (b) · 存量运行期回队路径同样刷新 queued_at', () => {
  it('releaseExpiredLeases 回收后 queued_at 已刷新（否则下次启动被判 expired）', () => {
    seedExpiredLeaseClaim('r1');
    db.prepare('UPDATE mailbox_items SET queued_at = ? WHERE id = ?').run(PAST, 'r1');

    expect(repo.releaseExpiredLeases('agt_1', NOW)).toBe(1);

    const after = repo.getById('r1')!;
    expect(after.status).toBe('queued');
    expect(after.claimedBy).toBeNull();
    expect(after.leaseUntil).toBeNull();
    expect(after.queuedAt, '回队不刷 queued_at = 白修（下次启动按 TTL 判 expired）').toBe(NOW);
  });
});
