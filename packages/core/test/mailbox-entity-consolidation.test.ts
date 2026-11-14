/**
 * C8-A —— A2A 的**合并**按「这件事」而不是按「这次从哪个频道到的」。
 *
 * 为什么这两条断言必须存在：C8-A 的根因是「这件事是谁」有两个写者，投递通道
 * （`channelKey`）是其中一个。实体键收敛之后，若合并仍按 channelKey，症状会
 * 以另一种形态回来：
 *   · 同一件事经 DM 与群聊到达 → agent 读两遍、两套上下文（这次不是两个会话，
 *     而是两条散件）；
 *   · 同一频道里两件不同的事 → 被并成一条，**第二件事的执行理由消失**。
 * 所以合并键与实体键必须同源：有 WorkUnit 用 `work_unit_ref`，旧行才退到 channelKey。
 *
 * 刻意分成两处（enqueue 阶段合并 / 预合并 `consolidateByEntity`）：它们是两条
 * 独立代码路径，一个测试同时被两层满足，就等于两层都没有护栏。
 */
import { describe, it, expect } from 'vitest';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';

const a2a = (channelKey: string, content: string) => ({
  summary: content,
  content,
  extra: { channelKey, senderId: 'agt_a', senderName: 'A' },
});

describe('C8-A · 预合并（consolidateByEntity）按实体', () => {
  it('同一件事经两个频道到达 → 并成一条', () => {
    const mb = new AgentMailbox('agt_t', new EventBus());
    const first = mb.enqueue('a2a_message', a2a('dm:a2a:a:b', 'first'), {
      workUnitRef: 'a2a:task:tsk_1',
    });
    // 先把它取下队列，让第二条**无法**走 enqueue 阶段的合并 ——
    // 这样这个断言只可能由 `consolidateByEntity` 的合并键满足。
    const taken = mb.dequeue();
    expect(taken?.id).toBe(first.id);
    mb.enqueue('a2a_message', a2a('group:g1', 'second'), { workUnitRef: 'a2a:task:tsk_1' });
    expect(mb.getQueuedItems()).toHaveLength(1);
    mb.putBack(taken!);
    expect(mb.getQueuedItems()).toHaveLength(2);

    mb.consolidateByEntity();

    const items = mb.getQueuedItems();
    expect(items).toHaveLength(1);
    expect(items[0].payload.content).toContain('first');
    expect(items[0].payload.content).toContain('second');
  });
});

describe('C8-A · enqueue 阶段合并按实体', () => {
  it('同一频道里两件不同的事 → 两条（第二件事的执行理由不能被并掉）', () => {
    const mb = new AgentMailbox('agt_t', new EventBus());
    mb.enqueue('a2a_message', a2a('dm:a2a:a:b', 'about task 1'), {
      workUnitRef: 'a2a:task:tsk_1',
    });
    mb.enqueue('a2a_message', a2a('dm:a2a:a:b', 'about task 2'), {
      workUnitRef: 'a2a:task:tsk_2',
    });

    expect(mb.getQueuedItems()).toHaveLength(2);

    // 预合并也不得把它们并起来（它的键同样是实体）。
    mb.consolidateByEntity();
    expect(mb.getQueuedItems()).toHaveLength(2);
  });

  it('旧行（无 WorkUnit）仍按频道合并 —— 迁移期行为不变', () => {
    const mb = new AgentMailbox('agt_t', new EventBus());
    mb.enqueue('a2a_message', a2a('dm:a2a:a:b', 'first'));
    mb.enqueue('a2a_message', a2a('dm:a2a:a:b', 'second'));

    const items = mb.getQueuedItems();
    expect(items).toHaveLength(1);
    expect(items[0].workUnitRef ?? null).toBeNull();
  });
});
