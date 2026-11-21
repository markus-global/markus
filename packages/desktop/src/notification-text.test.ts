import { describe, it, expect } from 'vitest';
import { taskUpdateOsText, notificationOsText } from './notification-text.js';

/**
 * Regression guard for the "OS notification reads English while the app reads
 * Chinese" bug (Owner 2026-11-20). The desktop bridge used to bake English
 * literals ('Task Completed', 'Review Required') and copy a structured
 * notification's raw English fallback title straight to macOS, ignoring the
 * `metadata.i18n` the in-app bell renders from. These tests assert the desktop
 * now speaks the SAME localized sentence as every other surface — they go red
 * if anyone re-introduces a baked literal or drops the i18n path.
 */
describe('taskUpdateOsText', () => {
  it('a task going to review reads 任务待审核 in zh, not "Review Required"', () => {
    const text = taskUpdateOsText('review', '修复登录页', 'zh-CN');
    expect(text).toEqual({ title: '任务待审核：修复登录页', body: '' });
  });

  it('completed / failed use the vocabulary sentence in the reader language', () => {
    expect(taskUpdateOsText('completed', 'X', 'zh-CN')?.title).toBe('任务已完成：X');
    expect(taskUpdateOsText('failed', 'X', 'zh-CN')?.title).toBe('任务失败：X');
    expect(taskUpdateOsText('review', 'X', 'en')?.title).toBe('Task ready for review: X');
  });

  it('a non-user-facing status produces no OS notification', () => {
    expect(taskUpdateOsText('in_progress', 'X', 'zh-CN')).toBeNull();
    expect(taskUpdateOsText(undefined, 'X', 'zh-CN')).toBeNull();
  });

  it('a title-less task:update is an internal signal, not a notification', () => {
    expect(taskUpdateOsText('completed', undefined, 'zh-CN')).toBeNull();
    expect(taskUpdateOsText('completed', '', 'zh-CN')).toBeNull();
  });
});

describe('notificationOsText', () => {
  // The real DB shape (probed 2026-11-20): the stored title is the producer's
  // English fallback, and metadata.i18n.titleKey carries the structure. The OS
  // must render the key, not the fallback.
  const completedNotice = {
    title: 'Task completed: 修复登录页',
    body: 'Task "修复登录页" status changed to completed',
    metadata: {
      i18n: {
        titleKey: 'notifications.titles.taskCompleted',
        titleParams: { title: '修复登录页' },
        bodyKey: 'notifications.bodies.taskStatusChanged',
        bodyParams: { title: '修复登录页', status: 'completed' },
      },
    },
  };

  it('localizes title AND body from metadata.i18n, ignoring the English fallback', () => {
    const { title, body } = notificationOsText(completedNotice, 'zh-CN');
    expect(title).toBe('任务已完成：修复登录页');
    // The enum param inside the body is localized too — not "状态已变为 completed".
    expect(body).toBe('任务「修复登录页」状态已变为 已完成');
  });

  it('an approval_request with no titleKey keeps the entity title but localizes the body + priority enum', () => {
    const approvalNotice = {
      title: '新建任务X',
      body: 'Agent "A" wants to create task "新建任务X" (priority: high).',
      metadata: {
        i18n: {
          bodyKey: 'notifications.approvalDesc.taskCreate',
          bodyParams: { agentName: 'A', title: '新建任务X', priority: 'high' },
        },
      },
    };
    const { title, body } = notificationOsText(approvalNotice, 'zh-CN');
    expect(title).toBe('新建任务X');
    expect(body).toBe('智能体「A」想创建任务「新建任务X」（优先级：高）。');
  });

  it('a legacy record with no i18n metadata falls back to the raw text (never invents a sentence)', () => {
    const { title, body } = notificationOsText({ title: 'Legacy', body: 'raw body' }, 'zh-CN');
    expect(title).toBe('Legacy');
    expect(body).toBe('raw body');
  });

  it('an absent notification yields the Markus placeholder, not a crash', () => {
    expect(notificationOsText(undefined, 'zh-CN')).toEqual({ title: 'Markus', body: '' });
  });
});