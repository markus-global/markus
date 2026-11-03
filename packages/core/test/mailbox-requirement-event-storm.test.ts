/**
 * 需求事件风暴：两处根因各一条行为断言。
 *
 * 现场证据（真实库 `~/.markus/data.db`，2026-11-03）：
 *  - 同一任务同一 `executionRound` 的 `task_status_update` 被投递 11 次，
 *    15 条同类条目 `dedup_key` **全为 NULL** —— 幂等键根本没算出来；
 *  - 需求 `completed` 之后，带 `extra.actionRequired` 的 `[REQUIREMENT REVIEW NEEDED]`
 *    条目仍停在 queued/processing，被反复重投 40 余轮。
 *
 * 这里钉住两件事：
 *  1. 轮次字段的**两个写法**（`extra.round` / `extra.executionRound`）都能算出幂等键，
 *     且不同迁移对（from→to）**不得**被折叠；
 *  2. 转终态时未消费的行动型条目能被撤回，而普通流水不受影响。
 */
import { describe, it, expect } from 'vitest';
import type { MailboxItem } from '@markus/shared';
import { AgentMailbox, mailboxDedupKey, type MailboxPersistence } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';

function statusUpdate(extra: Record<string, unknown>, taskId = 'tsk_1') {
  return {
    sourceType: 'task_status_update' as const,
    payload: { summary: 's', content: 'c', taskId, extra } as never,
    metadata: { taskId },
  };
}

describe('mailboxDedupKey · 轮次字段别名与迁移对', () => {
  it('`extra.executionRound`（任务执行链路实际写法）也能算出稳定的键', () => {
    const a = mailboxDedupKey(statusUpdate({ executionRound: 2, from: 'in_progress', to: 'completed' }));
    const b = mailboxDedupKey(statusUpdate({ executionRound: 2, from: 'in_progress', to: 'completed' }));
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).toBe('task_status_update:tsk_1:2:in_progress->completed');
  });

  it('同一轮次里 in_progress→review→in_progress→review 是**两个事实**，不得折叠', () => {
    const first = mailboxDedupKey(statusUpdate({ executionRound: 2, from: 'in_progress', to: 'review' }));
    const second = mailboxDedupKey(statusUpdate({ executionRound: 2, from: 'review', to: 'in_progress' }));
    expect(first).not.toBe(second);
  });

  it('不同轮次 → 不同键（返工后的终态是新的通知）', () => {
    const r1 = mailboxDedupKey(statusUpdate({ executionRound: 1, from: 'in_progress', to: 'completed' }));
    const r2 = mailboxDedupKey(statusUpdate({ executionRound: 2, from: 'in_progress', to: 'completed' }));
    expect(r1).not.toBe(r2);
  });

  it('缺 from/to 时不猜 —— 返回 undefined 而不是用文本反解析', () => {
    expect(mailboxDedupKey(statusUpdate({ executionRound: 2 }))).toBeUndefined();
  });

  it('review_request 的旧写法（extra.round）没有被改坏', () => {
    expect(
      mailboxDedupKey({
        sourceType: 'review_request' as const,
        payload: { summary: 's', content: 'c', taskId: 'tsk_1', extra: { round: 2 } } as never,
        metadata: {},
      }),
    ).toBe('review_request:tsk_1:2');
  });
});

describe('withdrawActionableFor · 需求转终态时撤回未消费的行动项', () => {
  function harness() {
    const mb = new AgentMailbox('agt_storm', new EventBus());
    const statuses = new Map<string, string>();
    const dropped: string[] = [];
    const p: MailboxPersistence = {
      save: () => true,
      updateStatus: (id, status) => { statuses.set(id, status); },
      dropPendingByEntity: (_agentId, _entityId, _reason) => { dropped.push(_entityId); return 1; },
    };
    mb.setPersistence(p);
    return { mb, statuses, dropped };
  }

  it('只撤行动型，普通状态流水留下（历史要能查）', () => {
    const { mb, statuses } = harness();
    const actionable = mb.enqueue('requirement_update', {
      summary: 'review needed',
      content: 'c',
      requirementId: 'req_1',
      extra: { actionRequired: true },
    });
    const plain = mb.enqueue('requirement_update', {
      summary: 'status changed',
      content: 'c',
      requirementId: 'req_1',
    });

    const removed = mb.withdrawActionableFor('req_1', 'requirement in_progress → completed');

    expect(statuses.get(actionable.id)).toBe('dropped');
    expect(statuses.get(plain.id)).toBeUndefined();
    // 持久层那一半（queued/processing 的行）也要被通知到
    expect(removed).toBeGreaterThanOrEqual(2);
  });

  it('不碰其它需求的行动项（撤回按实体收敛）', () => {
    const { mb, statuses } = harness();
    const other = mb.enqueue('requirement_update', {
      summary: 'review needed',
      content: 'c',
      requirementId: 'req_2',
      extra: { actionRequired: true },
    });
    mb.withdrawActionableFor('req_1', 'whatever');
    expect(statuses.get(other.id)).toBeUndefined();
  });
});

describe('AgentMailbox · 同一事实重复入队被幂等键拦住', () => {
  it('相同 (任务, 轮次, 迁移对) 第二次入队不产生第二行', () => {
    const mb = new AgentMailbox('agt_dup', new EventBus());
    const rows = new Map<string, MailboxItem>();
    const byKey = new Map<string, string>();
    mb.setPersistence({
      save: (item, dedupKey) => {
        if (dedupKey && byKey.has(dedupKey)) return false;
        if (dedupKey) byKey.set(dedupKey, item.id);
        rows.set(item.id, item);
        return true;
      },
      updateStatus: () => {},
      findByDedupKey: (_aid, key) => {
        const id = byKey.get(key);
        if (!id) return undefined;
        return { id, status: 'queued', claimedBy: null, leaseUntil: null, queuedAt: new Date().toISOString() };
      },
    });

    const payload = { summary: 's', content: 'c', taskId: 'tsk_9', extra: { executionRound: 1, from: 'in_progress', to: 'completed' } };
    mb.enqueue('task_status_update', payload as never, { metadata: { taskId: 'tsk_9' } });
    mb.enqueue('task_status_update', payload as never, { metadata: { taskId: 'tsk_9' } });

    expect(rows.size).toBe(1);
  });
});
