/**
 * P1.x · 重投/恢复不丢 review_request —— **真实 SqliteStorage** 端到端测试
 *
 * 为什么必须落真实 SQLite（QA F2 硬验收）：`packages/core/test/mailbox-recovery.test.ts` 的
 * `InMemoryPersistence.markStaleProcessingAsDropped`（:74-78）**没有任何租约/认领过滤**，
 * 与真实 SQL 语义不一致 ⇒ ⑥/⑥a/⑦ 若只在该 fake 上通过 = 未覆盖 (d) 的真实分支。
 *
 * 断言层（QA F3）：③ 一律**回读持久层行**（`repo.getById`），不看内存态（`depth`/`Mailbox.getById`
 * 即使持久层回队是 no-op 也会假绿）；① 一律**跨两个 Mailbox 实例**（异构 ownerId）构造重启，
 * 并断言「行存在」（堵 `claimItem` 对缺失行 fail-open 返回 true）+「可被重新认领处理」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAILBOX_QUEUED_TTL_MS, type MailboxItem } from '@markus/shared';
import { AgentMailbox, type MailboxPersistence } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { openSqlite, closeSqlite, SqliteMailboxRepo } from '../../storage/src/sqlite-storage.js';

const AGENT = 'agt_p1x_e2e';
const REVIEW = (taskId: string, round: number) => ({
  summary: `Review ${taskId} r${round}`,
  content: 'please review',
  taskId,
  extra: { round },
});
const DEDUP = (taskId: string, round: number) => `review_request:${taskId}:${round}`;
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

let tempDir: string;
let db: ReturnType<typeof openSqlite>;
let repo: SqliteMailboxRepo;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-p1x-e2e-'));
  db = openSqlite(join(tempDir, 'test.db'));
  repo = new SqliteMailboxRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

/** 与 cli/start.ts 的 wireMailboxPersistence 同形（含 P1.x 新增的两个最小 API）。 */
function makePersistence(repoRef: SqliteMailboxRepo): MailboxPersistence {
  const toItem = (r: NonNullable<ReturnType<SqliteMailboxRepo['getById']>>): MailboxItem => ({
    id: r.id, agentId: r.agentId, sourceType: r.sourceType as MailboxItem['sourceType'],
    priority: r.priority as MailboxItem['priority'], status: r.status as MailboxItem['status'],
    payload: r.payload as unknown as MailboxItem['payload'],
    metadata: r.metadata as MailboxItem['metadata'], queuedAt: r.queuedAt,
  });
  return {
    save: (item, dedupKey) => {
      const { responsePromise, ...metadata } = (item.metadata ?? {}) as Record<string, unknown>;
      return repoRef.save({
        id: item.id, agentId: item.agentId, sourceType: item.sourceType, priority: item.priority,
        status: item.status, payload: item.payload as unknown as Record<string, unknown>,
        metadata, queuedAt: item.queuedAt, dedupKey,
      });
    },
    updateStatus: (itemId, status, extra) => repoRef.updateStatus(itemId, status, extra as Record<string, unknown>),
    markStaleProcessingAsDropped: (aid) => repoRef.markStaleProcessingAsDropped(aid),
    markStaleProcessingAsCompleted: (aid, ownerId) => repoRef.markStaleProcessingAsCompleted(aid, ownerId),
    loadQueued: (aid) => repoRef.getByAgent(aid, { status: 'queued' }).map(toItem),
    loadDeferred: (aid) => repoRef.getByAgent(aid, { status: 'deferred' }).map(toItem),
    claimItem: (id, ownerId, leaseUntil, nowIso) => repoRef.claimItem(id, ownerId, leaseUntil, nowIso),
    renewLease: (id, ownerId, leaseUntil) => repoRef.renewLease(id, ownerId, leaseUntil),
    releaseClaim: (id, ownerId) => repoRef.releaseClaim(id, ownerId),
    releaseExpiredLeases: (aid, nowIso) => repoRef.releaseExpiredLeases(aid, nowIso),
    requeueItem: (id, opts) => repoRef.requeueItem(id, opts),
    findByDedupKey: (aid, dedupKey) => repoRef.findByDedupKey(aid, dedupKey),
  };
}

/** 每个实例独立 ownerId（`agentId#pid#seq`）：跨实例重启靠它区分。 */
function newMailbox(): AgentMailbox {
  return new AgentMailbox(AGENT, new EventBus(), makePersistence(repo));
}

function rowCount(dedupKey?: string): number {
  const rows = repo.getByAgent(AGENT);
  return dedupKey ? rows.filter(r => r.dedupKey === dedupKey).length : rows.length;
}

/** 停机重投：等价于 attention.ts 停机分支 `enqueue(..., { reuseItemId })`。 */
function reinjectOnShutdown(mb: AgentMailbox, item: MailboxItem): MailboxItem {
  return mb.enqueue(item.sourceType, item.payload, {
    priority: item.priority, metadata: item.metadata, reuseItemId: item.id,
  });
}

/** 造「processing + 已过期租约」行（认领者用异构 ownerId，贴近重启后的真实形态）。 */
function seedExpiredLeaseClaim(id: string, owner = 'agt_p1x_e2e#999#7') {
  repo.claimItem(id, owner, iso(-60_000), iso(-120_000));
}

/** 预置「旧 queued_at」：证明回队确实刷新（同 ms 写入会掩盖刷新事实）。 */
function predateQueuedAt(id: string, msAgo = 60_000) {
  db.prepare('UPDATE mailbox_items SET queued_at = ? WHERE id = ?').run(iso(-msAgo), id);
}

describe('P1.x ①②③⑤ · 优雅停机重投（真实 SQLite，跨实例）', () => {
  it('①⑤ 重投复用原行回队，返回 queued（非 dropped），跨实例可重新认领处理', () => {
    const a = newMailbox();
    const enq = a.enqueue('review_request', REVIEW('tsk_1', 1));
    const inflight = a.dequeue()!;                       // 取件 → processing（claimed_by = A）
    expect(inflight.id).toBe(enq.id);
    expect(repo.getById(enq.id)!.claimedBy).toBe(a.getOwnerId());

    const requeued = reinjectOnShutdown(a, inflight);
    // ⑤ 在 1bacd0c1 上此处为 `dropped`（唯一键拒绝 + 原行卡在 processing）= 该用例的红起点
    expect(requeued.status, '⑤① 停机重投不得被丢弃').toBe('queued');
    expect(requeued.id).toBe(enq.id);

    // ① 新实例（异构 ownerId）启动恢复 → 可被重新认领处理
    const b = newMailbox();
    expect(b.getOwnerId()).not.toBe(a.getOwnerId());
    const rec = b.recoverStaleItems();
    expect(rec.restored).toBe(1);

    const claimed = b.dequeue();
    expect(claimed, '① 必须可被重新认领处理').toBeDefined();
    expect(claimed!.id).toBe(enq.id);
    const claimedRow = repo.getById(enq.id)!;            // 堵 claimItem fail-open（行不存在也返 true）
    expect(claimedRow.status).toBe('processing');
    expect(claimedRow.claimedBy).toBe(b.getOwnerId());
    expect(claimedRow.leaseUntil).not.toBeNull();
  });

  it('② 重投不新增行：同键仍仅 1 行', () => {
    const a = newMailbox();
    const enq = a.enqueue('review_request', REVIEW('tsk_2', 1));
    const inflight = a.dequeue()!;
    reinjectOnShutdown(a, inflight);
    reinjectOnShutdown(a, inflight);                     // 重复重投幂等

    expect(rowCount(DEDUP('tsk_2', 1))).toBe(1);
    expect(rowCount()).toBe(1);
    expect(enq.id).toBeDefined();
  });

  it('③ 持久层回读：claimed_by/lease_until/started_at 已释放 + queued_at 已刷新', () => {
    const a = newMailbox();
    const enq = a.enqueue('review_request', REVIEW('tsk_3', 1));
    const inflight = a.dequeue()!;
    predateQueuedAt(enq.id, MAILBOX_QUEUED_TTL_MS + 60_000);   // 这条投递「早已排队很久」

    const before = repo.getById(enq.id)!;
    const requeued = reinjectOnShutdown(a, inflight);
    expect(requeued.status).toBe('queued');

    const after = repo.getById(enq.id)!;                 // 回读持久层（非内存态）
    expect(after.status).toBe('queued');
    expect(after.claimedBy).toBeNull();
    expect(after.leaseUntil).toBeNull();
    expect(after.startedAt).toBeNull();
    expect(new Date(after.queuedAt).getTime(), '(b) queued_at 必须刷新').toBeGreaterThan(new Date(before.queuedAt).getTime());
  });

  it('④ 回队刷新 queued_at：年龄超 MAILBOX_QUEUED_TTL_MS 也不会被同轮恢复判 expired（含反证）', () => {
    const a = newMailbox();
    const enq = a.enqueue('review_request', REVIEW('tsk_4', 1));
    const inflight = a.dequeue()!;
    predateQueuedAt(enq.id, MAILBOX_QUEUED_TTL_MS + 60_000);

    reinjectOnShutdown(a, inflight);

    const b = newMailbox();
    const rec = b.recoverStaleItems();                   // 同一次恢复：先清理 processing，再按 TTL 判过期
    expect(rec.expired, '④ 不得 expired').toBe(0);
    expect(rec.restored).toBe(1);
    expect(repo.getById(enq.id)!.status).toBe('queued');
    expect(b.dequeue(), '④ 仍可认领').toBeDefined();

    // 反证 (b) 的必要性：若 queued_at 未刷新（退回旧时间戳），同一次恢复会直接判死
    db.prepare("UPDATE mailbox_items SET status = 'queued', claimed_by = NULL, lease_until = NULL, queued_at = ? WHERE id = ?")
      .run(iso(-MAILBOX_QUEUED_TTL_MS - 60_000), enq.id);
    const c = newMailbox();
    const rec2 = c.recoverStaleItems();
    expect(rec2.expired, '不刷 queued_at = 白修（回队行同轮被 TTL 判死）').toBe(1);
    expect(repo.getById(enq.id)!.status).toBe('dropped');
  });
});

// ─── ⑥a / ⑦ · 崩溃恢复：(d) 启动清理按类型分流（真实 SQLite）────────────────

describe('P1.x ⑥a / ⑦ · 崩溃恢复：启动清理按类型分流', () => {
  it('⑥a-1 启动恢复：strict-state + 已过期租约 → 回 queued（基线 1bacd0c1 上为 dropped = 改造对象）', () => {
    const a = newMailbox();
    const enq = a.enqueue('review_request', REVIEW('tsk_5', 1));
    seedExpiredLeaseClaim(enq.id);
    expect(repo.getById(enq.id)!.status).toBe('processing');
    predateQueuedAt(enq.id);
    const beforeQueuedAt = repo.getById(enq.id)!.queuedAt;

    const b = newMailbox();                              // 崩溃后重启（新实例、异构 ownerId）
    const rec = b.recoverStaleItems();

    expect(rec.dropped, '⑥a-1 不得被 drop').toBe(0);
    expect(rec.restored).toBe(1);
    const row = repo.getById(enq.id)!;
    expect(row.status).toBe('queued');
    expect(row.claimedBy).toBeNull();
    expect(row.leaseUntil).toBeNull();
    expect(new Date(row.queuedAt).getTime(), '⑦/③ 同语义：queued_at 也必须刷新')
      .toBeGreaterThan(new Date(beforeQueuedAt).getTime());
    expect(b.dequeue(), '可被重新认领').toBeDefined();
  });

  it('⑥a-2 运行期看门狗 reclaimExpiredLeases() 端到端：过期租约回收为 queued（防回归）', () => {
    const a = newMailbox();
    const enq = a.enqueue('review_request', REVIEW('tsk_6', 1));
    seedExpiredLeaseClaim(enq.id);
    predateQueuedAt(enq.id);
    const beforeQueuedAt = repo.getById(enq.id)!.queuedAt;

    expect(a.reclaimExpiredLeases(), '经看门狗入口触发（不直调 releaseExpiredLeases）').toBe(1);

    const row = repo.getById(enq.id)!;
    expect(row.status).toBe('queued');
    expect(row.claimedBy).toBeNull();
    expect(row.leaseUntil).toBeNull();
    expect(new Date(row.queuedAt).getTime(), '(b) 既有运行期回队路径也必须刷 queued_at')
      .toBeGreaterThan(new Date(beforeQueuedAt).getTime());
    expect(a.depth).toBe(1);
    expect(a.dequeue()).toBeDefined();
  });

  it('⑦ 孤儿行（processing + claimed_by/lease_until 皆 NULL）经启动恢复不得被无条件 dropped', () => {
    const a = newMailbox();
    const enq = a.enqueue('review_request', REVIEW('tsk_7', 1));
    // 孤儿真源：legacy/pre-lease 行，或 dequeueById 的无 claimItem 回落支（仅测试替身可达）。
    // 注意：**非 (a)/R2 路径产生**；R2 行由 claimItem 写入，命中的是「已过期租约」支。
    db.prepare("UPDATE mailbox_items SET status = 'processing', started_at = ? WHERE id = ?")
      .run(iso(-60_000), enq.id);
    predateQueuedAt(enq.id);
    const beforeQueuedAt = repo.getById(enq.id)!.queuedAt;

    const b = newMailbox();
    const rec = b.recoverStaleItems();

    expect(rec.dropped).toBe(0);
    const row = repo.getById(enq.id)!;
    expect(row.status, '⑦ 不得无条件 dropped').toBe('queued');
    expect(row.claimedBy).toBeNull();
    expect(row.leaseUntil).toBeNull();
    expect(new Date(row.queuedAt).getTime(), '⑦ 与 ③ 共用同一断言语义')
      .toBeGreaterThan(new Date(beforeQueuedAt).getTime());
    expect(b.dequeue()).toBeDefined();
  });

  it('(d) 类型边界：非 strict-state（heartbeat / a2a_message）维持 drop，未被无差别翻转', () => {
    const a = newMailbox();
    const hb = a.enqueue('heartbeat', { summary: 'hb', content: 'check' });
    db.prepare("UPDATE mailbox_items SET status = 'processing' WHERE id = ?").run(hb.id);
    const a2a = a.enqueue('a2a_message', { summary: 'peer', content: 'hi' });
    seedExpiredLeaseClaim(a2a.id);

    const b = newMailbox();
    const rec = b.recoverStaleItems();

    expect(rec.dropped, '非 strict-state 逐字保持 drop').toBe(2);
    expect(repo.getById(hb.id)!.status).toBe('dropped');
    expect(repo.getById(a2a.id)!.status).toBe('dropped');
    expect(b.depth).toBe(0);
  });
});

// ─── (c) 四态判定（真实持久层 findByDedupKey）─────────────────────────────

describe('P1.x (c) · 同键投递四态判定（真实 findByDedupKey）', () => {
  it('(c.1) 行不存在 → 正常插入', () => {
    const a = newMailbox();
    const enq = a.enqueue('review_request', REVIEW('tsk_8', 1));
    expect(enq.status).toBe('queued');
    expect(repo.findByDedupKey(AGENT, DEDUP('tsk_8', 1))!.id).toBe(enq.id);
  });

  it('(c.2) 行在飞（processing，有效租约）→ 重复投递被幂等抑制，不新增行', () => {
    const a = newMailbox();
    const enq = a.enqueue('review_request', REVIEW('tsk_9', 1));
    a.dequeue();
    expect(repo.getById(enq.id)!.status).toBe('processing');

    const dup = a.enqueue('review_request', REVIEW('tsk_9', 1));

    expect(dup.status).toBe('dropped');
    expect(repo.getByAgent(AGENT).length).toBe(1);
    expect(repo.getById(enq.id)!.status, '在飞项不被回队、不新增行').toBe('processing');
  });

  it('(c.3) 行 dropped 且该轮未收口 → 允许复用原行补偿重投（不新增行）', () => {
    const a = newMailbox();
    const enq = a.enqueue('review_request', REVIEW('tsk_10', 1));
    repo.updateStatus(enq.id, 'dropped');

    const again = a.enqueue('review_request', REVIEW('tsk_10', 1));

    expect(again.status, '补偿重投成功').toBe('queued');
    expect(again.id, '复用原行').toBe(enq.id);
    expect(repo.getByAgent(AGENT).length).toBe(1);
    expect(repo.getById(enq.id)!.status).toBe('queued');
  });

  it('(c.4) 行已收口（completed）→ 拒重投，返回当前状态、不复活', () => {
    const a = newMailbox();
    const enq = a.enqueue('review_request', REVIEW('tsk_11', 1));
    repo.updateStatus(enq.id, 'completed', { completedAt: iso(0) });

    const out = a.enqueue('review_request', REVIEW('tsk_11', 1));

    expect(out.status).toBe('dropped');
    expect(repo.getById(enq.id)!.status).toBe('completed');
    expect(repo.getByAgent(AGENT).length).toBe(1);
  });
});