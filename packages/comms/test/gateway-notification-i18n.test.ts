/**
 * A notification must read the same in the chat app as it does in the product.
 *
 * ── The defect this exists to prevent (2026-10-16) ───────────────────────────
 *
 * The task status machine attaches **structured** i18n metadata to every
 * notification it emits (`metadata.i18n = { titleKey, titleParams, … }`) precisely
 * so the renderer can own the wording. The in-app bell honoured it and rendered
 * `任务已完成：…`. The outbound dispatcher ignored it and copied the producer's
 * baked-in English `title`, so the *same* fact landed in Feishu as
 * `Task completed: …` — one notification, two languages, and neither surface owned
 * the sentence.
 *
 * These tests pin the contract: the dispatcher renders from the same metadata the
 * bell uses, in the recipient's language, and falls back to the raw text only when
 * the key is not one this platform owns (legacy records, LLM-authored text).
 */
import { describe, it, expect } from 'vitest';
import { notificationToOutbound } from '../src/gateway/dispatcher.js';

/** A task-completion notification exactly as task-service emits it. */
function taskCompleted(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    type: 'task_completed',
    title: 'Task completed: Ship the gateway',
    body: 'Task "Ship the gateway" status changed to completed',
    priority: 'normal',
    metadata: {
      taskId: 'tsk_1',
      status: 'completed',
      i18n: {
        titleKey: 'notifications.titles.taskCompleted',
        titleParams: { title: 'Ship the gateway' },
        bodyKey: 'notifications.bodies.taskStatusChanged',
        bodyParams: { title: 'Ship the gateway', status: 'completed' },
      },
      ...overrides,
    },
  };
}

describe('outbound notification localization', () => {
  it('writes the title in the recipient language, not the producer’s', () => {
    const zh = notificationToOutbound(taskCompleted(), undefined, 'zh-CN');
    expect(zh.title).toBe('任务已完成：Ship the gateway');

    const en = notificationToOutbound(taskCompleted(), undefined, 'en');
    expect(en.title).toBe('Task completed: Ship the gateway');
  });

  it('localizes the body from the same metadata', () => {
    const zh = notificationToOutbound(taskCompleted(), undefined, 'zh-CN');
    // The status is a param *inside* the sentence, and it is an enum the reader
    // needs too: `状态已变为 completed` is still English in a Chinese sentence.
    expect(zh.body).toBe('任务「Ship the gateway」状态已变为 已完成');
  });

  it('falls back to English when no locale is known', () => {
    expect(notificationToOutbound(taskCompleted()).title).toBe('Task completed: Ship the gateway');
  });

  it('leaves a notification without i18n metadata exactly as it was written', () => {
    const legacy = notificationToOutbound({
      id: 'n2',
      type: 'task_completed',
      title: '来自 agent 的原文：没有键',
      body: 'raw body',
    });
    expect(legacy.title).toBe('来自 agent 的原文：没有键');
    expect(legacy.body).toBe('raw body');
  });

  it('passes through a key this platform does not own rather than inventing wording', () => {
    // An LLM-authored option/title is unknown by definition; rewriting it would be
    // the platform putting words in the author's mouth.
    const unknown = notificationToOutbound(
      {
        id: 'n3',
        type: 'custom',
        title: 'Custom title',
        body: 'custom body',
        metadata: { i18n: { titleKey: 'notifications.titles.madeUp', titleParams: {} } },
      },
      undefined,
      'zh-CN',
    );
    expect(unknown.title).toBe('Custom title');
  });

  it('leaves an unresolved placeholder visible instead of silently dropping the subject', () => {
    // Dropping it produces "任务已完成：" — a sentence with no subject, which reads
    // as a bug. A visible `{{title}}` says what actually happened.
    const out = notificationToOutbound(
      {
        id: 'n4',
        type: 'task_completed',
        title: 'fallback',
        body: 'fallback',
        metadata: {
          i18n: {
            titleKey: 'notifications.titles.taskCompleted',
            titleParams: { wrongParam: 'x' },
          },
        },
      },
      undefined,
      'zh-CN',
    );
    expect(out.title).toContain('{{title}}');
  });
});

/**
 * The approval card is the one notification a human must *act* on, and its sentence
 * was the last English literal on the path: the gates that open an approval wrote
 * `Agent "X" wants to create task "Y" (priority: normal).` and that exact string is
 * what a Feishu card showed, while the in-app card read Chinese because the UI
 * rebuilt the sentence from `details.subType`.
 */
describe('approval requests speak the recipient’s language', () => {
  const approval = (subType: string, bodyParams: Record<string, unknown>, bodyKey: string) => ({
    id: 'apr_1',
    type: 'approval_request',
    title: 'Ship the gateway',
    body: 'Agent "CTO" wants to create task "Ship the gateway" (priority: normal).',
    priority: 'high',
    metadata: { approvalId: 'apr_1', i18n: { bodyKey, bodyParams } },
  });

  it('renders the creation sentence in Chinese', () => {
    const out = notificationToOutbound(
      approval(
        'task',
        { agentName: 'CTO', title: 'Ship the gateway', priority: 'normal' },
        'notifications.approvalDesc.taskCreate',
      ),
      undefined,
      'zh-CN',
    );
    expect(out.body).toBe('智能体「CTO」想创建任务「Ship the gateway」（优先级：普通）。');
  });

  it('translates the priority word inside the sentence, not just the sentence', () => {
    const out = notificationToOutbound(
      approval(
        'task',
        { agentName: 'CTO', title: 'Ship the gateway', priority: 'urgent' },
        'notifications.approvalDesc.taskCreate',
      ),
      undefined,
      'zh-CN',
    );
    expect(out.body).toContain('（优先级：紧急）');
    expect(out.body).not.toContain('urgent');
  });

  it('carries the review tail verbatim — content is never translated', () => {
    const tail = '\n\nThe task description, written by the agent.\nDeliverables:\n- dlv_1';
    const out = notificationToOutbound(
      approval(
        'task_review',
        { title: 'Ship the gateway', tail },
        'notifications.approvalDesc.taskReview',
      ),
      undefined,
      'zh-CN',
    );
    expect(out.body).toBe(`任务「Ship the gateway」已提交审核。${tail}`);
  });

  it('translates a status value written in snake_case', () => {
    // Task statuses are `in_progress`; the string table is keyed `inProgress`. A
    // plain lookup misses and leaves "状态已变为 in_progress" half-translated.
    const out = notificationToOutbound(
      {
        id: 'n5',
        type: 'task_status_update',
        title: 'Task "X" status changed to in_progress',
        body: 'Task "X" status changed to in_progress',
        metadata: {
          i18n: {
            bodyKey: 'notifications.bodies.taskStatusChanged',
            bodyParams: { title: 'X', status: 'in_progress' },
          },
        },
      },
      undefined,
      'zh-CN',
    );
    expect(out.body).toBe('任务「X」状态已变为 进行中');
  });

  it('leaves user content alone while translating the sentence', () => {
    // The task title is content: a Chinese UI must not translate an English title.
    const out = notificationToOutbound(
      approval(
        'task_review',
        { title: 'Refactor the dispatcher', tail: '' },
        'notifications.approvalDesc.taskReview',
      ),
      undefined,
      'zh-CN',
    );
    expect(out.body).toContain('Refactor the dispatcher');
  });
});
