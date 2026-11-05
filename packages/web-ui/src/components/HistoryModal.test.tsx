/**
 * 历史弹窗的**三态**契约（审计 §3 事故②：「历史弹窗未读数不刷新」）。
 *
 * 事故原文：取数失败被吞掉，UI 继续显示**旧快照**。用户看到的数字是一个
 * 他无从检验的确定性陈述 —— 而实际上我们根本没读到。
 *
 * 三条断言（改坏任何一条都应该红）：
 *   1. 取数失败 → **不得**渲染空态文案「还没有历史记录」，也不得显示任何
 *      「N 条未读」数字（陈旧值 / 用当前分页折算出来的近似值都算撒谎）；
 *   2. 取数失败 → 必须有一条**可操作**的提示（含「重试」），点它能把数据取回来；
 *   3. 审批历史读失败 → 同样不得渲染空态文案（那是同一类谎话的第二个来源）。
 *
 * 为什么不用 `items.length === 0` 判定空态：见 `lib/threadTimeline.ts` 的
 * `timelineView()` —— 「有没有东西」只能有一个判据，UI 不得各自再数一遍。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiMocks = vi.hoisted(() => ({
  notifications: { list: vi.fn() },
  approvals: { list: vi.fn() },
}));

vi.mock('../api.ts', () => ({ api: apiMocks }));

import { HistoryModal } from './HistoryModal.tsx';

const NOTICE = {
  id: 'ntf_1',
  userId: 'user_1',
  title: '任务已完成',
  body: 'tsk_1 已通过验收',
  type: 'task',
  priority: 'normal',
  read: false,
  createdAt: new Date('2026-11-04T10:00:00Z').toISOString(),
  metadata: {},
};

function page(overrides: Partial<{ notifications: unknown[]; totalCount: number; unreadCount: number }> = {}) {
  return {
    notifications: overrides.notifications ?? [NOTICE],
    totalCount: overrides.totalCount ?? 1,
    unreadCount: overrides.unreadCount ?? 1,
  };
}

beforeEach(() => {
  apiMocks.notifications.list.mockReset();
  apiMocks.approvals.list.mockReset();
  apiMocks.approvals.list.mockResolvedValue({ approvals: [] });
});

describe('HistoryModal — 未读数是「读到的事实」，不是「上次的猜测」', () => {
  it('通知读取失败 → 不渲染空态文案，也不显示任何「N 条未读」数字，且给出可操作的重试', async () => {
    apiMocks.notifications.list.mockRejectedValue(new Error('network down'));

    render(<HistoryModal open onClose={() => {}} userId="user_1" />);

    // 1) 空态文案是谎话：我们并不知道有没有历史。
    await waitFor(() => expect(screen.getByText(/通知读取失败/)).toBeTruthy());
    expect(screen.queryByText(/还没有历史记录/)).toBeNull();
    // 顶部徽标必须明确说「不知道」，而不是继承上次的快照。
    expect(screen.getByText(/未读数未知/)).toBeTruthy();

    // 2) 任何「N 条未读」都是陈旧值或折算值 —— 一个都不许出现。
    expect(screen.queryByText(/\d+\s*条未读/)).toBeNull();
    // 也不许退化成「已全部读完」（那是另一句确定性陈述）。
    expect(screen.queryByText(/已全部读完/)).toBeNull();

    // 3) 错误必须可操作。
    expect(screen.getByRole('button', { name: /重试/ })).toBeTruthy();
  });

  it('点「重试」把数据取回来之后，未读数与列表都恢复（错误不是死路）', async () => {
    apiMocks.notifications.list
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(page({ unreadCount: 3 }));

    render(<HistoryModal open onClose={() => {}} userId="user_1" />);
    const retry = await screen.findByRole('button', { name: /重试/ });

    await userEvent.click(retry);

    await waitFor(() => expect(screen.getByText(/3\s*条未读/)).toBeTruthy());
    expect(screen.queryByText(/通知读取失败/)).toBeNull();
    expect(screen.queryByText(/未读数未知/)).toBeNull();
  });

  it('读成功且未读为 0 → 明确说「已全部读完」（此时才是确定性陈述）', async () => {
    apiMocks.notifications.list.mockResolvedValue(page({ notifications: [], totalCount: 0, unreadCount: 0 }));

    render(<HistoryModal open onClose={() => {}} userId="user_1" />);

    await waitFor(() => expect(screen.getByText(/已全部读完/)).toBeTruthy());
    expect(screen.queryByText(/\d+\s*条未读/)).toBeNull();
  });

  it('审批历史读取失败 → 不得渲染空态文案「还没有历史记录」', async () => {
    apiMocks.notifications.list.mockResolvedValue(page({ notifications: [], totalCount: 0, unreadCount: 0 }));
    apiMocks.approvals.list.mockRejectedValue(new Error('approvals down'));

    render(<HistoryModal open onClose={() => {}} userId="user_1" />);

    await waitFor(() => expect(screen.getByText(/审批历史读取失败/)).toBeTruthy());
    expect(screen.queryByText(/还没有历史记录/)).toBeNull();
  });

  it('真的读到了、确实是空的 → 才允许出现空态文案', async () => {
    apiMocks.notifications.list.mockResolvedValue(page({ notifications: [], totalCount: 0, unreadCount: 0 }));

    render(<HistoryModal open onClose={() => {}} userId="user_1" />);

    await waitFor(() => expect(screen.getByText(/还没有历史记录/)).toBeTruthy());
  });
});
