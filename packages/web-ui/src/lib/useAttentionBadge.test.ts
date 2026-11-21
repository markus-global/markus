/**
 * 概览徽标**全局驱动器**的行为守卫（Owner 2026-11-20：角标只在进概览页时才更新）。
 *
 * 钉住的是**行为**，不是源码文本：
 *   ① 徽标由一个**与页面无关**的常驻 hook 发布 —— 测试里只 renderHook、绝不挂载概览页，
 *      若谁把发布退回「只有概览页激活才算」，这里立刻红（核心回归）。
 *   ② 全局变更事件（WS 通知 / 任务审批改动）到达 → 防抖后重算并发布新数字。
 *   ③ 任一接口读失败 → **不**拿一次失败把徽标谎报成 0，保留上一次已知值。
 *   ④ 未登录（无 userId）→ 不取数、不发布。
 *
 * 定时器纪律（同 RightPanelAutoRefresh）：`vi.useFakeTimers({shouldAdvanceTime:true})`
 * + 显式 `advanceTimersByTimeAsync`，不与裸 waitFor 互相等死。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { api, type ApprovalInfo } from '../api.ts';
import { useAttentionBadge } from './useAttentionBadge.ts';
import { publishAttentionCount, publishUnreadCount } from './attentionCount.ts';
import type * as AttentionCountModule from './attentionCount.ts';

// 发布通道换成 spies：断言「谁发布了什么数字」，不真的写 localStorage。
vi.mock('./attentionCount.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof AttentionCountModule>();
  return { ...actual, publishAttentionCount: vi.fn(), publishUnreadCount: vi.fn() };
});

const mkApproval = (id: string): ApprovalInfo => ({
  id,
  agentId: 'ag1',
  agentName: 'Payments Agent',
  type: 'task_approval',
  title: `Approve ${id}`,
  description: '',
  details: {},
  status: 'pending',
  requestedAt: '2026-11-20T00:00:00.000Z',
});

const approvalsOf = (...ids: string[]) => ({
  approvals: ids.map(mkApproval), total: ids.length, limit: 50, offset: 0,
});

let boardSpy: ReturnType<typeof vi.spyOn>;
let reqSpy: ReturnType<typeof vi.spyOn>;
let apprSpy: ReturnType<typeof vi.spyOn>;
let notifSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  boardSpy = vi.spyOn(api.tasks, 'boardSummary').mockResolvedValue({ board: {}, counts: {} });
  reqSpy = vi.spyOn(api.requirements, 'list').mockResolvedValue({ requirements: [] });
  apprSpy = vi.spyOn(api.approvals, 'list').mockResolvedValue(approvalsOf('a1', 'a2'));
  notifSpy = vi.spyOn(api.notifications, 'list').mockResolvedValue({ notifications: [], unreadCount: 3 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useAttentionBadge — 徽标与当前页面解耦', () => {
  it('① 只挂 hook、不挂概览页，也发布待办数 + 未读数', async () => {
    renderHook(() => useAttentionBadge('u1'));
    await waitFor(() => expect(publishAttentionCount).toHaveBeenCalledWith(2));
    expect(publishUnreadCount).toHaveBeenCalledWith(3);
  });

  it('② WS 通知事件到达 → 防抖后重算并发布新数字（无需切换页面）', async () => {
    renderHook(() => useAttentionBadge('u1'));
    await waitFor(() => expect(publishAttentionCount).toHaveBeenCalledWith(2));
    // 服务端新增一条审批、未读涨到 5
    apprSpy.mockResolvedValue(approvalsOf('a1', 'a2', 'a3'));
    notifSpy.mockResolvedValue({ notifications: [], unreadCount: 5 });
    act(() => { window.dispatchEvent(new Event('markus:notifications-changed')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await waitFor(() => expect(publishAttentionCount).toHaveBeenCalledWith(3));
    expect(publishUnreadCount).toHaveBeenCalledWith(5);
  });

  it('② 任务/审批改动事件（markus:data-changed）同样触发重算', async () => {
    renderHook(() => useAttentionBadge('u1'));
    await waitFor(() => expect(publishAttentionCount).toHaveBeenCalledWith(2));
    apprSpy.mockResolvedValue(approvalsOf('a1'));
    act(() => { window.dispatchEvent(new Event('markus:data-changed')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    await waitFor(() => expect(publishAttentionCount).toHaveBeenCalledWith(1));
  });

  it('③ 取数失败不谎报 0：保留上一次已知数字', async () => {
    renderHook(() => useAttentionBadge('u1'));
    await waitFor(() => expect(publishAttentionCount).toHaveBeenCalledWith(2));
    expect(publishAttentionCount).toHaveBeenCalledTimes(1);
    boardSpy.mockRejectedValue(new Error('network down'));
    act(() => { window.dispatchEvent(new Event('markus:data-changed')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    // 重算确实发起了（board 被第二次调用），但失败后没有再发布任何数字
    await waitFor(() => expect(boardSpy).toHaveBeenCalledTimes(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(publishAttentionCount).toHaveBeenCalledTimes(1);
    expect(publishAttentionCount).not.toHaveBeenCalledWith(0);
  });

  it('④ 未登录（userId 为空）不取数、不发布', async () => {
    renderHook(() => useAttentionBadge(undefined));
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(boardSpy).not.toHaveBeenCalled();
    expect(publishAttentionCount).not.toHaveBeenCalled();
    expect(publishUnreadCount).not.toHaveBeenCalled();
  });
});
