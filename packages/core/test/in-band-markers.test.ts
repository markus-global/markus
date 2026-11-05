/**
 * in-band 结构标记（P2）的行为契约测试。
 *
 * 被测主张：`payload.extra` 的布尔标记**只能**通过登记表改变行为，且
 * 「未登记」在写侧（投递）与读侧（解释）都被拒绝 —— 不是静默放行、也不是静默忽略。
 *
 * 红→绿说明：本文件 §1 与 §2 在实现前必须是红的
 * （旧实现里 `extra.someNewMarker = true` 会被照常入队、并被当成普通流水账）。
 */

import { describe, it, expect } from 'vitest';
import { AgentMailbox } from '../src/mailbox.js';
import { EventBus } from '../src/events.js';
import {
  isStrictStateItem,
  isTaskExecutionItem,
  UnregisteredInBandMarkerError,
  type MailboxItemType,
  type MailboxPayload,
} from '@markus/shared';

const AGENT_ID = 'in-band-markers-agent';

function makeMailbox() {
  const eventBus = new EventBus();
  return { mailbox: new AgentMailbox(AGENT_ID, eventBus), eventBus };
}

function itemOf(sourceType: MailboxItemType, payload: MailboxPayload) {
  return { sourceType, payload };
}

describe('1 · 写侧：未登记即拒绝（fail-closed 投递）', () => {
  it('一个新造的布尔标记不能悄悄进队 —— 投递被写侧拒绝且队列不变', () => {
    const { mailbox } = makeMailbox();

    let thrown: unknown;
    try {
      mailbox.enqueue('a2a_message', {
        summary: 'peer',
        content: 'hi',
        extra: { silentlySchedulesSomething: true },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown, 'enqueue must reject an unregistered boolean marker').toBeInstanceOf(
      UnregisteredInBandMarkerError,
    );
    // 必须断言**是哪一侧**拒绝的：读侧谓词（isStrictStateItem 等）在 enqueue 内部
    // 也会拦下同一条载荷，所以只断言 message 的话，把写侧 guard 删掉测试仍然绿 ——
    // 那就等于写侧守卫可以被静默删除、无人发现。origin 是这条契约的锚点。
    expect((thrown as UnregisteredInBandMarkerError).origin).toBe('write');

    // fail-closed 的另一半：拒绝之后不得留下半截状态。
    expect(mailbox.depth).toBe(0);
  });

  it('错误可行动：点名登记表、已登记清单，并解释「布尔键才算标记」', () => {
    const { mailbox } = makeMailbox();
    let message = '';
    try {
      mailbox.enqueue('system_event', {
        summary: 's',
        content: 'c',
        extra: { silentlySchedulesSomething: true },
      });
    } catch (err) {
      message = String((err as Error).message);
    }

    expect(message).toContain('packages/shared/src/types/in-band-markers.ts');
    expect(message).toContain('IN_BAND_MARKERS');
    expect(message).toContain('actionRequired');
    expect(message).toContain('silentlySchedulesSomething');
    expect(message).toContain('non-boolean extra keys are data');
  });

  it('已登记的标记照常投递（不得误杀）', () => {
    const { mailbox } = makeMailbox();

    expect(() =>
      mailbox.enqueue('a2a_message', {
        summary: '@mention from peer',
        content: 'hi',
        extra: { directMention: true, waitForReply: false, throttled: true },
      }),
    ).not.toThrow();

    expect(() =>
      mailbox.enqueue(
        'task_status_update',
        {
          summary: 'Task: x',
          content: 'do it',
          taskId: 'tsk_1',
          extra: { triggerExecution: true, executionRound: 1 },
        },
        { priority: 1 },
      ),
    ).not.toThrow();

    expect(mailbox.depth).toBe(2);
  });

  it('非布尔的次要数据照常通过（数据键不受管辖）', () => {
    const { mailbox } = makeMailbox();
    expect(() =>
      mailbox.enqueue('system_event', {
        summary: 's',
        content: 'c',
        extra: { event: 'status_transition', factFingerprint: 'a->b', round: 2, missing: ['x'] },
      }),
    ).not.toThrow();
  });

  it('唤醒型投递仍必须可去重（本卡不重构该逻辑，回归保护）', () => {
    const { mailbox } = makeMailbox();
    expect(() =>
      mailbox.enqueue('requirement_update', {
        summary: 'review needed',
        content: 'please review',
        requirementId: 'req_1',
        extra: { actionRequired: true },
      }),
    ).toThrow(/undedupable wake-up/);
    expect(mailbox.depth).toBe(0);
  });
});

describe('2 · 读侧：未登记即拒绝（不是静默当流水账）', () => {
  it('含未登记布尔标记的项在解释时被拒绝，而不是悄悄降级为 informational', () => {
    const crafted = itemOf('a2a_message', {
      summary: 's',
      content: 'c',
      extra: { silentlySchedulesSomething: true },
    });

    expect(() => isStrictStateItem(crafted)).toThrow(/unregistered in-band marker/);
    expect(() => isTaskExecutionItem(crafted)).toThrow(/unregistered in-band marker/);
  });

  it('错误里给出可登记的出口（读侧同样可行动）', () => {
    const crafted = itemOf('system_event', { summary: 's', content: 'c', extra: { unknownFlag: true } });
    expect(() => isStrictStateItem(crafted)).toThrow(/IN_BAND_MARKERS/);
    expect(() => isStrictStateItem(crafted)).toThrow(/Refusing to interpret/);
  });
});

describe('3 · 三标记读取点全部走表内谓词（行为等价）', () => {
  const payload = (extra: Record<string, unknown>): MailboxPayload => ({ summary: 's', content: 'c', extra });

  it('triggerExecution 是严格 state item，也是 task 执行项', () => {
    const item = itemOf('task_status_update', { summary: 's', content: 'c', extra: { triggerExecution: true } });
    expect(isStrictStateItem(item)).toBe(true);
    expect(isTaskExecutionItem(item)).toBe(true);
  });

  it('没有 triggerExecution 的 task_status_update 是流水账', () => {
    const item = itemOf('task_status_update', { summary: 's', content: 'c', extra: { from: 'a', to: 'b' } });
    expect(isStrictStateItem(item)).toBe(false);
    expect(isTaskExecutionItem(item)).toBe(false);
  });

  it('isTaskExecutionItem 只认 triggerExecution（别把 actionRequired 也算进来）', () => {
    const item = itemOf('task_status_update', { summary: 's', content: 'c', extra: { actionRequired: true } });
    expect(isTaskExecutionItem(item)).toBe(false);
  });

  it('actionRequired 只在 requirement_update / workflow_update 上构成严格事件', () => {
    expect(isStrictStateItem(itemOf('requirement_update', { summary: 's', content: 'c', extra: { actionRequired: true } }))).toBe(true);
    expect(isStrictStateItem(itemOf('workflow_update', { summary: 's', content: 'c', extra: { actionRequired: true } }))).toBe(true);
    // 同标记在别的类型上不改变严格性（判定仍是 type + marker 二元，不是单看标记）。
    expect(isStrictStateItem(itemOf('system_event', { summary: 's', content: 'c', extra: { actionRequired: true } }))).toBe(false);
  });

  it('review_request 仍是严格事件（不受本卡影响）', () => {
    expect(isStrictStateItem(itemOf('review_request', { summary: 's', content: 'c', extra: {} }))).toBe(true);
  });

  it('含脏值（非布尔）的已登记标记在读侧被拒绝 —— 不许 truthy 蒙混', () => {
    const item = itemOf('requirement_update', payload({ actionRequired: 'yes' }));
    expect(() => isStrictStateItem(item)).toThrow(/must be a boolean/);
  });

  it('directMention 保护的项不会被心跳折叠吞掉（读取点走谓词后行为不变）', () => {
    const { mailbox } = makeMailbox();
    mailbox.enqueue('heartbeat', { summary: 'hb1', content: 'check1' }, { priority: 3 });
    mailbox.enqueue(
      'heartbeat',
      { summary: 'hb2', content: 'check2', extra: { directMention: true } },
      { priority: 3 },
    );
    // 普通心跳会被折叠；带 directMention 的不会被吞。
    expect(mailbox.getQueuedItems().length).toBe(2);
  });

  it('行动型需求条目可被撤回，普通流水保留（withdrawActionableFor 走同一谓词）', () => {
    const { mailbox } = makeMailbox();
    mailbox.enqueue('requirement_update', {
      summary: 'review needed',
      content: 'please review',
      requirementId: 'req-1',
      extra: { actionRequired: true, event: 'all_tasks_terminal', factFingerprint: 'req-1:done' },
    });
    mailbox.enqueue('requirement_update', {
      summary: 'status',
      content: 'status changed',
      requirementId: 'req-1',
      extra: { event: 'status_change' },
    });

    const removed = mailbox.withdrawActionableFor('req-1', 'requirement completed');
    expect(removed).toBe(1);
    expect(mailbox.getQueuedItems().length).toBe(1);
  });
});
