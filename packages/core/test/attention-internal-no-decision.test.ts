/**
 * C10-0B §3.3 / §4-2/§4-3 —— 平台内部唤醒信号不产生决策行；非内部事实必须有身份。
 *
 * 根因（R1 的第三个缺口）：`PLATFORM_INTERNAL_SOURCES`（heartbeat / system_event /
 * session_reply / memory_consolidation / callback_result / workflow_update）本质没有实体，
 * 它们带 NULL ref 是**正确语义**。但唯一决策写者 `AttentionController.recordDecision`
 * 照样把它们写成 `work_unit_ref IS NULL` 的决策行 —— 真机 1093/1106 的 leak 就是这些
 * 平台唤醒信号。台账于是长成一本「谁都没身份」的拒绝簿。
 *
 * 判据：
 *   ① 内部闭集来源被 pick → decisionPersistence.save **不调用**、内存台账为空、
 *     `attention:decision` 事件不发；
 *   ② 非内部来源（human_chat）带 ref 被 pick → 照常落账，且行里的 ref 与邮箱同源；
 *   ③ 非内部来源入队不带 ref 也不表态 → 入队守卫**拒绝**（fail closed，不是静默 NULL）。
 *
 * 基线上 ① 立刻红：base 会为 system_event 写一条 null-ref 决策行。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AttentionController, type AttentionDelegate, type AttentionDecision } from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { WORK_UNIT_REF, type MailboxItem } from '@markus/shared';

const AGENT_ID = 'agt_c10_0b_internal';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 4000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(stepMs);
  }
}

/** 每个 controller 都要 stop：否则 dequeueAsync 永挂，整个 vitest worker 变慢/超时。 */
const started: AttentionController[] = [];
afterEach(() => {
  while (started.length) {
    try { started.pop()!.stop(); } catch { /* already stopped */ }
  }
});

function makeHarness() {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus);
  const saved: AttentionDecision[] = [];
  const events: AttentionDecision[] = [];
  const handled: string[] = [];

  eventBus.on('attention:decision', (ctx) => {
    const payload = ctx as unknown as { decision?: AttentionDecision };
    if (payload.decision) events.push(payload.decision);
  });

  const delegate: AttentionDelegate = {
    processMailboxItem: vi.fn(async (item: MailboxItem) => {
      handled.push(item.id);
      await sleep(5);
      return 'done';
    }),
    onDecisionMade: vi.fn(),
    onFocusChanged: vi.fn(),
    evaluateInterrupt: vi.fn().mockResolvedValue('continue'),
    onTriageCompleted: vi.fn(),
    onDeliberationCompleted: vi.fn(),
  };

  const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
  controller.setDecisionPersistence({ save: (d) => { saved.push(d); } });
  controller.setDelegate(delegate);
  controller.start();
  started.push(controller);
  return { controller, mailbox, saved, events, handled };
}

describe('C10-0B §3.3：内部闭集来源不产生决策行（唯一写者处拒绝）', () => {
  it('system_event 被 pick → 不落账、台账为空、不发事件，但处理照常发生', async () => {
    const h = makeHarness();
    const item = h.mailbox.enqueue('system_event', { summary: 'wake', content: 'wake' } as never);

    await waitFor(() => h.handled.includes(item.id));

    expect(h.saved, '平台唤醒信号不是「关于工作的决策」→ 不得落账').toHaveLength(0);
    expect(h.controller.getRecentDecisions(50), '内存台账也不得留行').toHaveLength(0);
    expect(h.events.filter(e => e.mailboxItemId === item.id), '也不得广播决策事件').toHaveLength(0);
  });

  it('非内部来源（human_chat）带 ref → 照常落账，且 ref 与邮箱行同源', async () => {
    const h = makeHarness();
    const ref = WORK_UNIT_REF.chat('cs_c10_0b', 1);
    const item = h.mailbox.enqueue(
      'human_chat',
      { summary: 'hi', content: 'hi' } as never,
      { workUnitRef: ref, refOrigin: 'turn' },
    );

    await waitFor(() => h.handled.includes(item.id));

    const row = h.saved.find(d => d.mailboxItemId === item.id && d.decisionType === 'pick');
    expect(row, '非内部事实必须留一条 pick').toBeDefined();
    expect(row!.workUnitRef).toBe(ref);
  });
});

describe('C10-0B §4-3：非内部事实缺身份 → 入队即拒绝（守卫保持 fail closed）', () => {
  it('既无 ref 又无声明 → 抛错，且提示指向唯一构造器', () => {
    const previous = process.env['MARKUS_LENIENT_IDENTITY'];
    delete process.env['MARKUS_LENIENT_IDENTITY'];
    try {
      const mb = new AgentMailbox(AGENT_ID, new EventBus());
      expect(() =>
        mb.enqueue('task_status_update', { summary: 's', content: 'c', taskId: 'tsk_x' } as never, {}),
      ).toThrow(/WORK_UNIT_REF|refOrigin/);
    } finally {
      if (previous !== undefined) process.env['MARKUS_LENIENT_IDENTITY'] = previous;
    }
  });
});