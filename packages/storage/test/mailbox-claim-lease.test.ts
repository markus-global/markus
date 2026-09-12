/**
 * P0 · mailbox 原子认领 / 租约 / 幂等键 —— storage 层集成测试（真实 SQLite）
 *
 * 验证持久层契约（对应需求 req_236bca1ab0ca8ed425537bed 验收 1–3）：
 *  1. `claimItem` 是**条件更新**，并发下唯一胜者（第二次必 false）；
 *  2. 幂等键 `(agent_id, dedup_key)` 唯一索引拒绝重复行，`dedup_key` 为 NULL 不受约束；
 *  3. 租约过期经 `releaseExpiredLeases` 回收后可被重新认领；
 *  4. `renewLease` / `releaseClaim` 只作用于**本人**认领；
 *  5. 启动清理只回收「无认领/租约已过期」的行，不误杀有效租约。
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
  tempDir = mkdtempSync(join(tmpdir(), 'markus-mailbox-claim-'));
  db = openSqlite(join(tempDir, 'test.db'));
  repo = new SqliteMailboxRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

const now = () => new Date();
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

function row(id: string, agentId = 'agt_1', dedupKey?: string) {
  return {
    id,
    agentId,
    sourceType: 'review_request',
    priority: 1,
    status: 'queued',
    payload: { summary: 'review', content: 'please review' },
    metadata: {},
    queuedAt: new Date().toISOString(),
    dedupKey,
  };
}

describe('P0 幂等键 · items 唯一键（根因 #5）', () => {
  it('同 agent + 同 dedup_key 的第二次插入被拒绝，库里只有一行', () => {
    expect(repo.save(row('mbx_1', 'agt_1', 'review_request:tsk_1:1')), '首插成功').toBe(true);
    expect(repo.save(row('mbx_2', 'agt_1', 'review_request:tsk_1:1')), '重复被拒').toBe(false);

    const all = repo.getByAgent('agt_1');
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe('mbx_1');
  });

  it('不同 round 的 dedup_key 互不影响（多轮评审可各自投递）', () => {
    expect(repo.save(row('mbx_r1', 'agt_1', 'review_request:tsk_1:1'))).toBe(true);
    expect(repo.save(row('mbx_r2', 'agt_1', 'review_request:tsk_1:2'))).toBe(true);
    expect(repo.getByAgent('agt_1')).toHaveLength(2);
  });

  it('dedup_key 为 NULL（无幂等语义的类型）不受唯一约束', () => {
    expect(repo.save(row('mbx_n1'))).toBe(true);
    expect(repo.save(row('mbx_n2'))).toBe(true);
    expect(repo.getByAgent('agt_1')).toHaveLength(2);
  });

  it('不同 agent 的相同 dedup_key 互不冲突（键含 agent_id）', () => {
    expect(repo.save(row('mbx_a', 'agt_1', 'review_request:tsk_1:1'))).toBe(true);
    expect(repo.save(row('mbx_b', 'agt_2', 'review_request:tsk_1:1'))).toBe(true);
  });

  it('重复 id 幂等（不抛异常、不产生第二行）', () => {
    expect(repo.save(row('mbx_dup'))).toBe(true);
    expect(repo.save(row('mbx_dup'))).toBe(false);
    expect(repo.getByAgent('agt_1')).toHaveLength(1);
  });
});

describe('P0 原子认领 · claimItem（根因 #2）', () => {
  it('第二次认领必失败（唯一胜者），且行进入 processing 并记录认领者', () => {
    repo.save(row('mbx_c1'));
    const t = now().toISOString();

    expect(repo.claimItem('mbx_c1', 'owner-A', iso(600_000), t), 'A 胜出').toBe(true);
    expect(repo.claimItem('mbx_c1', 'owner-B', iso(600_000), t), 'B 失败').toBe(false);

    const r = repo.getById('mbx_c1')!;
    expect(r.status).toBe('processing');
    expect(r.claimedBy).toBe('owner-A');
    expect(r.leaseUntil).toBeTruthy();
  });

  it('已被有效租约持有的行不可被再次认领（防重复处理）', () => {
    repo.save(row('mbx_c2'));
    const t = now().toISOString();
    expect(repo.claimItem('mbx_c2', 'owner-A', iso(600_000), t)).toBe(true);
    expect(repo.claimItem('mbx_c2', 'owner-B', iso(600_000), t)).toBe(false);
  });
});

describe('P0 租约 · 续租 / 释放 / 过期回收（验收 3）', () => {
  it('租约过期 → 回收 → 可被重新认领', () => {
    repo.save(row('mbx_l1'));
    const t = now().toISOString();
    // 认领时就给一个「已过期」的租约（模拟持有者崩溃/未续租）。
    expect(repo.claimItem('mbx_l1', 'dead', iso(-60_000), t)).toBe(true);
    expect(repo.releaseExpiredLeases('agt_1', t), '回收 1 条').toBe(1);

    const r = repo.getById('mbx_l1')!;
    expect(r.status).toBe('queued');
    expect(r.claimedBy).toBeNull();
    expect(r.leaseUntil).toBeNull();

    expect(repo.claimItem('mbx_l1', 'owner-B', iso(600_000), t), '回收后可重新认领').toBe(true);
  });

  it('租约未过期 → 不回收、不可抢占', () => {
    repo.save(row('mbx_l2'));
    const t = now().toISOString();
    expect(repo.claimItem('mbx_l2', 'live', iso(600_000), t)).toBe(true);
    expect(repo.releaseExpiredLeases('agt_1', t), '未过期不回收').toBe(0);
    expect(repo.claimItem('mbx_l2', 'owner-B', iso(600_000), t)).toBe(false);
  });

  it('renewLease 仅限认领者本人', () => {
    repo.save(row('mbx_l3'));
    const t = now().toISOString();
    expect(repo.claimItem('mbx_l3', 'owner-A', iso(60_000), t)).toBe(true);

    expect(repo.renewLease('mbx_l3', 'owner-A', iso(600_000)), '本人续租成功').toBe(true);
    expect(repo.renewLease('mbx_l3', 'impostor', iso(600_000)), '他人续租失败').toBe(false);
    // 续租后租约确实被延长
    expect(repo.getById('mbx_l3')!.leaseUntil! > iso(300_000)).toBe(true);
  });

  it('releaseClaim 只清本人认领（不会误清他人）', () => {
    repo.save(row('mbx_l4'));
    const t = now().toISOString();
    expect(repo.claimItem('mbx_l4', 'owner-A', iso(600_000), t)).toBe(true);

    repo.releaseClaim('mbx_l4', 'impostor');
    expect(repo.getById('mbx_l4')!.claimedBy, '冒充者无法释放').toBe('owner-A');

    repo.releaseClaim('mbx_l4', 'owner-A');
    expect(repo.getById('mbx_l4')!.claimedBy).toBeNull();
    expect(repo.getById('mbx_l4')!.leaseUntil).toBeNull();
  });
});

describe('P0 启动清理 · 不误杀有效租约', () => {
  it('有效租约的 processing 行不被清理；无认领/租约过期的行才被清', () => {
    repo.save(row('mbx_s1')); // 无认领的 processing
    repo.save(row('mbx_s2')); // 有效租约
    repo.save(row('mbx_s3')); // 过期租约

    const t = now().toISOString();
    repo.updateStatus('mbx_s1', 'processing');
    expect(repo.claimItem('mbx_s2', 'live', iso(600_000), t)).toBe(true);
    expect(repo.claimItem('mbx_s3', 'dead', iso(-60_000), t)).toBe(true);

    expect(repo.markStaleProcessingAsDropped('agt_1', t), '只清 s1 + s3').toBe(2);
    expect(repo.getById('mbx_s1')!.status).toBe('dropped');
    expect(repo.getById('mbx_s2')!.status, '有效租约不被动').toBe('processing');
    expect(repo.getById('mbx_s3')!.status).toBe('dropped');
  });
});

// ─── 复核补齐（owner）：未落库项 fail-open + watchdog 自愈的租约感知 ────────────

describe('P0 认领 fail-open · 未落库的 item 不被静默跳过', () => {
  it('行不存在（从未落库）→ 认领放行（P0 之前不依赖 DB 行即可处理，不得因持久化抖动丢消息）', () => {
    expect(repo.claimItem('mbx_never_saved', 'owner-A', iso(600_000), now().toISOString())).toBe(true);
  });

  it('行存在但被他人有效租约持有 → 仍拒绝（fail-open 不削弱唯一胜者语义）', () => {
    repo.save(row('mbx_held'));
    const t = now().toISOString();
    expect(repo.claimItem('mbx_held', 'owner-A', iso(600_000), t)).toBe(true);
    expect(repo.claimItem('mbx_held', 'owner-B', iso(600_000), t)).toBe(false);
  });
});

describe('P0 watchdog 自愈 · 租约感知（不误杀其它实例在飞项）', () => {
  it('只清「本实例持有 / 无认领 / 租约过期」的 processing 行', () => {
    const t = now().toISOString();
    repo.save(row('mbx_other'));
    repo.claimItem('mbx_other', 'owner-B', iso(600_000), t);   // 别的实例：有效租约
    repo.save(row('mbx_mine'));
    repo.claimItem('mbx_mine', 'owner-A', iso(600_000), t);    // 本实例：complete 失败残留
    repo.save(row('mbx_expired'));
    repo.claimItem('mbx_expired', 'ghost', iso(-60_000), t);   // 租约已过期的孤儿

    expect(repo.markStaleProcessingAsCompleted('agt_1', 'owner-A'), '只清本实例 + 过期孤儿').toBe(2);
    expect(repo.getById('mbx_other')!.status, '他人有效租约不被误杀').toBe('processing');
    expect(repo.getById('mbx_mine')!.status).toBe('completed');
    expect(repo.getById('mbx_expired')!.status).toBe('completed');

    // 不传 ownerId → 走**旧契约**分支（清理全部 processing 行），兼容既有调用与测试；
    // 生产路径（mailbox.cleanStaleProcessing）始终传 ownerId，不会走到这个分支。
    expect(repo.markStaleProcessingAsCompleted('agt_1')).toBe(1);
    expect(repo.getById('mbx_other')!.status).toBe('completed');
  });

  it('updateStatus 支持 priority（updatePriority 的落库路径，不再走幂等 save）', () => {
    repo.save(row('mbx_prio'));
    repo.updateStatus('mbx_prio', 'queued', { priority: 0 });
    expect(repo.getById('mbx_prio')!.priority).toBe(0);
  });
});

// ─── 缺口补齐（owner 复核追加）────────────────────────────────────────────────
// （注：本区块与上方 'P0 watchdog 自愈 …' / 'P0 认领 fail-open …' 的用例重复，
//   已在上方合并保留；此处仅保留「同持有者重复认领也被拒」这条增量断言。）

describe('P0 复核追加 · 同持有者不可重复认领（增量断言）', () => {
  it('同一 owner 对同一行二次 claimItem 仍为 false（行已非 queued）', () => {
    repo.save(row('mbx_again'));
    const t = now().toISOString();
    expect(repo.claimItem('mbx_again', 'owner-A', iso(600_000), t)).toBe(true);
    expect(repo.claimItem('mbx_again', 'owner-A', iso(600_000), t), '二次认领被拒').toBe(false);
  });

  it('updateStatus 支持 priority（updatePriority 的落库路径，不再走幂等 save）', () => {
    repo.save(row('mbx_prio2'));
    repo.updateStatus('mbx_prio2', 'queued', { priority: 0 });
    expect(repo.getById('mbx_prio2')!.priority).toBe(0);
  });
});
