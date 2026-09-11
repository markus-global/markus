import { describe, it, expect } from 'vitest';
import { MAILBOX_TYPE_REGISTRY, resolveEntityKey, type MailboxItemType } from '@markus/shared';
import { AgentMailbox, MailboxCancelledError } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';

const AGENT_ID = 'mailbox-concurrent-agent';

function makeMailbox() {
  const eventBus = new EventBus();
  const mailbox = new AgentMailbox(AGENT_ID, eventBus);
  return { mailbox, eventBus };
}

describe('AgentMailbox multi-consumer (concurrency foundation)', () => {
  it('two concurrent dequeueAsync consumers each get a distinct item', async () => {
    const { mailbox } = makeMailbox();

    const first = mailbox.dequeueAsync();
    const second = mailbox.dequeueAsync();
    // Let both workers arm their idle waiters before enqueueing.
    await new Promise(r => setTimeout(r, 10));

    mailbox.enqueue('a2a_message', { summary: 'A', content: 'a' });
    mailbox.enqueue('a2a_message', { summary: 'B', content: 'b' });

    const [a, b] = await Promise.all([first, second]);
    const ids = [a.id, b.id].sort();
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2); // never the same item twice
  });

  it('broadcast wake: single enqueue wakes N waiters, excess waiters keep waiting', async () => {
    const { mailbox } = makeMailbox();

    const w1 = mailbox.dequeueAsync();
    const w2 = mailbox.dequeueAsync();
    await new Promise(r => setTimeout(r, 10));

    mailbox.enqueue('a2a_message', { summary: 'only-one', content: 'x' });

    const got = await w1; // one consumer wins the item
    expect(got.payload.summary).toBe('only-one');

    // The second waiter survives the spurious wake and keeps waiting.
    mailbox.enqueue('a2a_message', { summary: 'later', content: 'y' });
    const got2 = await w2;
    expect(got2.payload.summary).toBe('later');
  });

  it('cancelWait wakes every waiter', async () => {
    const { mailbox } = makeMailbox();

    const w1 = mailbox.dequeueAsync().catch(e => e);
    const w2 = mailbox.dequeueAsync().catch(e => e);
    await new Promise(r => setTimeout(r, 10));

    mailbox.cancelWait();
    const r1 = await w1;
    const r2 = await w2;
    expect(r1).toBeInstanceOf(MailboxCancelledError);
    expect(r2).toBeInstanceOf(MailboxCancelledError);
  });
});

describe('AgentMailbox entity affinity lock', () => {
  it('dequeue skips items whose entity is locked', () => {
    const { mailbox } = makeMailbox();

    const a1 = mailbox.enqueue('task_comment', { taskId: 'tsk_1', summary: 't1', content: 'c1' });
    const b1 = mailbox.enqueue('task_comment', { taskId: 'tsk_2', summary: 't2', content: 'c2' });

    expect(mailbox.lockEntity('task:tsk_1', a1.id)).toBe(true);

    // Head item (tsk_1) is locked → dequeue returns the next runnable item.
    const got = mailbox.dequeue();
    expect(got?.id).toBe(b1.id);

    // tsk_1 is still there, blocked.
    expect(mailbox.depth).toBe(1);

    mailbox.unlockEntity('task:tsk_1', a1.id);
    expect(mailbox.dequeue()?.id).toBe(a1.id);
  });

  it('lockEntity is exclusive; unlock only by same holder', () => {
    const { mailbox } = makeMailbox();
    const item = mailbox.enqueue('task_comment', { taskId: 'tsk_9', summary: 't', content: 'c' });

    expect(mailbox.lockEntity('task:tsk_9', item.id)).toBe(true);
    expect(mailbox.lockEntity('task:tsk_9', 'other-holder')).toBe(false);
    expect(mailbox.isEntityLocked('task:tsk_9')).toBe(true);

    mailbox.unlockEntity('task:tsk_9', 'wrong-holder');
    expect(mailbox.isEntityLocked('task:tsk_9')).toBe(true);

    mailbox.unlockEntity('task:tsk_9', item.id);
    expect(mailbox.isEntityLocked('task:tsk_9')).toBe(false);
  });

  it('unlock wakes a worker blocked by the entity lock', async () => {
    const { mailbox } = makeMailbox();

    // Lock entity first, then enqueue its only item.
    const blocker = mailbox.enqueue('task_comment', { taskId: 'tsk_5', summary: 'b', content: 'b' });
    mailbox.lockEntity('task:tsk_5', blocker.id);

    const waiter = mailbox.dequeueAsync();
    await new Promise(r => setTimeout(r, 10));
    expect(mailbox.depth).toBe(1); // waiter got no item (entity locked)

    mailbox.enqueue('a2a_message', { taskId: 'tsk_5', summary: 'second', content: 's' });
    await new Promise(r => setTimeout(r, 10));
    // Even after enqueue, the entity is still locked → no wake for blocked item.
    expect(mailbox.depth).toBe(2);

    mailbox.unlockEntity('task:tsk_5', blocker.id);
    const got = await waiter;
    // Same-priority queue is LIFO — the most recent message is processed first.
    expect(got.payload.summary).toBe('second');
  });

  it('unrelated entities stay concurrent (lock only blocks its own entity)', () => {
    const { mailbox } = makeMailbox();

    const a1 = mailbox.enqueue('task_comment', { taskId: 'tsk_α', summary: 'a', content: 'a' });
    const b1 = mailbox.enqueue('task_comment', { taskId: 'tsk_β', summary: 'b', content: 'b' });

    mailbox.lockEntity('task:tsk_α', a1.id);
    expect(mailbox.dequeue()?.payload.summary).toBe('b'); // β unaffected
  });
});

describe('AgentMailbox entity scopes (registry-driven, no silent gaps)', () => {
  const { mailbox } = makeMailbox();

  it('每个 item 类型都解析出实体键 —— 永不为 undefined（未知 ≠ 无限并发）', () => {
    for (const type of Object.keys(MAILBOX_TYPE_REGISTRY) as MailboxItemType[]) {
      const item = mailbox.enqueue(type, { summary: 's', content: 'c' });
      const key = mailbox.entityKeyOf(item);
      expect(key, `${type} 未解析出实体键`).toBeTruthy();
      expect(typeof key).toBe('string');
    }
  });

  it('无具体实体的 item 退化为 system:{agentId}（同 Agent 内串行）', () => {
    const hb = mailbox.enqueue('heartbeat', { summary: 'h', content: 'h' });
    const hb2 = mailbox.enqueue('heartbeat', { summary: 'h2', content: 'h2' });
    const a2a = mailbox.enqueue('a2a_message', { summary: 'm', content: 'm' });

    expect(mailbox.entityKeyOf(hb)).toBe(`system:${AGENT_ID}`);
    expect(mailbox.entityKeyOf(hb2)).toBe(`system:${AGENT_ID}`);
    expect(mailbox.entityKeyOf(a2a)).toBe(`system:${AGENT_ID}`);
  });

  it('两个 heartbeat 不会并发处理（原实现的盲区）', () => {
    const h1 = mailbox.enqueue('heartbeat', { summary: 'h1', content: 'h1' });
    const h2 = mailbox.enqueue('heartbeat', { summary: 'h2', content: 'h2' });

    expect(mailbox.lockEntity(mailbox.entityKeyOf(h1), h1.id)).toBe(true);
    // 第二个 heartbeat 想锁同一实体 → 失败（必须排队）
    expect(mailbox.lockEntity(mailbox.entityKeyOf(h2), h2.id)).toBe(false);
    // dequeue 跳过被锁的 heartbeat
    expect(mailbox.dequeue()).toBeUndefined();
  });

  it('同一 A2A 频道串行、不同频道可并行', () => {
    const m1 = mailbox.enqueue('a2a_message', {
      summary: 'dm1', content: 'x', extra: { channelKey: 'dm:a2a:agt_a|agt_b' },
    });
    const m2 = mailbox.enqueue('a2a_message', {
      summary: 'dm2', content: 'y', extra: { channelKey: 'dm:a2a:agt_a|agt_b' },
    });
    const m3 = mailbox.enqueue('a2a_message', {
      summary: 'dm3', content: 'z', extra: { channelKey: 'group:team_1' },
    });

    const k1 = mailbox.entityKeyOf(m1);
    expect(k1).toBe('channel:dm:a2a:agt_a|agt_b');
    expect(mailbox.entityKeyOf(m2)).toBe(k1);
    expect(mailbox.entityKeyOf(m3)).toBe('channel:group:team_1');

    expect(mailbox.lockEntity(k1, m1.id)).toBe(true);
    // 同频道被锁 → m2 被跳过；不同频道 m3 照常出队
    expect(mailbox.dequeue()?.id).toBe(m3.id);
  });

  it('human_chat 以「发起人」为优先实体（同用户消息串行，符合设计意图）', () => {
    const c1 = mailbox.enqueue('human_chat', { summary: 'a', content: 'a' }, { metadata: { senderId: 'user_1', sessionId: 'sess_A' } });
    const c2 = mailbox.enqueue('human_chat', { summary: 'b', content: 'b' }, { metadata: { senderId: 'user_1', sessionId: 'sess_B' } });
    const c3 = mailbox.enqueue('human_chat', { summary: 'c', content: 'c' }, { metadata: { senderId: 'user_2', sessionId: 'sess_A' } });

    expect(mailbox.entityKeyOf(c1)).toBe('user:user_1');
    expect(mailbox.entityKeyOf(c2)).toBe('user:user_1'); // 同用户不同会话 → 仍串行
    expect(mailbox.entityKeyOf(c3)).toBe('user:user_2');

    expect(mailbox.lockEntity('user:user_1', c1.id)).toBe(true);
    expect(mailbox.dequeue()?.id).toBe(c3.id); // 别的用户不受影响
  });

  it('human_chat 无 senderId 时回落到会话键', () => {
    const c = mailbox.enqueue('human_chat', { summary: 'a', content: 'a' }, { metadata: { sessionId: 'sess_Z' } });
    expect(mailbox.entityKeyOf(c)).toBe('conv:sess_Z');
  });

  it('多实体维度：同时锁 user + conv（任一维度冲突都串行）', () => {
    // 独立 mailbox：上面的用例会留下未释放的锁
    const { mailbox } = makeMailbox();
    const c1 = mailbox.enqueue('human_chat', { summary: 'a', content: 'a' }, { metadata: { senderId: 'user_1', sessionId: 'sess_A' } });
    const c2 = mailbox.enqueue('human_chat', { summary: 'b', content: 'b' }, { metadata: { senderId: 'user_1', sessionId: 'sess_B' } }); // 同用户
    const c3 = mailbox.enqueue('human_chat', { summary: 'c', content: 'c' }, { metadata: { senderId: 'user_2', sessionId: 'sess_A' } }); // 同会话
    const c4 = mailbox.enqueue('human_chat', { summary: 'd', content: 'd' }, { metadata: { senderId: 'user_3', sessionId: 'sess_C' } }); // 无关

    expect(mailbox.entityKeysOf(c1).sort()).toEqual(['conv:sess_A', 'user:user_1']);

    expect(mailbox.lockEntities(mailbox.entityKeysOf(c1), c1.id)).toBe(true);
    // 同用户（不同会话）→ 被 user: 维度挡住
    expect(mailbox.isItemEntityLocked(c2)).toBe(true);
    // 同会话（不同用户）→ 被 conv: 维度挡住
    expect(mailbox.isItemEntityLocked(c3)).toBe(true);
    // 互不相关 → 可处理
    expect(mailbox.isItemEntityLocked(c4)).toBe(false);
    expect(mailbox.dequeue()?.id).toBe(c4.id);

    // 释放后两个维度都解锁
    mailbox.unlockEntities(mailbox.entityKeysOf(c1), c1.id);
    expect(mailbox.isEntityLocked('user:user_1')).toBe(false);
    expect(mailbox.isEntityLocked('conv:sess_A')).toBe(false);
  });

  it('lockEntities 全有或全无：部分冲突时不残留半锁', () => {
    const { mailbox } = makeMailbox();
    const a = mailbox.enqueue('human_chat', { summary: 'a', content: 'a' }, { metadata: { senderId: 'user_X', sessionId: 'sess_1' } });
    // 先占住其中一个维度
    mailbox.lockEntity('conv:sess_1', 'other-holder');

    expect(mailbox.lockEntities(mailbox.entityKeysOf(a), a.id)).toBe(false);
    // 未被占用的那个维度不能被"顺带"锁上（否则等于锁泄漏）
    expect(mailbox.isEntityLocked('user:user_X')).toBe(false);
    expect(mailbox.isEntityLocked('conv:sess_1')).toBe(true);
  });

  it('任务相关 item 仍按任务实体串行（回归保护）', () => {
    const t = mailbox.enqueue('task_status_update', { summary: 't', content: 'c', taskId: 'tsk_77' });
    expect(mailbox.entityKeyOf(t)).toBe('task:tsk_77');
  });
});