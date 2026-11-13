/**
 * 第六刀 C5 —— 退信原因必须按**真实原因**投影（V4「无静默丢弃」的可信度前提）
 *
 * 真实事故（C4 真实实例探针，`markus-cut6-c4-verification-report-2026-11-12.md` §4.4）：
 * 一条 chat 报文把报文体写成 `message` 而不是 `text`，于是 payload 里没有 `content`。
 * agent 侧的读取器 `turnContentOf()` 拒收它（"refusing to build the turn from a
 * display excerpt"），这本是**正确的入参校验**；但该行最终以
 * `drop_reason='stale_signal'` + 事件名 `mailbox.duplicate_delivery_dropped` 收口。
 *
 * 「没有静默丢弃」成立，可是**原因与事件名都在撒谎**：那条信号既不是陈旧信号，
 * 也不是重复投递。台账上一个会说谎的原因，等于没有原因。
 *
 * 三条断言（每一条都能被实现改坏，而不是被重命名糊过去）：
 *  1. 入参校验失败 → `drop_reason='payload_invalid'`（不是换一个更好听的默认值）；
 *  2. 观测事件名与真实原因同名同义 → `mailbox.signal_bounced`，且**不得**再出现
 *     `mailbox.duplicate_delivery_dropped`（后者是「重复投递被拒」专用）；
 *  3. 旧 `stale_signal` 语义**不得被顺手扩大**：主动丢弃的决定仍是 `stale_signal`。
 *
 * 断言口径是**行为**（真实 AttentionController + 真实 `turnContentOf` + 真实信箱），
 * 不是 `readFileSync` + `toContain` 的源码文本栅栏。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger, type MailboxItem, type MailboxItemType, type MailboxPriority, type MailboxPayload } from '@markus/shared';
import { AttentionController, type AttentionDelegate } from '../src/attention.js';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { turnContentOf, SignalPayloadInvalidError } from '../src/mailbox-summary.js';

const AGENT_ID = 'attn-projection-agent';

/** 真实事故的报文形状：`content` 字段**不存在**（API 侧写成了 `message`）。 */
function payloadWithoutContent(): MailboxPayload {
  const payload: MailboxPayload = {
    summary: '误用 message 字段的 chat 报文',
    content: '__never_used__',
  };
  // 用 Reflect 删掉字段：`as never` / `as unknown as` 这类类型逃逸会把「字段缺失」
  // 表达成一句类型谎话，而这正是本卡要证明的运行时事实。
  Reflect.deleteProperty(payload, 'content');
  return payload;
}

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

function makeController(delegateOverrides?: Partial<AttentionDelegate>) {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus);
  const delegate: AttentionDelegate = {
    processMailboxItem: vi.fn().mockResolvedValue('done'),
    onDecisionMade: vi.fn(),
    onFocusChanged: vi.fn(),
    evaluateInterrupt: vi.fn().mockResolvedValue('continue'),
    onTriageCompleted: vi.fn(),
    performDeliberation: vi.fn().mockResolvedValue(null),
    onDeliberationCompleted: vi.fn(),
    ...delegateOverrides,
  };
  const controller = new AttentionController(AGENT_ID, mailbox, eventBus);
  controller.setDelegate(delegate);
  return { controller, mailbox, delegate };
}

/** 按结构化事件名过滤 logger 调用。 */
function eventOf(spy: { mock: { calls: unknown[][] } }, event: string): unknown[][] {
  return spy.mock.calls.filter(
    c => (c[1] as Record<string, unknown> | undefined)?.['event'] === event,
  ) as unknown[][];
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('入参校验失败必须是「有名字的」原因，而不是裸 Error', () => {
  it('turnContentOf 对缺 content 的权威报文抛 SignalPayloadInvalidError', () => {
    const item = makeItem({ sourceType: 'human_chat', payload: payloadWithoutContent() });
    expect(() => turnContentOf(item)).toThrow(SignalPayloadInvalidError);
    // 原因码就是闭集里的那一档：错误对象自带它，调用方不必再猜。
    try {
      turnContentOf(item);
    } catch (err) {
      expect((err as SignalPayloadInvalidError).code).toBe('payload_invalid');
    }
  });

  it('非权威类型仍回退到 summary（不把校验扩大到本来合法的报文）', () => {
    const item = makeItem({
      sourceType: 'task_status_update',
      payload: { summary: 'status changed', content: '' } as MailboxPayload,
    });
    expect(() => turnContentOf(item)).not.toThrow();
    expect(turnContentOf(item)).toBe('status changed');
  });
});

describe('缺字段报文的终态投影（真实事故的形状）', () => {
  it('→ catch_all + drop_reason=payload_invalid，事件名不再冒充重复投递', async () => {
    const warnSpy = vi.spyOn(Logger.prototype, 'warn');
    const { controller, mailbox } = makeController({
      // agent 侧真正的读取器：缺 content 的权威报文在这里被拒收。
      processMailboxItem: vi.fn(async (item: MailboxItem) => turnContentOf(item)),
    });
    controller['running'] = true;
    const item = mailbox.enqueue('human_chat', payloadWithoutContent());

    await controller['processFocusedItem'](item);

    // ① 仍然「没有静默丢弃」：行没消失，进了概览。
    expect(item.status).toBe('catch_all');
    // ② 原因按真实原因投影。
    expect(item.dropReason).toBe('payload_invalid');
    // ③ 概览桶照旧带上（原因 + 桶是同一个写入的两面）。
    expect(item.bounceTarget).toBe(`catchall:${AGENT_ID}`);

    // ④ 事件名与真实原因同名同义。
    const bounced = eventOf(warnSpy, 'mailbox.signal_bounced');
    expect(bounced).toHaveLength(1);
    expect(bounced[0]![1]).toMatchObject({
      dropReason: 'payload_invalid',
      type: 'human_chat',
      count: 1,
    });
    // ⑤ 不得再冒充「重复投递被拒」——那条事件留给真正的重复投递。
    expect(eventOf(warnSpy, 'mailbox.duplicate_delivery_dropped')).toHaveLength(0);
  });

  it('旧 stale_signal 语义不被顺手扩大：主动丢弃的决定仍是 stale_signal', () => {
    const { mailbox } = makeController();
    const item = mailbox.enqueue('task_status_update', { summary: 'd', content: 'd', taskId: 'tsk_x' });

    const out = mailbox.drop(item.id, 'redundant');

    expect(out!.status).toBe('catch_all');
    expect(out!.dropReason).toBe('stale_signal');
  });
});
