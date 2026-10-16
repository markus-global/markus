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
    expect(zh.body).toBe('任务「Ship the gateway」状态已变为 completed');
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
