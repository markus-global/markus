/**
 * 概览「需要你的关注」队列的回归护栏。
 *
 * 修的两个缺陷（Owner 2026-11-10 报障），都出自 `buildAttentionQueue` 的未读通知分支：
 *   ① 标题直接取 `n.title`（后端英文兜底）→ 界面显示 "Task completed: …"；
 *   ② 落点写死 `page: 'TEAM'` → 点「任务已完成 / 任务待审核 / 需求已批准」全被送去团队聊天，
 *      而通知里明明带着 `metadata.taskId` / `actionTarget(/work?openTask=…)`。
 *
 * 这两个判定必须能单测 —— 否则下次「简化」概览时还会再犯（notifyNavigate 头部注释
 * 记录过同一个回归）。
 */
import { describe, it, expect } from 'vitest';
import { buildAttentionQueue } from '../src/lib/attentionQueue.ts';
import type { NotificationInfo } from '../src/api.ts';

let seq = 0;
function notice(over: Partial<NotificationInfo> & { metadata?: Record<string, unknown> }): NotificationInfo {
  seq += 1;
  return {
    id: `notice-${seq}`,
    targetUserId: 'all',
    type: 'task_completed',
    title: 'Task completed: 发货',
    body: '',
    priority: 'normal',
    read: false,
    createdAt: '2026-11-10T00:00:00Z',
    ...over,
  };
}

function queueOf(notifications: NotificationInfo[], notifyTitle?: (n: NotificationInfo) => string) {
  return buildAttentionQueue({
    tasks: [],
    requirements: [],
    approvals: [],
    notifications,
    ...(notifyTitle ? { notifyTitle } : {}),
  });
}

describe('buildAttentionQueue · 未读通知的落点', () => {
  it('任务已完成 → Work 页那张卡，而不是团队聊天', () => {
    const [row] = queueOf([
      notice({
        type: 'task_completed',
        metadata: { taskId: 'tsk_abc' },
        actionType: 'navigate',
        actionTarget: JSON.stringify({ path: '/work?openTask=tsk_abc' }),
      }),
    ]);
    expect(row!.kind).toBe('unread_message');
    expect(row!.target).toEqual({ page: 'WORK', params: { openTask: 'tsk_abc' } });
  });

  it('任务待审核 → Work 页那张卡', () => {
    const [row] = queueOf([notice({ type: 'task_review', metadata: { taskId: 'tsk_rev' } })]);
    expect(row!.target).toEqual({ page: 'WORK', params: { openTask: 'tsk_rev' } });
  });

  it('需求已批准 → Work 页那个需求', () => {
    const [row] = queueOf([
      notice({
        type: 'requirement_decision',
        metadata: { requirementId: 'req_1', decision: 'approved' },
        actionType: 'navigate',
        actionTarget: JSON.stringify({ path: '/work?openRequirement=req_1' }),
      }),
    ]);
    expect(row!.target).toEqual({ page: 'WORK', params: { openRequirement: 'req_1' } });
  });

  it('真的属于聊天的通知仍然回团队页（不能一律改跳 Work）', () => {
    const [row] = queueOf([
      notice({
        type: 'agent_report',
        metadata: { agentId: 'agt_x', sessionId: 'sess_1' },
        actionType: 'open_chat',
        actionTarget: JSON.stringify({ agentId: 'agt_x', sessionId: 'sess_1' }),
      }),
    ]);
    expect(row!.target).toEqual({ page: 'TEAM', params: { agentId: 'agt_x', sessionId: 'sess_1' } });
  });

  it('需要上下文的审批类通知：退回发送者主会话', () => {
    const [row] = queueOf([notice({ type: 'approval_request', metadata: { agentId: 'agt_q' } })]);
    expect(row!.target).toEqual({ page: 'TEAM', params: { agentId: 'agt_q', preferMain: '1' } });
  });
});

describe('buildAttentionQueue · 未读通知的文案', () => {
  it('注入的本地化解析器生效（不再显示英文兜底）', () => {
    const n = notice({
      type: 'task_completed',
      title: 'Task completed: 发货',
      metadata: { taskId: 'tsk_abc', i18n: { titleKey: 'notifications.titles.taskCompleted', titleParams: { title: '发货' } } },
    });
    const [row] = queueOf([n], x => {
      // 模拟 i18next：用 metadata.i18n.titleKey 渲染成中文
      const i18n = (x.metadata as { i18n: { titleParams: { title: string } } }).i18n;
      return `任务已完成：${i18n.titleParams.title}`;
    });
    expect(row!.title).toBe('任务已完成：发货');
  });

  it('没有注入解析器时回落原文（纯函数可单独使用）', () => {
    const [row] = queueOf([notice({ title: 'Task completed: 发货' })]);
    expect(row!.title).toBe('Task completed: 发货');
  });
});
