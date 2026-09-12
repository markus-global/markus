/**
 * 需求验收回归套件 A · review_request 多分身扇出（req_236bca1ab0ca8ed425537bed）
 *
 * 归属任务：tsk_e991647e313fbe9a3b07a64f（回归测试 + 架构门禁）。
 * 验收锚点：
 *   #1 N 个并发分身 + 重复投递下，同一 mailbox item 只被处理一次（唯一胜者）；
 *   #3 租约过期后 item 可被重新认领；items 唯一键拒绝重复插入。
 *
 * 为什么必须落在**真实 SQLite + 跨实例**（而非 fake persistence）：
 * 「唯一胜者 / 幂等键 / 租约回收」三条契约全部由 SQL 承载 ——
 *  `WHERE status='queued' AND (claimed_by IS NULL OR lease_until IS NULL OR lease_until < ?)`
 * 与部分唯一索引 `uq_mailbox_agent_dedup`。in-memory fake 复刻不了真实语义，
 * 在 fake 上通过 = 未覆盖生产路径（假绿）。故本套件一律读回持久层行做断言。
 *
 * 与既有测试的分工（避免重复）：
 *   - `mailbox-claim-lease.test.ts`（P0）= 单层单元契约（fake 共享表）；
 *   - 本文件 = 需求验收入口的回归锚点，用真实持久层跨实例复现「多分身扇出」事故形态。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MailboxItem } from '@markus/shared';
import { AgentMailbox, type MailboxPersistence } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { openSqlite, closeSqlite, SqliteMailboxRepo } from '../../storage/src/sqlite-storage.js';

const AGENT = 'agt_fanout_reg';
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const REVIEW = (taskId: string, round: number) => ({
  summary: `Review ${taskId} r${round}`,
  content: 'please review',
  taskId,
  extra: { round },
});
/** 与 core `mailboxDedupKey()` 同形，用于按幂等键定位持久层行。 */
const DEDUP = (taskId: string, round: number) => `review_request:${taskId}:${round}`;

let tempDir: string;
let db: ReturnType<typeof openSqlite>;
let repo: SqliteMailboxRepo;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'markus-fanout-reg-'));
  db = openSqlite(join(tempDir, 'test.db'));
  repo = new SqliteMailboxRepo(db);
});

afterEach(() => {
  closeSqlite();
  rmSync(tempDir, { recursive: true, force: true });
});

/** 与 cli/start.ts 的 wireMailboxPersistence 同形（跨实例共享同一持久层）。 */
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

/** 每个分身 = 一个 AgentMailbox 实例（独立 ownerId），共享同一持久层。 */
function newPersona(): AgentMailbox {
  return new AgentMailbox(AGENT, new EventBus(), makePersistence(repo));
}

function rows(dedupKey?: string) {
  const all = repo.getByAgent(AGENT);
  return dedupKey ? all.filter(r => r.dedupKey === dedupKey) : all;
}

/** 把同一行的副本塞进另一个分身的内存队列（复现「同一 item 被扇出到 N 个分身」）。 */
function fanOutCopy(target: AgentMailbox, item: MailboxItem): void {
  (target as unknown as { queue: MailboxItem[] }).queue.push({ ...item });
}

describe('验收 #1 · 重复投递 + N 并发分身 → 同一 item 仅被处理一次', () => {
  it('同一 (task, round) 被 3 个分身重复投递 → 库中仅 1 行、仅 1 个分身能取件', () => {
    const personas = [newPersona(), newPersona(), newPersona()];
    const payload = REVIEW('tsk_fan', 1);
    const returned = personas.map(mb => mb.enqueue('review_request', payload));

    // 幂等键：同 (agent, review_request, task, round) 只允许一行
    expect(rows(DEDUP('tsk_fan', 1))).toHaveLength(1);
    expect(rows()).toHaveLength(1);

    // 被抑制的重复投递不得入队 → 不产生第二次处理
    expect(returned[1]!.status).toBe('dropped');
    expect(returned[2]!.status).toBe('dropped');

    // 唯一胜者：三个分身中恰好一个取到件
    const winners = personas.map(mb => mb.dequeue()).filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.id).toBe(returned[0]!.id);

    // 处理一次即被认领（进入 processing），持久层记录认领者
    const row = repo.getById(returned[0]!.id)!;
    expect(row.status).toBe('processing');
    expect(row.claimedBy).toBeTruthy();
  });

  it('同一行的 N 个内存副本（多分身扇出持有）→ 仅 1 个认领成功，败者让位且不可能重复处理', () => {
    const a = newPersona();
    const b = newPersona();
    const c = newPersona();
    const item = a.enqueue('review_request', REVIEW('tsk_race', 1));

    fanOutCopy(b, item);
    fanOutCopy(c, item);

    const winners = [a, b, c].map(mb => mb.dequeue()).filter(Boolean);
    expect(winners, '同一 item 只能被一个分身认领').toHaveLength(1);
    expect(winners[0]!.id).toBe(item.id);

    // 唯一胜者由持久层条件更新裁决（claimItem 原子写 claimed_by/lease_until）
    const row = repo.getById(item.id)!;
    expect(row.status).toBe('processing');
    expect(row.claimedBy).toBe(a.getOwnerId());

    // 败者副本已移出内存队列 → 不会再被处理（消除空转/重复收口）
    expect(b.getQueuedItems().find(i => i.id === item.id)).toBeUndefined();
    expect(c.getQueuedItems().find(i => i.id === item.id)).toBeUndefined();
  });

  it('不同 round 不被误去重（多轮评审各自可投递）', () => {
    const mb = newPersona();
    mb.enqueue('review_request', REVIEW('tsk_multi', 1));
    mb.enqueue('review_request', REVIEW('tsk_multi', 2));
    expect(rows()).toHaveLength(2);
  });
});

describe('验收 #3 · 租约过期可重新认领 / items 唯一键拒绝重复插入', () => {
  it('items 唯一键（uq_mailbox_agent_dedup）：同 agent + 同 dedup_key 第二次插入被拒', () => {
    const base = {
      agentId: AGENT, sourceType: 'review_request' as const, priority: 1 as const,
      status: 'queued' as const,
      payload: { summary: 'r', content: 'r', taskId: 'tsk_uq', extra: { round: 1 } },
      queuedAt: iso(0), dedupKey: DEDUP('tsk_uq', 1),
    };
    expect(repo.save({ id: 'mbx_reg_uq_1', ...base })).not.toBe(false);
    expect(repo.save({ id: 'mbx_reg_uq_2', ...base }), '第二次插入必须被唯一键拒绝').toBe(false);
    expect(rows(DEDUP('tsk_uq', 1))).toHaveLength(1);
  });

  it('租约过期 → 回收为 queued → 恰可被重新认领一次（不重复收口）', () => {
    const a = newPersona();
    const item = a.enqueue('review_request', REVIEW('tsk_lease', 1));

    // 模拟认领者崩溃：processing + 已过期租约 + 异构 ownerId
    expect(repo.claimItem(item.id, 'agt_fanout_reg#999#1', iso(-60_000), iso(-120_000))).toBe(true);
    expect(repo.getById(item.id)!.status).toBe('processing');

    const b = newPersona();
    expect(b.reclaimExpiredLeases()).toBe(1);
    expect(repo.getById(item.id)!.status).toBe('queued');
    expect(repo.getById(item.id)!.claimedBy).toBeNull();

    const got = b.dequeue();
    expect(got?.id).toBe(item.id);
    expect(repo.getById(item.id)!.status).toBe('processing');
    expect(repo.getById(item.id)!.claimedBy).toBe(b.getOwnerId());

    // 原实例不再可能处理同一条（其本地副本认领会失败并让位）
    expect(a.dequeue()).toBeUndefined();
  });

  it('租约未过期不可抢占（防重复处理）', () => {
    const a = newPersona();
    const item = a.enqueue('review_request', REVIEW('tsk_hold', 1));
    expect(repo.claimItem(item.id, 'other-instance#1#1', iso(600_000), iso(0))).toBe(true);

    const b = newPersona();
    expect(b.reclaimExpiredLeases(), '有效租约不得被回收').toBe(0);
    expect(a.dequeue(), '持有有效租约期间他人取不到').toBeUndefined();
    expect(repo.getById(item.id)!.claimedBy).toBe('other-instance#1#1');
  });
});
