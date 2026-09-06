import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AttentionController,
  type AttentionDelegate,
} from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { createSessionWorkspace, sessionWorkspaceStore, type SessionWorkspace } from '../src/session-workspace.js';
import { COMPLETION_MARKER, type MailboxItem, type MailboxItemType, type MailboxPriority } from '@markus/shared';

const AGENT_ID = 'attn-concurrent-agent';

function makeItem(overrides: Partial<MailboxItem> & { sourceType: MailboxItemType }): MailboxItem {
  return {
    id: `mbx_${Math.random().toString(36).slice(2, 8)}`,
    agentId: AGENT_ID,
    priority: 2 as MailboxPriority,
    status: 'queued',
    payload: { summary: 'test', content: 'body' },
    queuedAt: new Date().toISOString(),
    ...overrides,
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(stepMs);
  }
}

interface Harness {
  controller: AttentionController;
  mailbox: AgentMailbox;
  delegate: AttentionDelegate & { processMailboxItem: ReturnType<typeof vi.fn> };
  doneIds: string[];
  activeCount: () => number;
  maxActive: () => number;
}

function makeConcurrentHarness(workerCount = 2): Harness {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus);
  const doneIds: string[] = [];
  let active = 0;
  let maxActive = 0;

  const workspaces = new Map<number, SessionWorkspace>();
  const delegate: AttentionDelegate & { processMailboxItem: ReturnType<typeof vi.fn> } = {
    processMailboxItem: vi.fn(async (item: MailboxItem) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(60);
      active--;
      doneIds.push(item.id);
      return item.sourceType === 'a2a_message' || item.sourceType === 'human_chat'
        ? `done ${COMPLETION_MARKER}`
        : 'ok';
    }),
    onDecisionMade: vi.fn(),
    onFocusChanged: vi.fn(),
    evaluateInterrupt: vi.fn().mockResolvedValue('preempt'),
    onTriageCompleted: vi.fn(),
    performDeliberation: vi.fn().mockResolvedValue(null),
    onDeliberationCompleted: vi.fn(),
    getWorkerWorkspace: (workerId: number) => {
      let ws = workspaces.get(workerId);
      if (!ws) {
        ws = createSessionWorkspace(workerId);
        workspaces.set(workerId, ws);
      }
      return ws;
    },
  };

  const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
  controller.setWorkerCount(workerCount);
  controller.setDelegate(delegate);
  controller.start();
  return {
    controller,
    mailbox,
    delegate,
    doneIds,
    activeCount: () => active,
    maxActive: () => maxActive,
  };
}

afterEach(() => {
  // 所有测试都在各自 harness 内 stop，这里兜底。
});

describe('AttentionController 并发 worker 池（方案 A）', () => {
  it('不同实体的两个 item 被不同 worker 并行处理', async () => {
    const h = makeConcurrentHarness(2);

    h.mailbox.enqueue('task_comment', { taskId: 'tsk_A', summary: 'A', content: 'a' });
    h.mailbox.enqueue('task_comment', { taskId: 'tsk_B', summary: 'B', content: 'b' });

    await waitFor(() => h.doneIds.length === 2);
    h.controller.stop();

    expect(h.maxActive()).toBe(2); // 真正同时处理
    expect(h.delegate.processMailboxItem).toHaveBeenCalledTimes(2);
  });

  it('同一实体的两个 item 永不并发（实体亲和锁强制串行）', async () => {
    const h = makeConcurrentHarness(2);

    // 用 a2a_message（不进 task_comment 去重）但携带相同 taskId → 实体锁生效。
    h.mailbox.enqueue('a2a_message', { taskId: 'tsk_SAME', summary: 'first', content: '1' });
    h.mailbox.enqueue('a2a_message', { taskId: 'tsk_SAME', summary: 'second', content: '2' });

    await waitFor(() => h.doneIds.length === 2);
    h.controller.stop();

    expect(h.maxActive()).toBe(1); // 同实体被锁，一次只能处理一个
    expect(h.doneIds).toHaveLength(2);
  });

  it('每个 worker 使用独立的 SessionWorkspace（ALS 上下文隔离）', async () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);
    const workspaces = new Map<number, SessionWorkspace>();
    const seenWorkspaces: Array<{ ws: SessionWorkspace | undefined; workerId: number }> = [];

    const delegate: AttentionDelegate = {
      processMailboxItem: vi.fn(async (item: MailboxItem) => {
        const ws = sessionWorkspaceStore.getStore();
        seenWorkspaces.push({ ws, workerId: ws?.workerId ?? -1 });
        await sleep(30);
        return 'ok';
      }),
      onDecisionMade: vi.fn(),
      onFocusChanged: vi.fn(),
      evaluateInterrupt: vi.fn().mockResolvedValue('continue'),
      getWorkerWorkspace: (workerId: number) => {
        let ws = workspaces.get(workerId);
        if (!ws) {
          ws = createSessionWorkspace(workerId);
          workspaces.set(workerId, ws);
        }
        return ws;
      },
    };

    const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
    controller.setWorkerCount(2);
    controller.setDelegate(delegate);
    controller.start();

    mailbox.enqueue('task_comment', { taskId: 'tsk_W1', summary: 'w1', content: '1' });
    mailbox.enqueue('task_comment', { taskId: 'tsk_W2', summary: 'w2', content: '2' });
    await waitFor(() => seenWorkspaces.length === 2);
    controller.stop();

    // 每个处理链路的 ALS workspace 都必须来自 getWorkerWorkspace 映射，且两个 worker 不同。
    const workerIds = [...workspaces.keys()].sort();
    expect(workerIds).toEqual([1, 2]);
    for (const seen of seenWorkspaces) {
      expect(seen.ws).toBe(workspaces.get(seen.workerId));
      expect(seen.workerId).toBeGreaterThanOrEqual(1);
    }
    expect(new Set(seenWorkspaces.map(s => s.workerId)).size).toBe(2);
  });

  it('方案 A：忙碌 worker 不被新邮件打断，空闲 worker 接手', async () => {
    const h = makeConcurrentHarness(2);

    // 先让 worker 1 忙于处理一个长任务
    h.mailbox.enqueue('task_comment', { taskId: 'tsk_busy', summary: 'busy', content: 'long' });
    await waitFor(() => h.activeCount() === 1);

    // 忙碌期间来高优先级用户消息 → 不打断，也不经过 evaluateInterrupt
    h.mailbox.enqueue('human_chat', { summary: 'user', content: 'hi' }, { priority: 0 as MailboxPriority });
    await sleep(100);
    // 忙碌 worker 仍在处理原 item（processMailboxItem 只被调用一次，且 evaluateInterrupt 未被调用）
    expect(h.delegate.evaluateInterrupt).not.toHaveBeenCalled();
    expect(h.maxActive()).toBeLessThanOrEqual(2); // 允许第二个 worker 并行取走 human_chat

    // 两个 item 最终都被处理
    await waitFor(() => h.doneIds.length === 2);
    h.controller.stop();
    expect(h.doneIds).toHaveLength(2);
  });

  it('stop 后所有 worker 退出，不再消费', async () => {
    const h = makeConcurrentHarness(2);
    h.controller.stop();
    await sleep(50);

    expect(h.controller.getWorkerCount()).toBe(2);
    h.mailbox.enqueue('task_comment', { taskId: 'tsk_after', summary: 'x', content: '1' });
    await sleep(150);

    // stop 后无 worker 处理 → 队列仍保留 item
    expect(h.mailbox.depth).toBe(1);
    expect(h.delegate.processMailboxItem).not.toHaveBeenCalled();
  });

  it('运行时 setWorkerCount 重启 worker 池不丢已排队 item', async () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);
    const doneIds: string[] = [];
    const delegate: AttentionDelegate = {
      processMailboxItem: vi.fn(async (item: MailboxItem) => {
        await sleep(30);
        doneIds.push(item.id);
        return 'ok';
      }),
      onDecisionMade: vi.fn(),
      onFocusChanged: vi.fn(),
      evaluateInterrupt: vi.fn().mockResolvedValue('continue'),
    };
    const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
    controller.setDelegate(delegate);
    controller.start();

    // 串行 → 并发切换（运行中）
    controller.setWorkerCount(3);
    mailbox.enqueue('task_comment', { taskId: 'tsk_1', summary: '1', content: '1' });
    mailbox.enqueue('task_comment', { taskId: 'tsk_2', summary: '2', content: '2' });
    await waitFor(() => doneIds.length === 2);
    controller.stop();

    expect(doneIds).toHaveLength(2);
    expect(mailbox.depth).toBe(0);
  });

  it('P2-B：处理抛错后实体锁释放，同实体后续 item 仍可继续（防锁泄漏）', async () => {
    const eventBus = new EventBus();
    const mailbox = new AgentMailbox(AGENT_ID, eventBus);
    const doneIds: string[] = [];
    let failOnce = true;
    const delegate: AttentionDelegate = {
      processMailboxItem: vi.fn(async (item: MailboxItem) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('simulated processing failure');
        }
        await sleep(20);
        doneIds.push(item.id);
        return 'ok';
      }),
      onDecisionMade: vi.fn(),
      onFocusChanged: vi.fn(),
      evaluateInterrupt: vi.fn().mockResolvedValue('continue'),
    };
    const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
    controller.setDelegate(delegate);
    controller.start();

    // 同一实体的两个 item：第一个处理失败（抛错），第二个必须等锁释放后仍被处理
    mailbox.enqueue('a2a_message', { taskId: 'tsk_FAIL', summary: 'first', content: 'boom' });
    mailbox.enqueue('a2a_message', { taskId: 'tsk_FAIL', summary: 'second', content: 'ok' });
    await waitFor(() => doneIds.length === 1);
    controller.stop();

    // 失败 item 会被 requeue 或完成，但锁绝不该泄漏——第二个 item 最终被处理
    expect(doneIds).toHaveLength(1);
    expect(mailbox.isEntityLocked('tsk_FAIL')).toBe(false); // 锁已释放
  });
});