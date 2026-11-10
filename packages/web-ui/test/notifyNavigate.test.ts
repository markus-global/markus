/**
 * `notificationTarget` 与 `navigateForNotification` 的**一致性护栏**。
 *
 * 为什么需要：判定的唯一实现是 `notificationTarget`，`navigateForNotification` 只负责「跳」。
 * 若哪天有人在其中一处偷偷加分支，这份矩阵会立刻变红 —— 而不是等到概览又把
 * 「任务已完成」送去团队聊天（Owner 2026-11-10 报障）才发现。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { navBus } from '../src/navBus.ts';
import { navigateForNotification, notificationTarget } from '../src/lib/notifyNavigate.ts';
import type { NotificationInfo } from '../src/api.ts';

let seq = 0;
function notice(over: Partial<NotificationInfo> & { metadata?: Record<string, unknown> }): NotificationInfo {
  seq += 1;
  return {
    id: `nav-${seq}`,
    targetUserId: 'all',
    type: 'system',
    title: 't',
    body: 'b',
    priority: 'normal',
    read: false,
    createdAt: '2026-11-10T00:00:00Z',
    ...over,
  };
}

let calls: Array<{ page: string; params?: Record<string, string> }> = [];
beforeEach(() => {
  // navBus 会把参数写到 localStorage（深链恢复用）；测试里只要不报错，不需要真的存。
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  });
  calls = [];
  navBus.setHandler((page, params) => { calls.push(params ? { page, params } : { page }); });
});

function navigateAndCapture(n: NotificationInfo) {
  calls = [];
  navigateForNotification(n);
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

const CASES: Array<{ name: string; n: NotificationInfo; page: string; params?: Record<string, string> }> = [
  {
    name: 'task_completed → Work 页打开该任务',
    n: notice({ type: 'task_completed', metadata: { taskId: 'tsk_1' }, actionType: 'navigate', actionTarget: JSON.stringify({ path: '/work?openTask=tsk_1' }) }),
    page: 'work', params: { openTask: 'tsk_1' },
  },
  {
    name: 'task_review → Work 页打开该任务',
    n: notice({ type: 'task_review', metadata: { taskId: 'tsk_2' } }),
    page: 'work', params: { openTask: 'tsk_2' },
  },
  {
    name: 'requirement_decision → Work 页打开该需求',
    n: notice({ type: 'requirement_decision', metadata: { requirementId: 'req_1' }, actionType: 'navigate', actionTarget: JSON.stringify({ path: '/work?openRequirement=req_1' }) }),
    page: 'work', params: { openRequirement: 'req_1' },
  },
  {
    name: 'open_chat + 具体任务（具体优先于笼统）→ Work',
    n: notice({ type: 'agent_report', metadata: { taskId: 'tsk_3', agentId: 'agt_a' }, actionType: 'open_chat', actionTarget: JSON.stringify({ agentId: 'agt_a' }) }),
    page: 'work', params: { openTask: 'tsk_3' },
  },
  {
    name: 'open_chat 无实体 → 发送者会话',
    n: notice({ type: 'agent_report', metadata: { agentId: 'agt_b', sessionId: 'sess_9' }, actionType: 'open_chat', actionTarget: JSON.stringify({ agentId: 'agt_b', sessionId: 'sess_9' }) }),
    page: 'team', params: { agentId: 'agt_b', sessionId: 'sess_9' },
  },
  {
    name: '私信 → Team dm',
    n: notice({ type: 'direct_message', metadata: { senderId: 'u_1' } }),
    page: 'team', params: { dm: 'u_1' },
  },
  {
    name: '群消息 → Team channel',
    n: notice({ type: 'group_message', metadata: { channel: 'ch_1' } }),
    page: 'team', params: { channel: 'ch_1' },
  },
];

describe('notificationTarget ↔ navigateForNotification 一致', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const target = notificationTarget(c.n);
      expect(target).not.toBeNull();
      expect(target!.page.toLowerCase()).toBe(c.page);
      expect(target!.params).toEqual(c.params ?? {});

      const call = navigateAndCapture(c.n);
      expect(call.page).toBe(c.page);
      expect(call.params).toEqual(c.params);
    });
  }

  it('审批请求：判定交给上下文，跳转仍落到该 Agent 主会话', () => {
    const n = notice({ type: 'approval_request', metadata: { agentId: 'agt_q' } });
    expect(notificationTarget(n)).toBeNull();
    expect(navigateAndCapture(n)).toEqual({ page: 'team', params: { agentId: 'agt_q', preferMain: '1' } });
  });

  it('额度耗尽不是「去哪儿」而是「弹什么」', () => {
    const n = notice({ type: 'system', metadata: { creditExhausted: true } });
    expect(notificationTarget(n)).toBeNull();
    let fired = false;
    calls = [];
    navigateForNotification(n, { onCreditExhausted: () => { fired = true; } });
    expect(fired).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
