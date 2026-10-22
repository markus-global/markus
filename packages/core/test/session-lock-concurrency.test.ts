/**
 * 记忆会话互斥 —— 2026-10-22 事故的回归护栏。
 *
 * ## 事故（真实数据，非构造）
 * `mailbox_items` 里有一个 `human_chat`（mbx_1716ea0a…，383 字）和一个
 * `callback_result`（mbx_a1fa998c…，后台 `quick-release` 完成回调）。
 *
 * | 时间 (UTC) | worker | 实体键 | 事件 |
 * |---|---|---|---|
 * | 14:25:32 | 1 | `conv:cs_9809eb…` | 聊天回合开始 |
 * | 14:27:42 | **2** | `system:agt_…` | 回调回合开始 —— **同一记忆会话** |
 * | 14:29:36 | 1 | | 聊天回合落库 `content` 长度 **0** |
 *
 * 实体键是**从 payload 声明**推出来的；`callback_result` 不带会话字段，于是退化成
 * `system:<agentId>` 这把全局键，而它实际运行在 `this.currentSessionId`（聊天会话）
 * 里。两把锁量的是两个不同的资源 → 两个回合同写一份记忆：回调回合吃掉了聊天回合的
 * 收口续跑，产出的 169 字答案没有任何投递通道（它没有 onEvent / responsePromise），
 * 用户只看到一条空回复。
 *
 * ## 不变量
 * **一个记忆会话，同一时刻只能有一个回合在跑。** 锁键必须包含「回合会跑进哪个会话」，
 * 由 delegate 用与 `resolveTurnSession` 同一套解析表态，而不是由 item 类型声明。
 */
import { describe, it, expect } from 'vitest';
import { AttentionController, type AttentionDelegate } from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import type { MailboxItem } from '@markus/shared';

const AGENT_ID = 'session-lock-agent';

type Probe = {
  /** 观测到的最大并发回合数 */
  maxConcurrent: number;
  /** 实际并发的证据：同一时刻在跑的两个 item */
  overlaps: Array<[string, string]>;
  /** 已开始处理的 item（用于在测试里等「第一个回合真的在跑」） */
  started: string[];
  processed: string[];
};

/**
 * 一个只关心「谁和谁能同时跑」的 delegate。
 * `sessionKeys` 决定每个 item 声称会跑进哪个记忆会话 —— 这正是生产里 Agent 侧
 * `sessionLockKey()` 的职责。
 */
function makeHarness(opts: {
  sessionKeys: (item: MailboxItem) => string | undefined;
  turnMs?: number;
}) {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus);
  const turnMs = opts.turnMs ?? 80;
  const probe: Probe = { maxConcurrent: 0, overlaps: [], started: [], processed: [] };
  const inFlight = new Map<string, string>(); // sessionKey -> itemId

  const delegate: AttentionDelegate = {
    async processMailboxItem(item: MailboxItem) {
      const key = opts.sessionKeys(item) ?? `none:${item.id}`;
      if (inFlight.size > 0) {
        probe.overlaps.push([[...inFlight.values()][0] as string, item.id]);
      }
      inFlight.set(key, item.id);
      probe.started.push(item.id);
      probe.maxConcurrent = Math.max(probe.maxConcurrent, inFlight.size);
      await new Promise(r => setTimeout(r, turnMs));
      inFlight.delete(key);
      probe.processed.push(item.id);
    },
    onDecisionMade() {},
    onFocusChanged() {},
    async evaluateInterrupt() { return 'process_now' as const; },
    sessionLockKey: opts.sessionKeys,
  };

  const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
  controller.setDelegate(delegate);
  controller.setWorkerCount(2);
  return { controller, mailbox, eventBus, probe };
}

/** 等到 predicate 成立或超时（测试不做固定 sleep 断言，避免机器快慢导致假红）。 */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('一个记忆会话只能有一个回合在跑', () => {
  it('聊天回合与后台回调回合绑定同一会话时，绝不并发（2026-10-22 事故形态）', async () => {
    const h = makeHarness({
      // 两者都会跑进 sess_XYZ：聊天回合经 dbSessionId 绑定，回调经 originSessionId
      // 回到发起轮。它们的**实体键**不同（conv:cs_… vs system:agt_…），
      // 所以只有会话键能拦住它们。
      sessionKeys: item =>
        item.sourceType === 'human_chat' || item.sourceType === 'callback_result'
          ? 'session:sess_XYZ'
          : undefined,
    });

    h.controller.start();
    try {
      h.mailbox.enqueue('human_chat', {
        summary: '老板的 383 字消息',
        content: '已经合并了。创建一个新的 rc 版本吧。',
        extra: { dbSessionId: 'cs_9809eb465fec4577' },
      });
      h.mailbox.enqueue('callback_result', {
        summary: 'Background process succeeded',
        content: '[BACKGROUND PROCESS COMPLETED] quick-release rc',
        extra: { originSessionId: 'sess_XYZ' },
      });

      await waitFor(() => h.probe.processed.length === 2);
    } finally {
      h.controller.stop();
    }

    // 同一会话的登录日志里，两次回合必须首尾相接，不能重叠。
    expect(h.probe.overlaps).toEqual([]);
    expect(h.probe.maxConcurrent).toBe(1);
    expect(h.probe.processed).toHaveLength(2);
  });

  it('不同会话仍然并行（修复不能退化成全agent串行）', async () => {
    const h = makeHarness({
      sessionKeys: item => `session:sess_${item.sourceType}`,
    });

    h.controller.start();
    try {
      h.mailbox.enqueue('human_chat', {
        summary: 'A 会话', content: 'a', extra: { dbSessionId: 'cs_a' },
      }, { metadata: { dbSessionId: 'cs_a', senderId: 'jason' } });
      // 先等第一个回合真的在跑，再入队第二个——否则「第二个 worker 还没就位」
      // 会被误读成「锁把它挡住了」。
      await waitFor(() => h.probe.started.length === 1);
      h.mailbox.enqueue('callback_result', {
        summary: 'B 会话', content: 'b', extra: { originSessionId: 'sess_b' },
      });

      await waitFor(() => h.probe.processed.length === 2);
    } finally {
      h.controller.stop();
    }

    expect(h.probe.overlaps).toHaveLength(1);
    expect(h.probe.maxConcurrent).toBe(2);
  });

  it('delegate 不提供会话键时保持旧行为（向后兼容，不静默串行化）', async () => {
    const h = makeHarness({ sessionKeys: () => undefined });

    h.controller.start();
    try {
      h.mailbox.enqueue('human_chat', {
        summary: 'A', content: 'a', extra: { dbSessionId: 'cs_a' },
      }, { metadata: { dbSessionId: 'cs_a', senderId: 'jason' } });
      await waitFor(() => h.probe.started.length === 1);
      h.mailbox.enqueue('callback_result', {
        summary: 'B', content: 'b', extra: { originSessionId: 'sess_b' },
      });

      await waitFor(() => h.probe.processed.length === 2);
    } finally {
      h.controller.stop();
    }

    expect(h.probe.maxConcurrent).toBe(2);
  });
});
