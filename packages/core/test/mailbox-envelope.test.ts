/**
 * 第六刀 C2 —— 信封在**唯一装配点**（`AgentMailbox.enqueue`）长出来。
 *
 * 这里的断言回答 V3/I4/V5 三个会咬人的问题：
 *  - 三条链路（chat / task / a2a）入队后 `envelope` 必非空，且 `from/to/messageId` 齐全；
 *  - 同一 `messageId` 连投两次 → 恰一条 queued + 一条 `duplicate_message_id` 退信行；
 *  - 旧行（C2 之前落库、无信封）重水化后语义不变（否则真实任务会卡死）。
 */
import { describe, it, expect } from 'vitest';
import { isStrictStateItem, type MailboxItem } from '@markus/shared';
import { AgentMailbox, rehydrateStructuredFields, type MailboxPersistence } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { imAddressRef, agentAddressRef } from '@markus/shared';

class FakeStore implements MailboxPersistence {
  queued: MailboxItem[] = [];
  bounced: Array<{ id: string; dropReason: string; envelopeId?: string }> = [];

  save(item: MailboxItem): boolean {
    if (this.queued.some(i => i.id === item.id)) return false;
    const dup = item.envelope
      ? this.queued.find(i => i.envelope?.messageId === item.envelope!.messageId)
      : undefined;
    if (dup) return false;
    this.queued.push(item);
    return true;
  }

  updateStatus(): void {}

  findByMessageId(_agentId: string, messageId: string) {
    const hit = this.queued.find(i => i.envelope?.messageId === messageId);
    return hit
      ? { id: hit.id, status: hit.status, claimedBy: null, leaseUntil: null, queuedAt: hit.queuedAt }
      : undefined;
  }

  saveBounced(item: MailboxItem, dropReason: string): void {
    this.bounced.push({ id: item.id, dropReason, envelopeId: item.envelope?.messageId });
  }
}

function mailbox() {
  const store = new FakeStore();
  const box = new AgentMailbox('agt_a', new EventBus(), store);
  return { box, store };
}

describe('信封装配点 — 三条链路都有信封（I4 / V3）', () => {
  it('chat：IM 入站交出 from/messageId，to 由 mailbox 自己知道', () => {
    const { box } = mailbox();
    const item = box.enqueue('human_chat', { summary: 'hi', content: 'hello' }, {
      origin: { from: imAddressRef('feishu', 'u1'), messageId: 'native-1' },
    });
    expect(item.envelope).toBeTruthy();
    expect(item.envelope!.from).toEqual({ kind: 'im', platform: 'feishu', nativeUserId: 'u1' });
    expect(item.envelope!.to).toEqual({ kind: 'agent', agentId: 'agt_a' });
    expect(item.envelope!.messageId).toBe('native-1');
    expect(item.envelope!.signalClass).toBe('chat');
  });

  it('task：intent=trigger_execution 同时驱动信封与权威态', () => {
    const { box } = mailbox();
    const item = box.enqueue('task_status_update', { summary: 'Task: x', content: 'do it', taskId: 'tsk_1' }, {
      intent: 'trigger_execution',
      metadata: { taskId: 'tsk_1' },
    });
    expect(item.envelope!.intent).toBe('trigger_execution');
    expect(item.envelope!.signalClass).toBe('record');
    expect(isStrictStateItem(item)).toBe(true);
    // 未给 origin → 平台自身发出的信号（不是伪造一个 agent 身份）
    expect(item.envelope!.from).toEqual({ kind: 'platform', address: 'noreply@markus.global', local: 'noreply' });
  });

  it('a2a：投递点给出 from，messageId 缺省用 item id（永不自撞）', () => {
    const { box } = mailbox();
    const item = box.enqueue('a2a_message', { summary: 'msg', content: 'peer said hi' }, {
      origin: { from: agentAddressRef('agt_b'), externalThreadRef: 'chain-1' },
    });
    expect(item.envelope!.from).toEqual({ kind: 'agent', agentId: 'agt_b' });
    expect(item.envelope!.messageId).toBe(item.id);
    expect(item.envelope!.externalThreadRef).toBe('chain-1');
    expect(item.envelope!.signalClass).toBe('a2a');
  });

  it('信封保持不变的结构：预留槽位恒 null（auth / replyTo / workUnitRef）', () => {
    const { box } = mailbox();
    const item = box.enqueue('heartbeat', { summary: 'hb', content: 'tick' });
    expect(item.envelope!.auth).toBeNull();
    expect(item.envelope!.replyTo).toBeNull();
    expect(item.envelope!.workUnitRef).toBeNull();
  });
});

describe('V5 — 同一 messageId 连投两次', () => {
  it('恰一条 queued + 一条 duplicate_message_id 退信行', () => {
    const { box, store } = mailbox();
    const first = box.enqueue('human_chat', { summary: 'hi', content: 'one' }, {
      origin: { from: imAddressRef('feishu', 'u1'), messageId: 'native-7' },
    });
    const second = box.enqueue('human_chat', { summary: 'hi', content: 'one (retry)' }, {
      origin: { from: imAddressRef('feishu', 'u1'), messageId: 'native-7' },
    });

    expect(store.queued.length).toBe(1);
    expect(store.queued[0]!.id).toBe(first.id);
    expect(store.bounced.length).toBe(1);
    expect(store.bounced[0]!.dropReason).toBe('duplicate_message_id');
    expect(second.status).toBe('bounced');
    expect(second.dropReason).toBe('duplicate_message_id');
  });

  it('不同 messageId 各落一行（幂等只针对同一条消息）', () => {
    const { box, store } = mailbox();
    box.enqueue('human_chat', { summary: 'hi', content: 'one' }, {
      origin: { from: imAddressRef('feishu', 'u1'), messageId: 'native-8a' },
    });
    box.enqueue('human_chat', { summary: 'hi', content: 'two' }, {
      origin: { from: imAddressRef('feishu', 'u1'), messageId: 'native-8b' },
    });
    expect(store.queued.length).toBe(2);
    expect(store.bounced.length).toBe(0);
  });
});

describe('旧行重水化（无信封 → 语义不变，只解一次）', () => {
  it('旧任务执行行：extra.triggerExecution 解码成 intent，重水化后仍是权威态', () => {
    const rehydrated = rehydrateStructuredFields({
      id: 'mbx_old',
      agentId: 'agt_a',
      sourceType: 'task_status_update',
      envelope: null,
      payload: { summary: 'Task: old', content: 'legacy', taskId: 'tsk_old', extra: { triggerExecution: true } },
      metadata: { taskId: 'tsk_old' },
    });
    expect(rehydrated.envelope?.intent).toBe('trigger_execution');
    expect(rehydrated.envelope?.messageId).toBe('mbx_old');
    expect(isStrictStateItem({ sourceType: 'task_status_update', payload: { summary: '', content: '' }, envelope: rehydrated.envelope })).toBe(true);
  });

  it('旧评审轮次行：extra.round 解码成结构 round（幂等键值不变）', () => {
    const rehydrated = rehydrateStructuredFields({
      id: 'mbx_rev',
      agentId: 'agt_a',
      sourceType: 'review_request',
      envelope: null,
      payload: { summary: 'review', content: 'please review', taskId: 'tsk_1', extra: { round: 2 } },
      metadata: {},
    });
    expect(rehydrated.round).toBe(2);
  });

  it('已有信封的行直接用存下来的信封（不再从载荷猜）', () => {
    const stored = JSON.stringify({
      from: { kind: 'agent', agentId: 'agt_b' },
      to: { kind: 'agent', agentId: 'agt_a' },
      subject: 's', messageId: 'native-x', intent: 'deliver', signalClass: 'a2a',
      auth: null, replyTo: null, workUnitRef: null, externalThreadRef: null, fromVerified: false,
    });
    const rehydrated = rehydrateStructuredFields({
      id: 'mbx_new', agentId: 'agt_a', sourceType: 'a2a_message', envelope: stored,
      payload: { summary: 's', content: 'c', extra: { triggerExecution: true, round: 9 } },
      metadata: {},
    });
    expect(rehydrated.envelope?.messageId).toBe('native-x');
    expect(rehydrated.envelope?.intent).toBe('deliver'); // 载荷再喊也不算
  });
});
