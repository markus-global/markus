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
import type { NotificationInfo, TaskInfo } from '../src/api.ts';

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

let tseq = 0;
function task(over: Partial<TaskInfo>): TaskInfo {
  tseq += 1;
  return {
    id: `tsk_${tseq}`,
    title: '待审卡',
    description: '',
    status: 'review',
    priority: 'normal',
    assignedAgentId: 'agt_a',
    reviewerId: 'user_owner',
    reviewerType: 'human',
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
    statusChangedAt: '2026-11-10T00:00:00Z',
    ...over,
  } as TaskInfo;
}

/**
 * 「同一实体只出一行」——Owner 2026-11-10 选 A（去重）。
 *
 * 背景：reviewer 是人时，同一张待审卡既有任务行、又有 task_review 通知行，内容重复。
 * 去重后必须把通知挂到保留那一行的 `notices` 上，否则点击不标已读，
 * 徽标与列表就分叉（数字 5、列表 4 行）。
 */
describe('buildAttentionQueue · 同一实体只出一行', () => {
  it('人工评审：任务行吃掉同一张卡的 task_review 通知', () => {
    const t = task({ id: 'tsk_dup', title: '待审卡' });
    const n = notice({
      type: 'task_review',
      title: 'Task ready for review: 待审卡',
      metadata: { taskId: 'tsk_dup' },
    });
    const rows = buildAttentionQueue({ tasks: [t], requirements: [], approvals: [], notifications: [n] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('task_review');
    expect(rows[0]!.notices?.map(x => x.id)).toEqual([n.id]);
  });

  it('不同任务的通知仍然单独成行，并携带自己的 notices（点击才能标已读）', () => {
    const t = task({ id: 'tsk_a', title: 'A' });
    const other = notice({ type: 'task_completed', metadata: { taskId: 'tsk_other' } });
    const rows = buildAttentionQueue({ tasks: [t], requirements: [], approvals: [], notifications: [other] });
    expect(rows).toHaveLength(2);
    const unread = rows.find(r => r.kind === 'unread_message')!;
    expect(unread.notices?.map(x => x.id)).toEqual([other.id]);
  });

  it('聊天类通知不参与实体去重（它们不指向 Work 页实体）', () => {
    const t = task({ id: 'tsk_a' });
    const chat = notice({
      type: 'agent_report',
      metadata: { agentId: 'agt_x', sessionId: 's_1' },
      actionType: 'open_chat',
      actionTarget: JSON.stringify({ agentId: 'agt_x', sessionId: 's_1' }),
    });
    const rows = buildAttentionQueue({ tasks: [t], requirements: [], approvals: [], notifications: [chat] });
    expect(rows).toHaveLength(2);
  });
});
