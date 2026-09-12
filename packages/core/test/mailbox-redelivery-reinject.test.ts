/**
 * P1.x · 重投三态判定 + 复用原行回队 —— core 层验收测试（轻量 fake 持久层）
 *
 * 与 `mailbox-redelivery-sqlite.test.ts`（真实 SQLite 端到端）互补：本文件锁定**判定逻辑**
 * 与 `enqueue` 的返回语义（QA 原始打回症状 = re-enqueue 返回 `status=dropped`、队列 `0→0`）。
 *
 * 硬验收点：
 *  - (a) 同键冲突复用原行回队：不新增行、不触发唯一键拒绝、返回 `queued`（不是 `dropped`）；
 *  - (c) 四态判定由**唯一函数** `resolveReinjectDecision` 实现（全库只此一处）；
 *  - (b) 回队刷新 `queued_at`，且回队写路径**不得依赖 `releaseClaim`**（D1）；
 *  - P0/P1 既有语义保持：在飞 → 幂等抑制 + `responsePromise` 了结 + `duplicateDeliveryDropped`。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@markus/shared';
import {
  AgentMailbox, MAILBOX_OBSERVABILITY_EVENTS, resolveReinjectDecision,
  type MailboxPersistence,
} from '../src/mailbox.js';
import { EventBus } from '../src/events.js';

const REVIEW = (taskId: string, round: number) => ({
  summary: `Review ${taskId} r${round}`,
  content: 'please review',
  taskId,
  extra: { round },
});

interface FakeRow {
  id: string;
  status: string;
  claimedBy: string | null;
  leaseUntil: string | null;
  queuedAt: string;
  dedupKey?: string;
}

/** 复刻 SQLite 契约的轻量替身：唯一键拒重、findByDedupKey、无条件 requeueItem。 */
function makeFake() {
  const rows = new Map<string, FakeRow>();
  const calls = { save: 0, requeueItem: [] as Array<{ id: string; queuedAt?: string }>, releaseClaim: 0 };
  const p: MailboxPersistence = {
    save: (item, dedupKey) => {
      calls.save++;
      if (dedupKey && [...rows.values()].some(r => r.dedupKey === dedupKey)) return false;
      rows.set(item.id, {
        id: item.id, status: item.status, claimedBy: null, leaseUntil: null,
        queuedAt: item.queuedAt, dedupKey,
      });
      return true;
    },
    updateStatus: (id, status) => { const r = rows.get(id); if (r) r.status = status; },
    findByDedupKey: (_agentId, dedupKey) => {
      const r = [...rows.values()].find(x => x.dedupKey === dedupKey);
      return r ? { id: r.id, status: r.status, claimedBy: r.claimedBy, leaseUntil: r.leaseUntil, queuedAt: r.queuedAt } : undefined;
    },
    requeueItem: (id, opts) => {
      const r = rows.get(id);
      if (!r) return false;
      r.status = 'queued'; r.claimedBy = null; r.leaseUntil = null;
      r.queuedAt = opts?.queuedAt ?? new Date().toISOString();
      calls.requeueItem.push({ id, queuedAt: opts?.queuedAt });
      return true;
    },
    releaseClaim: () => { calls.releaseClaim++; },
    claimItem: (id, ownerId, leaseUntil) => {
      const r = rows.get(id);
      if (!r || r.status !== 'queued') return false;
      r.status = 'processing'; r.claimedBy = ownerId; r.leaseUntil = leaseUntil;
      return true;
    },
    loadQueued: () => [],
  };
  return { p, rows, calls };
}

function makeMailbox(persistence: MailboxPersistence, agentId = 'agt_p1x') {
  return new AgentMailbox(agentId, new EventBus(), persistence);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('P1.x (c) · resolveReinjectDecision 四态（唯一判定实现）', () => {
  const row = (status: string, id = 'mbx_1') => ({ id, status, claimedBy: null, leaseUntil: null, queuedAt: 'T' });

  it('行不存在 → insert', () => {
    expect(resolveReinjectDecision(undefined)).toEqual({ action: 'insert' });
  });

  it('在飞（queued / processing / deferred）→ suppress(in-flight)', () => {
    for (const s of ['queued', 'processing', 'deferred']) {
      const d = resolveReinjectDecision(row(s));
      expect(d.action, s).toBe('suppress');
      if (d.action === 'suppress') expect(d.reason).toBe('in-flight');
    }
  });

  it('未收口终态（dropped / failed）→ reuse（允许补偿重投）', () => {
    for (const s of ['dropped', 'failed']) {
      const d = resolveReinjectDecision(row(s));
      expect(d.action, s).toBe('reuse');
    }
  });

  it('已收口（completed / merged）→ suppress(settled)（拒重投）', () => {
    for (const s of ['completed', 'merged']) {
      const d = resolveReinjectDecision(row(s));
      expect(d.action, s).toBe('suppress');
      if (d.action === 'suppress') expect(d.reason).toBe('settled');
    }
  });

  it('显式复用（停机重投：explicitReuseId === 既有行 id）→ 即便 processing 也 reuse', () => {
    const d = resolveReinjectDecision(row('processing', 'mbx_r2'), { explicitReuseId: 'mbx_r2' });
    expect(d).toEqual({ action: 'reuse', itemId: 'mbx_r2' });
  });
});

describe('P1.x (a)(b) · enqueue 复用原行回队（返回 queued）', () => {
  it('停机重投：不新增行、清认领、刷 queued_at，返回值 status=queued', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { p, rows } = makeFake();
    const mb = makeMailbox(p);

    const item = mb.enqueue('review_request', REVIEW('task_1', 1));
    const dequeued = mb.dequeue()!;
    expect(rows.get(item.id)!.status).toBe('processing');

    const requeued = mb.enqueue('review_request', REVIEW('task_1', 1), { reuseItemId: dequeued.id });

    expect(requeued.id, '复用原行 id（不新增行）').toBe(item.id);
    expect(requeued.status, 'QA 硬验收：必须返回 queued，不得返回 dropped').toBe('queued');
    expect(rows.size, '同一幂等键仍仅 1 行').toBe(1);
    const r = rows.get(item.id)!;
    expect(r.status).toBe('queued');
    expect(r.claimedBy).toBeNull();
    expect(r.leaseUntil).toBeNull();
    expect(r.queuedAt >= item.queuedAt, '(b) queued_at 已刷新').toBe(true);
    expect(mb.depth).toBe(1);
    expect(warn.mock.calls.some(c => (c[1] as Record<string, unknown> | undefined)?.['event']
      === MAILBOX_OBSERVABILITY_EVENTS.deliveryReinjected), '记 deliveryReinjected 可观测事件').toBe(true);
  });

  it('同键既有行 dropped（未收口）→ 复用原行重投，不新增行', () => {
    const { p, rows } = makeFake();
    rows.set('mbx_old', {
      id: 'mbx_old', status: 'dropped', claimedBy: null, leaseUntil: null,
      queuedAt: '2000-01-01T00:00:00.000Z', dedupKey: 'review_request:task_9:2',
    });
    const mb = makeMailbox(p);

    const out = mb.enqueue('review_request', REVIEW('task_9', 2));

    expect(out.id).toBe('mbx_old');
    expect(out.status).toBe('queued');
    expect(rows.size).toBe(1);
    expect(rows.get('mbx_old')!.queuedAt).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('同键既有行 completed（已收口）→ 幂等抑制，不复活', () => {
    const { p, rows } = makeFake();
    rows.set('mbx_done', {
      id: 'mbx_done', status: 'completed', claimedBy: null, leaseUntil: null,
      queuedAt: '2026-09-01T00:00:00.000Z', dedupKey: 'review_request:task_7:1',
    });
    const mb = makeMailbox(p);

    const out = mb.enqueue('review_request', REVIEW('task_7', 1));

    expect(out.status).toBe('dropped');
    expect(rows.get('mbx_done')!.status).toBe('completed');
    expect(mb.depth).toBe(0);
  });
});

describe('P1.x · 既有 P0/P1 语义不回归', () => {
  it('在飞同键投递 → 幂等抑制 + responsePromise 了结 + duplicateDeliveryDropped', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { p, rows } = makeFake();
    const mb = makeMailbox(p);
    mb.enqueue('review_request', REVIEW('task_5', 3));

    const resolve = vi.fn();
    const dup = mb.enqueue('review_request', REVIEW('task_5', 3), { metadata: { responsePromise: { resolve } } as never });

    expect(dup.status).toBe('dropped');
    expect(resolve).toHaveBeenCalledWith('[duplicate-delivery-suppressed]');
    expect(rows.size).toBe(1);
    expect(warn.mock.calls.some(c => (c[1] as Record<string, unknown> | undefined)?.['event']
      === MAILBOX_OBSERVABILITY_EVENTS.duplicateDeliveryDropped)).toBe(true);
  });

  it('旧持久层（无 findByDedupKey）→ 退化为 P0 行为：save()===false 即抑制', () => {
    const legacy: MailboxPersistence = {
      save: (_item, dedupKey) => (dedupKey ? false : true),
      updateStatus: () => { /* noop */ },
    };
    const mb = makeMailbox(legacy, 'agt_legacy');

    expect(mb.enqueue('review_request', REVIEW('task_1', 1)).status).toBe('dropped');
  });

  it('putBack 走 requeueItem，不再依赖 releaseClaim（D1）', () => {
    const { p, rows, calls } = makeFake();
    const mb = makeMailbox(p);
    const item = mb.enqueue('heartbeat', { summary: 'hb', content: 'check' });
    const dq = mb.dequeue()!;
    calls.requeueItem.length = 0;
    calls.releaseClaim = 0;

    mb.putBack(dq);

    expect(calls.requeueItem, '回队必须落到 requeueItem（无条件释放 + 刷 queued_at）').toHaveLength(1);
    expect(calls.releaseClaim, '不得依赖 releaseClaim').toBe(0);
    expect(rows.get(item.id)!.claimedBy).toBeNull();
    expect(mb.depth).toBe(1);
  });
});
