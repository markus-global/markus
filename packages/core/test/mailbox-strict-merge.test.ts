/**
 * P1-2 回归：strict 状态项绝不被合并吞掉。
 *
 * 审计 P1-2：4 类严格状态项里，旧实现只在合并/清理路径上检查 `triggerExecution`
 * （仅覆盖 1 类），于是 `review_request` / `requirement_update[actionRequired]` /
 * `workflow_update[actionRequired]` 会被同实体的 informational item 合并吞掉 →
 * 评审 / 需求动作**永不执行**。现统一用 `isStrictStateItem` 谓词。
 */
import { describe, it, expect } from 'vitest';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import { isStrictStateItem } from '@markus/shared';

describe('P1-2 · isStrictStateItem 谓词覆盖 4 类严格状态项', () => {
  it('4 类判真，informational 判假', () => {
    expect(isStrictStateItem({ sourceType: 'task_status_update', payload: { summary: '', content: '', extra: { triggerExecution: true } } })).toBe(true);
    expect(isStrictStateItem({ sourceType: 'review_request', payload: { summary: '', content: '' } })).toBe(true);
    expect(isStrictStateItem({ sourceType: 'requirement_update', payload: { summary: '', content: '', extra: { actionRequired: true } } })).toBe(true);
    expect(isStrictStateItem({ sourceType: 'workflow_update', payload: { summary: '', content: '', extra: { actionRequired: true } } })).toBe(true);
    // 非 strict
    expect(isStrictStateItem({ sourceType: 'task_status_update', payload: { summary: '', content: '' } })).toBe(false);
    expect(isStrictStateItem({ sourceType: 'requirement_update', payload: { summary: '', content: '' } })).toBe(false);
  });
});

describe('P1-2 · consolidateByEntity 不吞掉严格状态项', () => {
  it('review_request 与同 task 的 informational 共存 → 两者都保留', () => {
    const mb = new AgentMailbox('agt_t', new EventBus());
    mb.enqueue('task_status_update', { summary: 'status', content: 'informational', taskId: 'tsk_1' });
    mb.enqueue('review_request', { summary: 'review', content: 'please review', taskId: 'tsk_1' });
    expect(mb.getQueuedItems()).toHaveLength(2);

    const removed = mb.consolidateByEntity();

    expect(removed).toBe(0);
    const items = mb.getQueuedItems();
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.sourceType === 'review_request')).toBe(true);
  });

  it('requirement_update[actionRequired] 与同名 informational 共存 → 两者都保留', () => {
    const mb = new AgentMailbox('agt_t', new EventBus());
    mb.enqueue('requirement_update', { summary: 'req info', content: 'informational', requirementId: 'req_1' });
    mb.enqueue('requirement_update', { summary: 'req action', content: 'do it', requirementId: 'req_1', extra: { actionRequired: true } });
    expect(mb.getQueuedItems()).toHaveLength(2);

    const removed = mb.consolidateByEntity();

    expect(removed).toBe(0);
    const items = mb.getQueuedItems();
    expect(items).toHaveLength(2);
    expect(items.filter((i) => i.sourceType === 'requirement_update')).toHaveLength(2);
  });

  it('对照组：纯 informational 同 task 仍会被合并（新规则没有过度禁用合并）', () => {
    const mb = new AgentMailbox('agt_t', new EventBus());
    mb.enqueue('task_status_update', { summary: 'a', content: 'one', taskId: 'tsk_2' });
    mb.enqueue('task_status_update', { summary: 'b', content: 'two', taskId: 'tsk_2' });

    const removed = mb.consolidateByEntity();

    expect(removed).toBe(1);
    expect(mb.getQueuedItems()).toHaveLength(1);
  });
});
