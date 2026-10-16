/**
 * Part 2 · P0 修复回归锁
 *
 * 锁两件结构性的事：
 *
 * 1. **批量分拣不能被"严格状态项"一票否决。**
 *    严格状态项（triggerExecution / review_request / requirement|workflow(actionRequired)）
 *    本来就被排除在 deliberation 的视界之外（attention 循环里的 allItems 过滤）。旧实现
 *    却在 `needsLLMTriage` 里加了「队列里只要有一条 strict 就 return false」，于是**整个队列**
 *    跳过批量分拣 → 退化成逐条各触发一次 LLM run（回复风暴）。判据必须只看**会被分拣看见的**
 *    那部分队列。
 *
 * 2. **按年龄的陈旧清理不得回收「仍欠动作/带用户可见回复」的项。**
 *    清理的职权范围只有**纯信息类**项；否则真实消息会无声消失（静默丢消息）。
 */
import { describe, it, expect, vi } from 'vitest';
import { AttentionController, type AttentionDelegate } from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import {
  TRIAGE_STALE_INFO_TTL_MS,
  type MailboxItem,
  type MailboxPriority,
} from '@markus/shared';

const AGENT_ID = 'mailbox-batch-purge-agent';

function makeMailbox() {
  return new AgentMailbox(AGENT_ID, new EventBus());
}

function makeController() {
  const mailbox = makeMailbox();
  const delegate: AttentionDelegate = {
    processMailboxItem: vi.fn().mockResolvedValue('done'),
    onDecisionMade: vi.fn(),
    onFocusChanged: vi.fn(),
    evaluateInterrupt: vi.fn().mockResolvedValue('continue'),
    onTriageCompleted: vi.fn(),
    performDeliberation: vi.fn().mockResolvedValue(null),
    onDeliberationCompleted: vi.fn(),
  };
  const controller = new AttentionController(AGENT_ID, mailbox, new EventBus());
  controller.setDelegate(delegate);
  return { controller, mailbox };
}

export {}; // keep this module a module

// ─────────────────────────────────────────────────────────────────────────────
// 1. 批量分拣不被 strict 项一票否决
// ─────────────────────────────────────────────────────────────────────────────
describe('needsLLMTriage · strict 项不得否决整队列的批量分拣', () => {
  it('普通消息 + 普通消息 + review_request ⇒ 仍应批量分拣（今天会 false ⇒ 逐条唤醒）', () => {
    const { controller, mailbox } = makeController();
    const head = mailbox.enqueue('a2a_message', { summary: '1', content: '1' });
    // 模拟真实取值点：head 已出队
    mailbox.dequeue();
    mailbox.enqueue('a2a_message', { summary: '2', content: '2' });
    mailbox.enqueue('review_request', { summary: 'r', content: 'r' });

    expect(controller['needsLLMTriage'](head)).toBe(true);
  });

  it('队列里只剩 strict 项 ⇒ 无需分拣（避免空转一次 LLM）', () => {
    const { controller, mailbox } = makeController();
    const head = mailbox.enqueue('a2a_message', { summary: '1', content: '1' });
    mailbox.dequeue();
    mailbox.enqueue('review_request', { summary: 'r', content: 'r' });

    expect(controller['needsLLMTriage'](head)).toBe(false);
  });

  it('头部本身是 strict 项 ⇒ 不分拣（原有语义不变）', () => {
    const { controller, mailbox } = makeController();
    const head = mailbox.enqueue('review_request', { summary: 'r', content: 'r' });
    mailbox.enqueue('a2a_message', { summary: '2', content: '2' });

    expect(controller['needsLLMTriage'](head)).toBe(false);
  });

  it('人消息头部 ⇒ 永不分拣（原有语义不变）', () => {
    const { controller, mailbox } = makeController();
    const head = mailbox.enqueue('human_chat', { summary: 'hi', content: 'hi' });
    mailbox.enqueue('a2a_message', { summary: '2', content: '2' });

    expect(controller['needsLLMTriage'](head)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 按年龄的陈旧清理不得回收"欠动作/用户可见"的项
// ─────────────────────────────────────────────────────────────────────────────
describe('purgeStaleItems · 只回收纯信息类', () => {
  function withFakeClock(fn: () => void) {
    vi.useFakeTimers();
    try { fn(); } finally { vi.useRealTimers(); }
  }

  it('陈旧的信息项仍会被回收（回归守卫：别过度修）', () => {
    withFakeClock(() => {
      const mailbox = makeMailbox();
      mailbox.enqueue('heartbeat', { summary: 'h', content: 'h' } as never);
      vi.advanceTimersByTime(TRIAGE_STALE_INFO_TTL_MS + 60_000);
      expect(mailbox.purgeStaleItems()).toBe(1);
    });
  });

  it('陈旧但携带 actionRequired ⇒ 不得回收', () => {
    withFakeClock(() => {
      const mailbox = makeMailbox();
      mailbox.enqueue('heartbeat', { summary: 'h', content: 'h', extra: { actionRequired: true } } as never);
      vi.advanceTimersByTime(TRIAGE_STALE_INFO_TTL_MS + 60_000);
      expect(mailbox.purgeStaleItems()).toBe(0);
      expect(mailbox.getQueuedItems()).toHaveLength(1);
    });
  });

  it('陈旧但直接 @ 了本 agent ⇒ 不得回收', () => {
    withFakeClock(() => {
      const mailbox = makeMailbox();
      mailbox.enqueue('heartbeat', { summary: 'h', content: 'h', extra: { directMention: true } } as never);
      vi.advanceTimersByTime(TRIAGE_STALE_INFO_TTL_MS + 60_000);
      expect(mailbox.purgeStaleItems()).toBe(0);
    });
  });

  it('callback_result（含用户可见回复）⇒ 不得按年龄回收', () => {
    withFakeClock(() => {
      const mailbox = makeMailbox();
      mailbox.enqueue('callback_result', { summary: 'reply', content: 'reply' } as never);
      vi.advanceTimersByTime(TRIAGE_STALE_INFO_TTL_MS + 60_000);
      expect(mailbox.purgeStaleItems()).toBe(0);
    });
  });

  it('混合：只回收纯信息项，欠动件保留', () => {
    withFakeClock(() => {
      const mailbox = makeMailbox();
      // 用不同 sourceType，避免心跳「折叠」干扰本用例的意图
      mailbox.enqueue('task_status_update', { summary: 'plain', content: 'plain' } as never);
      mailbox.enqueue('daily_report', { summary: 'act', content: 'act', extra: { actionRequired: true } } as never);
      mailbox.enqueue('memory_consolidation', { summary: 'rep', content: 'rep' } as never);
      vi.advanceTimersByTime(TRIAGE_STALE_INFO_TTL_MS + 60_000);

      expect(mailbox.purgeStaleItems()).toBe(2);
      const left = mailbox.getQueuedItems();
      expect(left).toHaveLength(1);
      expect((left[0] as MailboxItem).payload.extra?.actionRequired).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 安全网：批量分拣运行时，队列中的 strict 项必须受保护
// ─────────────────────────────────────────────────────────────────────────────
describe('批量分拣与 strict 项共存 · 安全网', () => {
  it('分拣结果试图 defer/drop/inline 一个 strict 项时，它必须原样留在队列', () => {
    const { controller, mailbox } = makeController();
    const head = mailbox.enqueue('a2a_message', { summary: 'a', content: 'a' });
    const strict = mailbox.enqueue('review_request', { summary: 'r', content: 'r', taskId: 'tsk_x' });
    // 真实循环里「待处理的那一条」先出队（按 id 取，避免优先级队列取走 strict 项）
    mailbox.dequeueById(head.id);

    controller['applyDeliberationResult'](head, {
      processItemIds: [head.id],
      processItemId: head.id,
      deferItemIds: [strict.id],
      dropItemIds: [strict.id],
      inlineCompletedIds: [strict.id],
      batchContext: undefined,
      reasoning: 'test',
    } as never);

    expect(mailbox.getQueuedItems().some(i => i.id === strict.id)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. D · 合并无损：心跳折叠不得吞掉带动作的心跳
// ─────────────────────────────────────────────────────────────────────────────
describe('enqueue 心跳折叠 · 不得吞掉带动作的心跳', () => {
  it('纯巡检心跳仍折叠（回归守卫：别过度修）', () => {
    const mailbox = makeMailbox();
    mailbox.enqueue('heartbeat', { summary: 'h1', content: 'h1' } as never);
    mailbox.enqueue('heartbeat', { summary: 'h2', content: 'h2' } as never);
    expect(mailbox.depth).toBe(1);
  });

  it('带 actionRequired 的心跳不得被折叠（否则待办动作静默消失）', () => {
    const mailbox = makeMailbox();
    mailbox.enqueue('heartbeat', { summary: 'h1', content: 'h1' } as never);
    mailbox.enqueue('heartbeat', { summary: 'act', content: 'act', extra: { actionRequired: true } } as never);
    expect(mailbox.depth).toBe(2);
  });

  it('带 directMention 的心跳不得被折叠', () => {
    const mailbox = makeMailbox();
    mailbox.enqueue('heartbeat', { summary: 'h1', content: 'h1' } as never);
    mailbox.enqueue('heartbeat', { summary: 'at', content: 'at', extra: { directMention: true } } as never);
    expect(mailbox.depth).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. D · drop 可观测、可回溯
// ─────────────────────────────────────────────────────────────────────────────
describe('mailbox.drop · 丢弃必须留痕', () => {
  it('drop 会广播 mailbox:dropped（含理由），并把项移出队列', () => {
    const bus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, bus);
    const seen: Array<Record<string, unknown>> = [];
    bus.on('mailbox:dropped', (payload: unknown) => seen.push(payload as Record<string, unknown>));

    const item = mailbox.enqueue('a2a_message', { summary: 'x', content: 'x' });
    expect(mailbox.depth).toBe(1);

    const dropped = mailbox.drop(item.id, 'test: not relevant');

    expect(dropped?.id).toBe(item.id);
    expect(mailbox.depth).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ itemId: item.id, sourceType: 'a2a_message', reason: 'test: not relevant' });
  });
});
