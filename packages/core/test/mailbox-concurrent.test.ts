import { describe, it, expect } from 'vitest';
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