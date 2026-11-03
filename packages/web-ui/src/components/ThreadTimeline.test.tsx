import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

/**
 * `ThreadTimeline` 的核心契约：**只给 ref** 就能渲染一条流。
 *
 * 为什么这组断言必须存在：B4 的整个结构前提是「Thread 是视角，视角长在被看的对象上」。
 * 任务详情 / 票据详情 / agent 详情手里只有一个实体 id，如果组件实际上要先去拉
 * `GET /api/threads` 全局列表再按 id 找，那么三处入口就会在「列表没回来 / 分页没覆盖 /
 * 列表接口失败」时集体空掉 —— 而这不会报错，只会安静地少显示东西。
 *
 * 所以这里把**列表接口换成抛错的实现**：
 *   - 现在（按 ref 读）→ 绿；
 *   - 谁把它改回「列表 + 按 id 找」→ 立刻红。
 */
const apiMocks = vi.hoisted(() => ({
  fetchThreads: vi.fn(),
  fetchThreadByRef: vi.fn(),
  fetchThreadEvents: vi.fn(),
  fetchThreadDispositions: vi.fn(),
}));

vi.mock('../api.ts', () => apiMocks);

import { ThreadTimeline } from './ThreadTimeline.tsx';

const THREAD = {
  id: 'tsk_stream1',
  ref: 'tsk_stream1',
  ownerAgent: 'agt_cto',
  ownerSession: null,
  lastActivity: Date.parse('2026-11-03T10:00:00Z'),
  stage: 'person:review',
  stageRank: 2,
  stageBasis: 'partial' as const,
  missingFacts: ['openQuestion'],
  taskStatus: 'review',
  title: '修登录超时',
  detail: 'CI 失败后重跑通过',
};

const EVENTS = [
  {
    id: 'trg_1',
    threadId: 'tsk_stream1',
    kind: 'comment',
    actor: 'human:owner',
    summary: '这个登录超时能修吗',
    createdAt: Date.parse('2026-11-03T09:00:00Z'),
  },
  {
    id: 'trg_2',
    threadId: 'tsk_stream1',
    kind: 'chat',
    actor: 'agt_cto',
    summary: '收到，我开一张卡',
    createdAt: Date.parse('2026-11-03T09:10:00Z'),
  },
];

const DISPOSITIONS = [
  {
    id: 'dsp_1',
    triggerId: 'trg_1',
    threadId: 'thr_1',
    action: 'dispatch',
    reason: '人指定了 cto',
    matchedRule: null,
    wouldAccept: true,
    actor: 'router',
    createdAt: Date.parse('2026-11-03T09:05:00Z'),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.fetchThreads.mockImplementation(() => {
    throw new Error('ThreadTimeline 不许依赖全局列表接口');
  });
  apiMocks.fetchThreadByRef.mockResolvedValue({ thread: THREAD });
  apiMocks.fetchThreadEvents.mockResolvedValue({ events: EVENTS });
  apiMocks.fetchThreadDispositions.mockResolvedValue({ dispositions: DISPOSITIONS });
});

describe('ThreadTimeline — 只给 ref 就能渲染来龙去脉', () => {
  it('给定 ref，渲染出该流的时间线（事件 + 决定 + 当前状态），全程不碰全局列表', async () => {
    render(<ThreadTimeline refId="tsk_stream1" />);

    expect(await screen.findByText('这个登录超时能修吗')).toBeTruthy();
    expect(await screen.findByText('收到，我开一张卡')).toBeTruthy();
    expect(await screen.findByText('人指定了 cto')).toBeTruthy();
    // 头部事实也来自按 ref 的读取面（标题 / stage），不是列表
    expect(screen.getByText('修登录超时')).toBeTruthy();
    expect(screen.getByText('等你验收')).toBeTruthy();
    // 当前状态节点：明说它不是事件
    expect(screen.getByText('当前状态 · 派生快照')).toBeTruthy();

    // 唯一读取口径：按 ref
    expect(apiMocks.fetchThreadByRef).toHaveBeenCalledWith('tsk_stream1');
    expect(apiMocks.fetchThreadEvents).toHaveBeenCalledWith('tsk_stream1');
    expect(apiMocks.fetchThreadDispositions).toHaveBeenCalledWith('tsk_stream1');
    expect(apiMocks.fetchThreads).not.toHaveBeenCalled();
  });

  it('ref 换了就重新按新 ref 读（同一面板可以被复用到另一个对象）', async () => {
    const { rerender } = render(<ThreadTimeline refId="tsk_stream1" />);
    await screen.findByText('这个登录超时能修吗');

    rerender(<ThreadTimeline refId="tkt_9" />);
    await waitFor(() => expect(apiMocks.fetchThreadByRef).toHaveBeenLastCalledWith('tkt_9'));
    expect(apiMocks.fetchThreadEvents).toHaveBeenLastCalledWith('tkt_9');
  });

  it('头部事实读失败 → 明说读失败，不冒充「这条流没有内容」', async () => {
    apiMocks.fetchThreadByRef.mockRejectedValue(new Error('boom'));
    render(<ThreadTimeline refId="tsk_stream1" />);

    expect(await screen.findByText(/头部事实读取失败/)).toBeTruthy();
    // 事件仍然渲染（两段历史分开取，一段失败不连累另一段）
    expect(await screen.findByText('这个登录超时能修吗')).toBeTruthy();
  });

  it('事件读失败 → 明说，且不当成「没有事件」', async () => {
    apiMocks.fetchThreadEvents.mockRejectedValue(new Error('events down'));
    render(<ThreadTimeline refId="tsk_stream1" />);

    expect(await screen.findByText(/事件读取失败/)).toBeTruthy();
    expect(screen.queryByText(/这条流还没有事件或决定记录/)).toBeNull();
  });
});
