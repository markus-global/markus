/**
 * P0 · mailbox 原子认领 / 租约 / 幂等键 —— core 层单元测试
 *
 * 对应需求 req_236bca1ab0ca8ed425537bed 的验收标准：
 *  1. N 个并发分身下，同一 mailbox item 仅由一个 worker 成功认领；
 *  2. items 唯一键生效：重复插入被拒、不产生重复投递；
 *  3. 租约过期后 item 可被重新认领。
 *
 * 用「共享表」stub 模拟多实例共享同一持久层：其 `claim` 复刻 SQLite 的
 * 条件更新语义（`WHERE status='queued' AND (claimed_by IS NULL OR lease_until < now)`），
 * 因此本文件能确定性地覆盖跨实例竞争，而不依赖真实并发或时序竞态。
 */

import { describe, it, expect } from 'vitest';
import type { MailboxItem } from '@markus/shared';
import { AgentMailbox, mailboxDedupKey, type MailboxPersistence } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';

// ─── 共享表 stub（复刻 SQLite 语义）─────────────────────────────────────────

interface Row {
  status: string;
  claimedBy: string | null;
  leaseUntil: string | null;
}

class SharedTable {
  rows = new Map<string, Row>();
  /** `${agentId}|${dedupKey}` → itemId */
  dedup = new Map<string, string>();
  insertOk = 0;
  rejected = 0;

  save(id: string, dedupKey?: string): boolean {
    if (this.rows.has(id)) { this.rejected++; return false; }
    if (dedupKey && this.dedup.has(dedupKey)) { this.rejected++; return false; }
    if (dedupKey) this.dedup.set(dedupKey, id);
    this.rows.set(id, { status: 'queued', claimedBy: null, leaseUntil: null });
    this.insertOk++;
    return true;
  }

  /** 条件更新：仅「queued 且未被有效租约持有」时胜出（= SQLite claimItem）。 */
  claim(id: string, ownerId: string, leaseUntil: string, nowIso: string): boolean {
    const r = this.rows.get(id);
    if (!r || r.status !== 'queued') return false;
    const leaseFree = r.claimedBy === null || r.leaseUntil === null || r.leaseUntil < nowIso;
    if (!leaseFree) return false;
    r.status = 'processing';
    r.claimedBy = ownerId;
    r.leaseUntil = leaseUntil;
    return true;
  }

  renew(id: string, ownerId: string, leaseUntil: string): boolean {
    const r = this.rows.get(id);
    if (!r || r.status !== 'processing' || r.claimedBy !== ownerId) return false;
    r.leaseUntil = leaseUntil;
    return true;
  }

  release(id: string, ownerId: string): void {
    const r = this.rows.get(id);
    if (!r || r.claimedBy !== ownerId) return;
    r.claimedBy = null;
    r.leaseUntil = null;
  }

  releaseExpired(nowIso: string): number {
    let n = 0;
    for (const r of this.rows.values()) {
      if (r.status === 'processing' && r.leaseUntil !== null && r.leaseUntil < nowIso) {
        r.status = 'queued';
        r.claimedBy = null;
        r.leaseUntil = null;
        n++;
      }
    }
    return n;
  }

  /** 供 reclaimExpiredLeases 重新载入：把 queued 行还原成 MailboxItem 形状。 */
  loadQueuedLike(agentId: string): MailboxItem[] {
    const out: MailboxItem[] = [];
    for (const [id, r] of this.rows) {
      if (r.status !== 'queued') continue;
      out.push({
        id, agentId, sourceType: 'review_request', priority: 1, status: 'queued',
        payload: { summary: 'recovered', content: 'recovered' },
        queuedAt: new Date().toISOString(),
      });
    }
    return out;
  }
}

/** 造一个绑定到共享表的 mailbox（同一 agentId = 同一 Agent 的两个实例）。 */
function makeMailbox(table: SharedTable, agentId = 'agt_p0'): AgentMailbox {
  const mb = new AgentMailbox(agentId, new EventBus());
  const p: MailboxPersistence = {
    save: (item, dedupKey) => {
      table.save(item.id, dedupKey ? `${agentId}|${dedupKey}` : undefined);
    },
    updateStatus: (itemId, status) => {
      const r = table.rows.get(itemId);
      if (r) r.status = status;
    },
    loadQueued: () => table.loadQueuedLike(agentId),
    claimItem: (itemId, ownerId, leaseUntil, nowIso) => table.claim(itemId, ownerId, leaseUntil, nowIso),
    renewLease: (itemId, ownerId, leaseUntil) => table.renew(itemId, ownerId, leaseUntil),
    releaseClaim: (itemId, ownerId) => table.release(itemId, ownerId),
    releaseExpiredLeases: (_agentId, nowIso) => table.releaseExpired(nowIso),
  };
  mb.setPersistence(p);
  return mb;
}

// SharedTable 的 loadQueued 由类方法 loadQueuedLike 提供（reclaimExpiredLeases 用）。

const REVIEW = (taskId: string, round: number) => ({
  summary: `Review ${taskId} r${round}`,
  content: 'please review',
  taskId,
  extra: { round },
});

// ─── 幂等键推导 ─────────────────────────────────────────────────────────────

describe('mailboxDedupKey · 幂等键推导（agent_id + source_type + task_id + round）', () => {
  it('review_request 且 taskId + round 齐备 → 产出确定性键', () => {
    const item = { sourceType: 'review_request' as const, payload: REVIEW('tsk_1', 2) as never, metadata: {} };
    expect(mailboxDedupKey(item)).toBe('review_request:tsk_1:2');
  });

  it('同 (task, round) 键相同；不同 round 键不同（多轮评审不被误去重）', () => {
    const k1 = mailboxDedupKey({ sourceType: 'review_request' as const, payload: REVIEW('tsk_1', 1) as never, metadata: {} });
    const k1b = mailboxDedupKey({ sourceType: 'review_request' as const, payload: REVIEW('tsk_1', 1) as never, metadata: {} });
    const k2 = mailboxDedupKey({ sourceType: 'review_request' as const, payload: REVIEW('tsk_1', 2) as never, metadata: {} });
    expect(k1).toBe(k1b);
    expect(k1).not.toBe(k2);
  });

  it('缺少 round 或 taskId → 不加约束（undefined），避免误伤', () => {
    expect(mailboxDedupKey({ sourceType: 'review_request' as const, payload: { summary: 's', content: 'c', taskId: 'tsk_1' } as never, metadata: {} })).toBeUndefined();
    expect(mailboxDedupKey({ sourceType: 'review_request' as const, payload: { summary: 's', content: 'c', extra: { round: 1 } } as never, metadata: {} })).toBeUndefined();
  });

  it('非「至多一次」类型不加约束（如 task_comment 同轮可多条）', () => {
    expect(mailboxDedupKey({ sourceType: 'task_comment' as const, payload: REVIEW('tsk_1', 1) as never, metadata: {} })).toBeUndefined();
    expect(mailboxDedupKey({ sourceType: 'human_chat' as const, payload: REVIEW('tsk_1', 1) as never, metadata: {} })).toBeUndefined();
  });
});

// ─── 验收 1 + 2：并发认领唯一性 / 唯一键拒绝重复 ──────────────────────────────

describe('P0 原子认领 · 验收 1/2', () => {
  it('两个分身在各自内存队列持有同一 item 时，仅一个能认领成功', () => {
    const table = new SharedTable();
    const a = makeMailbox(table);
    const b = makeMailbox(table);

    const item = a.enqueue('review_request', REVIEW('tsk_9', 1) as never);
    // 模拟另一个实例把同一行载入自己的内存队列（共享同一持久层）。
    b.getQueuedItems();
    (b as unknown as { queue: unknown[] }).queue.push({ ...item });

    const gotA = a.dequeue();
    const gotB = b.dequeue();

    const winners = [gotA, gotB].filter(Boolean);
    expect(winners, '同一 item 只能被一个 worker 认领').toHaveLength(1);
    expect(gotA?.id ?? gotB?.id).toBe(item.id);
    // 认领者被记录，且 DB 行已进入 processing。
    expect(table.rows.get(item.id)!.status).toBe('processing');
    expect(table.rows.get(item.id)!.claimedBy).toBeTruthy();
  });

  it('重复投递同一 (task, round) → 唯一键拒绝第二行，且第二个分身取不到件', () => {
    const table = new SharedTable();
    const a = makeMailbox(table);
    const b = makeMailbox(table);

    a.enqueue('review_request', REVIEW('tsk_7', 3) as never);
    b.enqueue('review_request', REVIEW('tsk_7', 3) as never); // 重复投递

    expect(table.insertOk, '只应落库一行').toBe(1);
    expect(table.rejected, '第二次插入被唯一键拒绝').toBe(1);

    const gotA = a.dequeue();
    const gotB = b.dequeue();
    expect(gotA, '胜者拿到').toBeTruthy();
    expect(gotB, '重复投递的分身认领失败 → 不产生重复处理').toBeUndefined();
  });

  it('不同 round 的评审不被去重（多轮评审各自可投递）', () => {
    const table = new SharedTable();
    const a = makeMailbox(table);
    a.enqueue('review_request', REVIEW('tsk_7', 1) as never);
    a.enqueue('review_request', REVIEW('tsk_7', 2) as never);
    expect(table.insertOk).toBe(2);
    expect(table.rejected).toBe(0);
  });

  it('无原子认领能力（旧持久层）→ 退化为本地即胜，行为不回退', () => {
    const mb = new AgentMailbox('agt_legacy', new EventBus());
    mb.setPersistence({
      save: () => {},
      updateStatus: () => {},
    } as unknown as MailboxPersistence);
    mb.enqueue('human_chat', { summary: 'hi', content: 'hi' });
    expect(mb.dequeue(), '旧路径仍能取件').toBeTruthy();
  });
});

// ─── 验收 3：租约到期可重新认领 ──────────────────────────────────────────────

describe('P0 租约 · 验收 3', () => {
  it('租约过期后：原实例失守、item 可被重新认领', () => {
    const table = new SharedTable();
    const a = makeMailbox(table);
    const item = a.enqueue('review_request', REVIEW('tsk_5', 1) as never);

    // 认领时给一个「已过期」的租约，模拟实例崩溃/超时未续租。
    const claimed = table.claim(item.id, 'dead-instance', new Date(Date.now() - 60_000).toISOString(), new Date().toISOString());
    expect(claimed).toBe(true);
    expect(table.rows.get(item.id)!.status).toBe('processing');

    // 回收过期租约 → 退回 queued（并且重新载入内存队列）。
    const b = makeMailbox(table);
    expect(b.reclaimExpiredLeases()).toBe(1);
    expect(table.rows.get(item.id)!.status).toBe('queued');
    expect(table.rows.get(item.id)!.claimedBy).toBeNull();

    expect(b.dequeue(), '回收后可被重新认领').toBeTruthy();
  });

  it('租约未过期时不可被抢占（防重复处理）', () => {
    const table = new SharedTable();
    const a = makeMailbox(table);
    const item = a.enqueue('review_request', REVIEW('tsk_6', 1) as never);

    expect(table.claim(item.id, 'live-instance', new Date(Date.now() + 600_000).toISOString(), new Date().toISOString())).toBe(true);
    expect(table.releaseExpired(new Date().toISOString()), '未过期不回收').toBe(0);
    expect(a.dequeue(), '有效租约持有中，他人取不到').toBeUndefined();
  });

  it('续租仅限认领者本人；释放只清本人认领', () => {
    const table = new SharedTable();
    const a = makeMailbox(table);
    const item = a.enqueue('review_request', REVIEW('tsk_8', 1) as never);

    const got = a.dequeue();
    expect(got).toBeTruthy();
    // 本人续租成功
    expect(a.renewLease(item.id)).toBe(true);
    // 冒充他人续租 / 释放均无效
    expect(table.renew(item.id, 'impostor', new Date(Date.now() + 60_000).toISOString())).toBe(false);
    table.release(item.id, 'impostor');
    expect(table.rows.get(item.id)!.claimedBy).toBe(a.getOwnerId());
  });
});

// ─── 完成/丢弃/回队时释放认领 ────────────────────────────────────────────────

describe('P0 认领释放', () => {
  it('complete / drop 后认领被释放（不残留租约占位）', () => {
    const table = new SharedTable();

    const m1 = makeMailbox(table);
    const it1 = m1.enqueue('review_request', REVIEW('tsk_a', 1) as never);
    expect(m1.dequeue()).toBeTruthy();
    m1.complete(it1.id);
    expect(table.rows.get(it1.id)!.claimedBy, 'complete 后释放').toBeNull();

    const m2 = makeMailbox(table);
    const it2 = m2.enqueue('review_request', REVIEW('tsk_b', 1) as never);
    expect(m2.dequeue()).toBeTruthy();
    m2.drop(it2.id);
    expect(table.rows.get(it2.id)!.claimedBy, 'drop 后释放').toBeNull();
  });
});

// ─── 复核补齐（owner）：重复投递必须在入队层被显式拒绝 ─────────────────────────

describe('P0 重复投递 · 入队层显式拒绝', () => {
  it('落库被幂等键拒绝 → 不入内存队列、不产生第二次处理、了结投递方 responsePromise', () => {
    const table = new SharedTable();
    const mb = new AgentMailbox('agt_dup', new EventBus());
    const resolved: string[] = [];
    mb.setPersistence({
      // 复刻真实适配器语义：唯一键拒绝时 save 返回 false
      save: (item, dedupKey) => table.save(item.id, dedupKey ? `agt_dup|${dedupKey}` : undefined),
      updateStatus: (itemId, status) => { const r = table.rows.get(itemId); if (r) r.status = status; },
      claimItem: (itemId, ownerId, leaseUntil, nowIso) => table.claim(itemId, ownerId, leaseUntil, nowIso),
    } as unknown as MailboxPersistence);

    const first = mb.enqueue('review_request', REVIEW('tsk_dup', 1) as never);
    expect(table.insertOk, '首次落库').toBe(1);

    const second = mb.enqueue('review_request', REVIEW('tsk_dup', 1) as never, {
      metadata: { responsePromise: { resolve: (v: string) => resolved.push(v), reject: () => {} } },
    });

    expect(table.insertOk, '仍只落库一行').toBe(1);
    expect(table.rejected, '第二次插入被唯一键拒绝').toBe(1);
    expect(mb.getQueuedItems(), '被拒的重复投递不得进入内存队列').toHaveLength(1);
    expect(second.status, '被拒项标记为 dropped（不误导调用方）').toBe('dropped');
    expect(resolved, '投递方 responsePromise 被了结，不悬挂').toEqual(['[duplicate-delivery-suppressed]']);
    expect(mb.dequeue()?.id, '胜者仍是首次投递').toBe(first.id);
  });
});

// （重复用例已合并至上方的「P0 重复投递 · 入队层显式拒绝」，此处不再重复断言。）
