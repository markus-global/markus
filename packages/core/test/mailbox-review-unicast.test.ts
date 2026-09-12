/**
 * P1 · review_request 单播投递 + 受保护集合（禁止合并）+ P2 可观测 —— core 层验收测试
 *
 * 对应需求 req_236bca1ab0ca8ed425537bed / 任务 tsk_31b23ce898b9d8264b165454：
 *   - 根因 #3：取件排他靠进程内队列对象 shift + **广播唤醒全部 waiter**
 *              → 多 worker 下 N 个同时醒来自相竞争同一 item、败者让位后空转。
 *   - 根因 #4：review_request 未纳入受保护集合 → 可被 `consolidateGroup` 合并吞掉
 *              （审计 dim2 M2：strict-state 项被合并 → 评审可能永不执行）。
 *   - P2：认领竞争 / 被丢弃的重复投递 两类**结构化日志**（仅日志，无指标后端）。
 *
 * 断言口径刻意“可度量”：单播用 `dequeue()` 调用次数区分（广播唤醒的败者会多空转
 * 2 次 dequeue），P2 用 logger 原型 spy 按 `data.event` 过滤 —— 与验收标准一致。
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@markus/shared';
import type { MailboxItem } from '@markus/shared';
import { AgentMailbox, MAILBOX_OBSERVABILITY_EVENTS, type MailboxPersistence } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';

const REVIEW = (taskId: string, round: number) => ({
  summary: `Review ${taskId} r${round}`,
  content: 'please review',
  taskId,
  extra: { round },
});

function makeMailbox(agentId = 'agt_p1'): AgentMailbox {
  return new AgentMailbox(agentId, new EventBus());
}

/** 排空 microtask 队列（唤醒 → dequeue 的同步链跨 await 边界）。 */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** 按结构化事件名过滤 logger 调用（P2 可度量口径）。 */
type LogCall = [string, (Record<string, unknown> | undefined)?];
function eventOf(spy: { mock: { calls: unknown[][] } }, event: string): unknown[][] {
  return spy.mock.calls.filter(c => (c[1] as Record<string, unknown> | undefined)?.['event'] === event) as unknown[][];
}

// ─── 共享表 stub（复刻 SQLite 条件更新语义，供认领竞争 / 租约回收用）──────────

interface Row {
  status: 'queued' | 'processing';
  claimedBy: string | null;
  leaseUntil: string | null;
}

function makeSharedTable() {
  const rows = new Map<string, Row>();
  return {
    rows,
    save(id: string): boolean {
      if (rows.has(id)) return false;
      rows.set(id, { status: 'queued', claimedBy: null, leaseUntil: null });
      return true;
    },
    /** 等价于 SQLite：UPDATE ... WHERE status='queued' AND (claimed_by IS NULL OR lease_until < now) */
    claim(id: string, ownerId: string, leaseUntil: string, nowIso: string): boolean {
      const r = rows.get(id);
      if (!r || r.status !== 'queued') return false;
      const free = r.claimedBy === null || r.leaseUntil === null || r.leaseUntil < nowIso;
      if (!free) return false;
      r.status = 'processing';
      r.claimedBy = ownerId;
      r.leaseUntil = leaseUntil;
      return true;
    },
    releaseExpired(nowIso: string): number {
      let n = 0;
      for (const r of rows.values()) {
        if (r.status === 'processing' && r.leaseUntil !== null && r.leaseUntil < nowIso) {
          r.status = 'queued';
          r.claimedBy = null;
          r.leaseUntil = null;
          n++;
        }
      }
      return n;
    },
  };
}

function makeMailboxWith(table: ReturnType<typeof makeSharedTable>, agentId = 'agt_p1'): AgentMailbox {
  const mb = new AgentMailbox(agentId, new EventBus());
  const p: MailboxPersistence = {
    save: (item) => table.save(item.id),
    updateStatus: (itemId) => {
      const r = table.rows.get(itemId);
      if (r && r.status === 'processing') r.status = 'processing';
    },
    loadQueued: () => [],
    claimItem: (itemId, ownerId, leaseUntil, nowIso) => table.claim(itemId, ownerId, leaseUntil, nowIso),
    releaseExpiredLeases: (_a, nowIso) => table.releaseExpired(nowIso),
  };
  mb.setPersistence(p);
  return mb;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── P1 · 根因 #4：受保护集合（禁止合并）────────────────────────────────────

describe('P1 · 根因 #4：review_request 纳入受保护集合（禁止 consolidateGroup 合并）', () => {
  it('同 taskId 的其它事件被合并时，review_request 不被吞掉', () => {
    const mb = makeMailbox();
    mb.enqueue('task_status_update', { summary: 's', content: 'status', taskId: 'tsk_A' } as never);
    mb.enqueue('review_request', REVIEW('tsk_A', 1) as never);
    mb.enqueue('a2a_message', { summary: 'm', content: 'ping', taskId: 'tsk_A' } as never);

    const merged = mb.consolidateByEntity();
    const remaining = mb.getQueuedItems();

    // 合并机制确实在工作（status_update 吞掉 a2a_message）
    expect(merged).toBe(1);
    // review_request 仍在队列 —— strict-state 项绝不被合并吞掉（否则评审可能永不执行）
    expect(remaining.filter(i => i.sourceType === 'review_request')).toHaveLength(1);
    expect(remaining).toHaveLength(2);
  });

  it('同 task 的多轮 review_request 互不合并（每轮独立）', () => {
    const mb = makeMailbox();
    mb.enqueue('task_status_update', { summary: 's', content: 'status', taskId: 'tsk_B' } as never);
    mb.enqueue('review_request', REVIEW('tsk_B', 1) as never);
    mb.enqueue('review_request', REVIEW('tsk_B', 2) as never);

    expect(mb.consolidateByEntity()).toBe(0);
    expect(mb.getQueuedItems().filter(i => i.sourceType === 'review_request')).toHaveLength(2);
  });
});

// ─── P1 · 根因 #3：单播唤醒 ────────────────────────────────────────────────

describe('P1 · 根因 #3：review_request 单播唤醒（只唤醒一个 waiter，不再广播）', () => {
  it('3 个 idle waiter 时只唤醒 1 个：dequeue 总计 4 次（广播会是 8 次）', async () => {
    const mb = makeMailbox();
    const dequeueSpy = vi.spyOn(mb, 'dequeue');

    const waiters = [mb.dequeueAsync(), mb.dequeueAsync(), mb.dequeueAsync()];
    await flush();
    expect(dequeueSpy).toHaveBeenCalledTimes(3); // 三个 worker 各空转一次后挂起

    let resolved = 0;
    for (const w of waiters) void w.then(() => { resolved++; });

    mb.enqueue('review_request', REVIEW('tsk_U', 1) as never);
    await flush(10);

    expect(resolved).toBe(1);                     // 恰好一个 waiter 拿到 item
    expect(dequeueSpy).toHaveBeenCalledTimes(4);  // 仅被唤醒者再取件一次
  });

  it('对照组：非单播类型仍广播唤醒（同一 item 交付 1 次，但多出 4 次无用空转）', async () => {
    const mb = makeMailbox();
    const dequeueSpy = vi.spyOn(mb, 'dequeue');

    const waiters = [mb.dequeueAsync(), mb.dequeueAsync(), mb.dequeueAsync()];
    await flush();
    expect(dequeueSpy).toHaveBeenCalledTimes(3);

    let resolved = 0;
    for (const w of waiters) void w.then(() => { resolved++; });

    mb.enqueue('task_comment', { summary: 'c', content: 'x', taskId: 'tsk_V' } as never);
    await flush(10);

    expect(resolved).toBe(1);                     // 交付仍只有 1 次
    expect(dequeueSpy).toHaveBeenCalledTimes(8);  // 但 3 个 waiter 全被唤醒 → 败者空转
  });

  it('单播唤醒产生可度量的结构化日志（event = mailbox.unicast_wake）', async () => {
    const infoSpy = vi.spyOn(Logger.prototype, 'info');
    const mb = makeMailbox();

    void mb.dequeueAsync();
    void mb.dequeueAsync();
    void mb.dequeueAsync();
    await flush();

    mb.enqueue('review_request', REVIEW('tsk_W', 1) as never);
    await flush(10);

    const logs = eventOf(infoSpy, MAILBOX_OBSERVABILITY_EVENTS.unicastWake);
    expect(logs).toHaveLength(1);
    expect(logs[0]![1]).toMatchObject({ type: 'review_request', waiters: 3, routeKey: 'tsk_W:r1' });
  });

  it('只有 1 个 waiter 时退化为普通唤醒（不因单播而漏唤醒）', async () => {
    const mb = makeMailbox();
    const p = mb.dequeueAsync();
    await flush();

    mb.enqueue('review_request', REVIEW('tsk_X', 1) as never);

    await expect(p).resolves.toMatchObject({ sourceType: 'review_request' });
  });
});

// ─── P2 · 被丢弃的重复投递 ────────────────────────────────────────────────

describe('P2 · 被丢弃的重复投递（items 唯一键 / 入队幂等键拦截）', () => {
  function mailboxWithUniqueKey(): { mb: AgentMailbox; seen: Set<string> } {
    const mb = makeMailbox();
    const seen = new Set<string>();
    mb.setPersistence({
      save: (_item, dedupKey) => {
        if (!dedupKey) return true;
        if (seen.has(dedupKey)) return false;
        seen.add(dedupKey);
        return true;
      },
      updateStatus: () => {},
    });
    return { mb, seen };
  }

  it('同 (agent, review_request, task, round) 第二次投递被拒 → 不入队 + 结构化日志', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const { mb } = mailboxWithUniqueKey();

    const first = mb.enqueue('review_request', REVIEW('tsk_D', 1) as never);
    const dup = mb.enqueue('review_request', REVIEW('tsk_D', 1) as never);

    expect(first.status).toBe('queued');
    expect(dup.status).toBe('dropped');
    expect(mb.getQueuedItems()).toHaveLength(1); // 不产生第二次入队

    const logs = eventOf(warnSpy, MAILBOX_OBSERVABILITY_EVENTS.duplicateDeliveryDropped);
    expect(logs).toHaveLength(1);
    expect(logs[0]![1]).toMatchObject({
      dedupKey: 'review_request:tsk_D:1', type: 'review_request', count: 1,
    });
  });

  it('不同 round 不被误去重（新一轮评审正常入队）', () => {
    const { mb } = mailboxWithUniqueKey();
    mb.enqueue('review_request', REVIEW('tsk_D2', 1) as never);
    const r2 = mb.enqueue('review_request', REVIEW('tsk_D2', 2) as never);
    expect(r2.status).toBe('queued');
    expect(mb.getQueuedItems()).toHaveLength(2);
  });

  it('重复投递会了结投递方 responsePromise（防 notifyReviewer 永久挂起 / activeReviews 残留）', () => {
    const { mb } = mailboxWithUniqueKey();
    mb.enqueue('review_request', REVIEW('tsk_E', 1) as never);

    const resolve = vi.fn();
    const reject = vi.fn();
    const dup = mb.enqueue('review_request', REVIEW('tsk_E', 1) as never, {
      metadata: { responsePromise: { resolve, reject } } as never,
    });

    expect(dup.status).toBe('dropped');
    expect(resolve).toHaveBeenCalledWith('[duplicate-delivery-suppressed]');
    expect(reject).not.toHaveBeenCalled();
  });
});

// ─── P2 · 认领竞争 / 租约过期重放 ──────────────────────────────────────────

describe('P2 · 认领竞争与租约过期重放（结构化日志可度量）', () => {
  it('两实例竞争同一 item → 败者让位并产生 claimContested 日志', () => {
    const infoSpy = vi.spyOn(Logger.prototype, 'info');
    const table = makeSharedTable();
    const a = makeMailboxWith(table, 'agt_c');
    const b = makeMailboxWith(table, 'agt_c');

    const item = a.enqueue('review_request', REVIEW('tsk_F', 1) as never);
    // 模拟另一实例把同一行载入自己的内存队列（共享同一持久层）
    (b as unknown as { queue: MailboxItem[] }).queue.push({ ...item });

    const gotA = a.dequeue();
    const gotB = b.dequeue();

    expect(gotA).toBeTruthy();
    expect(gotB).toBeUndefined();

    const logs = eventOf(infoSpy, MAILBOX_OBSERVABILITY_EVENTS.claimContested);
    expect(logs).toHaveLength(1);
    expect(logs[0]![1]).toMatchObject({ itemId: item.id, type: 'review_request', count: 1 });
  });

  it('租约过期回收 → leaseExpiredReplay 日志（count 可加总）', () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const table = makeSharedTable();
    const mb = makeMailboxWith(table, 'agt_l');
    // 造一行「processing + 租约已过期」：崩溃/超时 worker 的占位
    table.rows.set('mbx_expired', {
      status: 'processing', claimedBy: 'other', leaseUntil: new Date(Date.now() - 60_000).toISOString(),
    });

    const n = mb.reclaimExpiredLeases();

    expect(n).toBe(1);
    const logs = eventOf(warnSpy, MAILBOX_OBSERVABILITY_EVENTS.leaseExpiredReplay);
    expect(logs).toHaveLength(1);
    expect(logs[0]![1]).toMatchObject({ count: 1 });
  });
});
