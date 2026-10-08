/**
 * notifyReview 回归护栏 —— 「点 L1 → 看该 Agent 的通知 → 落到正确会话」的判定逻辑。
 *
 * 用户报障：点 L1 只切到该 Agent 的对话页、落到上次的会话，通知内容看不到 → 困惑。
 * 相关判定（哪些算「该 Agent 待确认的通知」、按什么顺序审阅、读完落到哪个会话）
 * 必须可单测，否则换个入口（L2 / profile）还会再犯一次。
 */
import { describe, it, expect } from 'vitest';
import {
  selectAgentReviewNotifications,
  sortNotificationsForReview,
  resolveReviewLanding,
  notifySessionId,
  type NotificationInfo,
} from '../src/lib/notifyReview.ts';

let seq = 0;
function n(over: Partial<NotificationInfo> & { metadata?: Record<string, unknown> }): NotificationInfo {
  seq += 1;
  return {
    id: `n${seq}`,
    targetUserId: 'u1',
    type: 'agent_report',
    title: 'T',
    body: 'B',
    priority: 'normal',
    read: false,
    createdAt: `2026-10-0${(seq % 9) + 1}T00:00:0${seq % 10}.000Z`,
    ...over,
  };
}

describe('notifySessionId', () => {
  it('取 metadata.sessionId', () => {
    expect(notifySessionId(n({ metadata: { sessionId: 'sess_1' } }))).toBe('sess_1');
  });

  it('metadata 缺失时退回解析 actionTarget(open_chat).sessionId', () => {
    expect(notifySessionId(n({
      actionType: 'open_chat',
      actionTarget: JSON.stringify({ sessionId: 'sess_2' }),
    }))).toBe('sess_2');
  });

  it('两处都没有 → undefined', () => {
    expect(notifySessionId(n({}))).toBeUndefined();
  });

  it('actionTarget 非法 JSON 不抛异常', () => {
    expect(notifySessionId(n({ actionType: 'open_chat', actionTarget: '{not json' }))).toBeUndefined();
  });
});

describe('selectAgentReviewNotifications', () => {
  it('只挑该 Agent 的、未读的 agent_report', () => {
    const list = [
      n({ id: 'a', metadata: { agentId: 'ag1' } }),
      n({ id: 'b', metadata: { agentId: 'ag2' } }),               // 别的 Agent
      n({ id: 'c', metadata: { agentId: 'ag1' }, read: true }),   // 已读
      n({ id: 'd', metadata: { agentId: 'ag1' }, type: 'system' }), // 类型不对
      n({ id: 'e', metadata: { agentId: 'ag1', creditExhausted: true } }), // 额度耗尽
      n({ id: 'f', metadata: {} }),                                // 无 agentId
      n({ id: 'g', metadata: { agentId: 'ag1' } }),
    ];
    expect(selectAgentReviewNotifications(list, 'ag1').map(x => x.id).sort()).toEqual(['a', 'g']);
  });

  it('排序：优先级高的在前，同级按时间倒序', () => {
    const low = n({ id: 'low', priority: 'low', createdAt: '2026-10-08T09:00:00.000Z', metadata: { agentId: 'ag1' } });
    const norm = n({ id: 'norm', priority: 'normal', createdAt: '2026-10-08T10:00:00.000Z', metadata: { agentId: 'ag1' } });
    const urgent = n({ id: 'urgent', priority: 'urgent', createdAt: '2026-10-07T00:00:00.000Z', metadata: { agentId: 'ag1' } });
    const newerNorm = n({ id: 'newerNorm', priority: 'normal', createdAt: '2026-10-08T11:00:00.000Z', metadata: { agentId: 'ag1' } });
    expect(sortNotificationsForReview([low, norm, urgent, newerNorm]).map(x => x.id))
      .toEqual(['urgent', 'newerNorm', 'norm', 'low']);
  });

  it('不修改入参数组', () => {
    const list = [n({ id: 'x', priority: 'low', metadata: { agentId: 'ag1' } }), n({ id: 'y', priority: 'urgent', metadata: { agentId: 'ag1' } })];
    const before = list.map(x => x.id);
    sortNotificationsForReview(list);
    expect(list.map(x => x.id)).toEqual(before);
  });
});

describe('resolveReviewLanding', () => {
  it('全部来自同一会话 → 落到该会话 + 最早那条的 messageId', () => {
    const items = [
      n({ id: 'newer', createdAt: '2026-10-08T10:00:00.000Z', metadata: { agentId: 'ag1', sessionId: 'sess_x', messageId: 'm_new' } }),
      n({ id: 'older', createdAt: '2026-10-08T08:00:00.000Z', metadata: { agentId: 'ag1', sessionId: 'sess_x', messageId: 'm_old' } }),
    ];
    expect(resolveReviewLanding(items)).toEqual({ sessionId: 'sess_x', messageId: 'm_old' });
  });

  it('跨会话 → 无单一答案，返回 null（由调用方落主会话）', () => {
    const items = [
      n({ metadata: { agentId: 'ag1', sessionId: 'sess_a' } }),
      n({ metadata: { agentId: 'ag1', sessionId: 'sess_b' } }),
    ];
    expect(resolveReviewLanding(items)).toEqual({ sessionId: null, messageId: null });
  });

  it('同会话但都没带 sessionId → null', () => {
    const items = [n({ metadata: { agentId: 'ag1' } }), n({ metadata: { agentId: 'ag1' } })];
    expect(resolveReviewLanding(items)).toEqual({ sessionId: null, messageId: null });
  });

  it('同会话但没有任何 messageId → sessionId 有值、messageId 为 null', () => {
    const items = [n({ metadata: { agentId: 'ag1', sessionId: 'sess_x' } })];
    expect(resolveReviewLanding(items)).toEqual({ sessionId: 'sess_x', messageId: null });
  });

  it('空队列 → null', () => {
    expect(resolveReviewLanding([])).toEqual({ sessionId: null, messageId: null });
  });
});
