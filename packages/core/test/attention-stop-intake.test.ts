import { describe, it, expect, vi } from 'vitest';
import { AttentionController, type AttentionDelegate } from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { createSessionWorkspace, type SessionWorkspace } from '../src/session-workspace.js';
import type { MailboxItem } from '@markus/shared';

/**
 * 「停止」必须是原子的：stop() 之后不得再处理任何 item。
 *
 * 事故现场（2026-11-08 生产日志，Owner 停止 GEO 团队后）：
 *   23:29:22 停止六个 agent
 *   23:29:29 `handleMessage cancel by higher-priority item {scenario:"heartbeat"}`
 *   23:29:35 同上 `{scenario:"a2a"}`
 *   → 停止后 7–13 秒仍有回合在跑，界面上看起来「停了又自己起来了两个」。
 *
 * 根因：并发 worker 在 `await dequeueAsync()` 返回后**只检查 generation，不检查 running**。
 * 停止发生在「已经取到手」和「开始处理」之间时，这一件仍会被完整处理 —— 而串行循环
 * （runLoop）本来就有 `if (!this.running)` 的保护，两个循环的保护不对等。
 *
 * 本测试把那个窗口定死：stop() 发生在 dequeueAsync 返回之前 → item 必须被放回队列、
 * 且 **绝不能** 进入 processMailboxItem。
 */

const AGENT_ID = 'attn-stop-intake-agent';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function makeHarness() {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus);
  const workspaces = new Map<number, SessionWorkspace>();
  const delegate: AttentionDelegate & { processMailboxItem: ReturnType<typeof vi.fn> } = {
    processMailboxItem: vi.fn(async () => 'ok'),
    onDecisionMade: vi.fn(),
    onFocusChanged: vi.fn(),
    evaluateInterrupt: vi.fn().mockResolvedValue('preempt'),
    onTriageCompleted: vi.fn(),
    performDeliberation: vi.fn().mockResolvedValue(null),
    onDeliberationCompleted: vi.fn(),
    getWorkerWorkspace: (workerId: number) => {
      let ws = workspaces.get(workerId);
      if (!ws) { ws = createSessionWorkspace(workerId); workspaces.set(workerId, ws); }
      return ws;
    },
  };
  const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
  // 必须是**并发**路径：workerCount=1 走串行 runLoop（它本来就有 running 保护），
  // 而生产上是 5 个 worker。用 1 测出来的绿是假绿。
  controller.setWorkerCount(3);
  controller.setDelegate(delegate);
  return { controller, mailbox, delegate };
}

describe('stop() 之后不得再处理已取到手的 item', () => {
  it('dequeue 返回时已停止 → 放回队列，且不调用 processMailboxItem', async () => {
    const h = makeHarness();
    const item = h.mailbox.enqueue('task_comment', { taskId: 'tsk_S1', summary: 'S', content: 'x' }) as MailboxItem;

    // 复刻真实竞态：item 已经被取走，但结果还没交回循环 —— 这个窗口里发生 stop()。
    const origDequeue = h.mailbox.dequeueAsync.bind(h.mailbox);
    vi.spyOn(h.mailbox, 'dequeueAsync').mockImplementation(async () => {
      const got = await origDequeue();
      await sleep(60);
      return got;
    });

    h.controller.start();
    await sleep(20);            // 让 worker 进入 dequeueAsync 并取走 item
    h.controller.stop();        // ← 停止发生在 dequeueAsync 返回之前
    await sleep(150);           // 给旧实现足够时间把这一件跑完

    expect(h.delegate.processMailboxItem).not.toHaveBeenCalled();
    // 不丢件：它必须回到队列里，等下次启动再处理。
    expect(h.mailbox.getQueuedItems().map(i => i.id)).toContain(item.id);
  });

  it('停止后新入队的 item 也不会被处理', async () => {
    const h = makeHarness();
    h.controller.start();
    await sleep(20);
    h.controller.stop();

    h.mailbox.enqueue('task_comment', { taskId: 'tsk_S2', summary: 'S', content: 'y' });
    await sleep(80);

    expect(h.delegate.processMailboxItem).not.toHaveBeenCalled();
  });
});
