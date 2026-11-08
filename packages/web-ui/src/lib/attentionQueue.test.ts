import { describe, it, expect } from 'vitest';
import { buildAttentionQueue, actionableCount, formatWaiting, isAgentQuestion, type AttentionInput } from './attentionQueue.ts';
import type { ApprovalInfo, NotificationInfo, RequirementInfo, TaskInfo } from '../api.ts';

const task = (over: Partial<TaskInfo>): TaskInfo => ({
  id: 't1', title: 'Ship the widget', status: 'review', priority: 'medium',
  ...over,
} as TaskInfo);

const req = (over: Partial<RequirementInfo>): RequirementInfo => ({
  id: 'r1', title: 'Refactor slicing', status: 'pending', priority: 'high',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
} as RequirementInfo);

const approval = (over: Partial<ApprovalInfo>): ApprovalInfo => ({
  id: 'a1', agentId: 'ag1', agentName: 'Payments Agent', type: 'task',
  title: 'Approve the migration', description: '', details: {},
  status: 'pending', requestedAt: '2026-11-02T00:00:00.000Z',
  ...over,
} as ApprovalInfo);

const notice = (over: Partial<NotificationInfo>): NotificationInfo => ({
  id: 'n1', targetUserId: 'u1', type: 'agent_report', title: 'Report ready',
  body: '', priority: 'medium', read: false, createdAt: '2026-11-03T00:00:00.000Z',
  ...over,
} as NotificationInfo);

const base = (over: Partial<AttentionInput>): AttentionInput => ({
  tasks: [], requirements: [], approvals: [], notifications: [],
  ...over,
});

describe('buildAttentionQueue — 一条一条，而不是一堆计数', () => {
  it('每一类都给出具体标题，并带上可跳转的目标', () => {
    const items = buildAttentionQueue(base({
      tasks: [task({ id: 't9', title: 'Fix double charge', status: 'review', reviewerType: 'human' })],
      requirements: [req({ id: 'r9', title: 'Rework the slicing' })],
      approvals: [approval({ id: 'a9', title: 'Run the migration', details: { taskId: 't-other' } })],
    }));
    expect(items.map(i => i.title)).toEqual(
      expect.arrayContaining(['Fix double charge', 'Rework the slicing', 'Run the migration']),
    );
    const reqItem = items.find(i => i.kind === 'requirement_approval')!;
    expect(reqItem.target).toEqual({ page: 'WORK', params: { openRequirement: 'r9' } });
  });

  it('按等待时长排序：等最久的最上面', () => {
    const items = buildAttentionQueue(base({
      approvals: [approval({ id: 'new', requestedAt: '2026-11-05T00:00:00.000Z' })],
      requirements: [req({ id: 'old', createdAt: '2026-10-01T00:00:00.000Z' })],
    }));
    expect(items.map(i => i.id)).toEqual(['requirement:old', 'approval:new']);
  });

  it('同一刻按优先级，再按类型（要你决定的在前）', () => {
    const at = '2026-11-01T00:00:00.000Z';
    const items = buildAttentionQueue(base({
      tasks: [
        task({ id: 'low', status: 'review', reviewerType: 'human', priority: 'low', statusChangedAt: at }),
        task({ id: 'urgent', status: 'review', reviewerType: 'human', priority: 'urgent', statusChangedAt: at }),
      ],
      requirements: [req({ id: 'reqUrgent', priority: 'urgent', createdAt: at })],
    }));
    // 同为 urgent：requirement_approval（KIND_ORDER 3）在 task_review（4）之前
    expect(items.map(i => i.id)).toEqual([
      'requirement:reqUrgent', 'task:urgent', 'task:low',
    ]);
  });

  it('等依赖的 blocked 不进队列 —— 它不需要人', () => {
    const items = buildAttentionQueue(base({
      tasks: [
        task({ id: 'deps', status: 'blocked', blockedReason: 'deps' }),
        task({ id: 'hold', status: 'blocked', blockedReason: 'hold' }),
      ],
    }));
    expect(items.map(i => i.id)).toEqual(['blocked:hold']);
  });

  it('审批请求与同一任务的待验收不重复出两条', () => {
    const items = buildAttentionQueue(base({
      tasks: [task({ id: 't1', status: 'review', reviewerType: 'human' })],
      approvals: [approval({ id: 'a1', details: { taskId: 't1' } })],
    }));
    expect(items.map(i => i.kind)).toEqual(['approval_request']);
  });

  it('只有 reviewerType=human 的 review 任务才算「等你」', () => {
    const items = buildAttentionQueue(base({
      tasks: [task({ id: 'agentReviewed', status: 'review', reviewerType: 'agent' })],
    }));
    expect(items).toHaveLength(0);
  });

  it('审批请求没有落点实体时回到 agent 主会话（提问类在那儿能回答）', () => {
    const items = buildAttentionQueue(base({ approvals: [approval({ id: 'q1', details: {} })] }));
    expect(items[0]!.target).toEqual({ page: 'TEAM', params: { agentId: 'ag1', preferMain: '1' } });
  });
});

describe('「新」标记：比上次访问新，且首次使用不谎报', () => {
  it('没有 lastSeen 时全部不算新（避免开局一片「新」）', () => {
    const items = buildAttentionQueue(base({
      requirements: [req({ createdAt: '2026-11-08T00:00:00.000Z' })],
    }));
    expect(items.every(i => !i.isNew)).toBe(true);
  });

  it('晚于 lastSeen 的条目算新，早的不算', () => {
    const items = buildAttentionQueue(base({
      lastSeenAt: '2026-11-05T00:00:00.000Z',
      approvals: [
        approval({ id: 'old', requestedAt: '2026-11-01T00:00:00.000Z' }),
        approval({ id: 'fresh', requestedAt: '2026-11-07T00:00:00.000Z' }),
      ],
    }));
    expect(items.find(i => i.id === 'approval:fresh')!.isNew).toBe(true);
    expect(items.find(i => i.id === 'approval:old')!.isNew).toBe(false);
  });

  it('未读消息的「新」只看服务端 read 标记', () => {
    const items = buildAttentionQueue(base({
      lastSeenAt: '2026-11-09T00:00:00.000Z', // 比 createdAt 还晚
      notifications: [notice({ createdAt: '2026-11-01T00:00:00.000Z' })],
    }));
    expect(items[0]!.isNew).toBe(true);
  });
});

describe('计数口径与等待时长', () => {
  it('徽标只数「要你动手」的，未读由 attentionCount 另行合并（不重复计）', () => {
    const items = buildAttentionQueue(base({
      requirements: [req({})],
      notifications: [notice({ id: 'n1' }), notice({ id: 'n2' })],
    }));
    expect(items).toHaveLength(3);
    expect(actionableCount(items)).toBe(1);
  });

  it('有 statusChangedAt 就是精确口径；没有则标 approximate 并显示「约」', () => {
    const exact = buildAttentionQueue(base({
      tasks: [task({ status: 'review', reviewerType: 'human', statusChangedAt: '2026-11-08T10:00:00.000Z' })],
    }))[0]!;
    const approx = buildAttentionQueue(base({
      tasks: [task({ status: 'review', reviewerType: 'human', updatedAt: '2026-11-08T10:00:00.000Z' })],
    }))[0]!;
    const now = Date.parse('2026-11-08T12:00:00.000Z');
    expect(exact.waitingBasis).toBe('status');
    expect(formatWaiting(exact, now)).toBe('2 小时');
    expect(approx.waitingBasis).toBe('approximate');
    expect(formatWaiting(approx, now)).toBe('约 2 小时');
  });

  it('时长文案跨档（分钟 / 小时 / 天）', () => {
    const now = Date.parse('2026-11-10T12:00:00.000Z');
    const at = (iso: string) => formatWaiting({ waitingSince: iso, waitingBasis: 'requested' }, now);
    expect(at('2026-11-10T11:59:40.000Z')).toBe('<1 分钟');
    expect(at('2026-11-10T11:30:00.000Z')).toBe('30 分钟');
    expect(at('2026-11-10T08:00:00.000Z')).toBe('4 小时');
    expect(at('2026-11-08T08:00:00.000Z')).toBe('2 天 4 小时');
  });
});

describe('提问 ≠ 审批（Owner 2026-11-08：「agent 提的问题属于未读消息吗」）', () => {
  const question = (over: Partial<ApprovalInfo> = {}) => approval({
    id: 'q1', type: 'action', title: '要用哪个口径？',
    questions: [{ id: 'q_1', prompt: '要用哪个口径？', inputType: 'choice' }],
    ...over,
  });

  it('带 questions[] 的审批归到 agent_question，不是 approval_request', () => {
    const [item] = buildAttentionQueue(base({ approvals: [question()] }));
    expect(item!.kind).toBe('agent_question');
  });

  it('不带 questions[] 的仍然是 approval_request', () => {
    const [item] = buildAttentionQueue(base({ approvals: [approval({ id: 'a2' })] }));
    expect(item!.kind).toBe('approval_request');
  });

  it('同一时刻提问排在审批前面（它阻塞 Agent 整个回合）', () => {
    const items = buildAttentionQueue(base({
      approvals: [approval({ id: 'a1', requestedAt: '2026-11-08T00:00:00.000Z' }), question({ requestedAt: '2026-11-08T00:00:00.000Z' })],
    }));
    expect(items.map(i => i.kind)).toEqual(['agent_question', 'approval_request']);
  });

  it('它不是未读消息 —— 未读消息只来自 notifications，不进要你动手的计数', () => {
    const items = buildAttentionQueue(base({ approvals: [question()], notifications: [notice({ id: 'n1' })] }));
    expect(items.filter(i => i.kind === 'unread_message')).toHaveLength(1);
    expect(actionableCount(items)).toBe(1); // 只有那条提问算「要你动手」
  });

  it('isAgentQuestion 只认 questions[] 非空', () => {
    expect(isAgentQuestion({ questions: [{}] })).toBe(true);
    expect(isAgentQuestion({ questions: [] })).toBe(false);
    expect(isAgentQuestion({})).toBe(false);
    expect(isAgentQuestion(null)).toBe(false);
  });
});
