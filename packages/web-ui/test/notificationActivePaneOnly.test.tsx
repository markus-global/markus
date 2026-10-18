/**
 * 通知页（内嵌 / 移动端）：只布局「当前标签页」的那一栏。
 *
 * 报障原话（Owner 2026-10-18，移动端）：「未读通知页面……页面会一片空白，并支持
 * 上下滑动。如果没有内容了，就不应该滑动了。」
 *
 * 根因不是空的列表本身，而是这一栏两边都排在了同一个 flex row 里（旧的内嵌 tab
 * 滑动留下的 `translateX` 双栏，滑动手势后来统一收归 navRing，双栏只剩副作用）：
 * 移动端文档滚动时，链路上每个 `h-full` 都塌成 `auto`，于是**每一栏按自己的内容
 * 撑高**，行高 = 较高的那一栏。实测（真实浏览器、390×844）：
 *   未读空态那一栏 = 64px，行 = 3297px（审批栏），文档 3492 vs 视口 844
 *   → 2648px 可滚动的纯空白，滚动手势还会让顶栏/底栏以为用户在下滑而收起。
 * 浮窗（header popover）从来没有这个毛病——它一直只渲染当前 tab。
 *
 * jsdom 不做布局计算，所以这里钉住的是**结构不变量**：非活动栏的 DOM 不存在，
 * 于是它不可能贡献任何高度。旧实现下第一条断言是红的（两栏同时渲染）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import i18n from '../src/i18n/index.ts';

const APPROVAL_TITLE = '待批：部署到生产';
const NOTIF_TITLE = '构建完成通知';

const iso = (m: number) => new Date(Date.UTC(2026, 9, 18, 12, 0, 0) - m * 60_000).toISOString();

vi.mock('../src/api.ts', () => {
  const noop = () => {};
  const pendingApproval = {
    id: 'ap_pending',
    agentId: 'agt_x',
    agentName: 'Agent',
    type: 'tool_execution',
    title: '待批：部署到生产',
    description: 'desc',
    details: {},
    status: 'pending',
    requestedAt: new Date(Date.UTC(2026, 9, 18, 12, 0, 0)).toISOString(),
  };
  const unreadNotification = {
    id: 'n_unread',
    targetUserId: 'u1',
    type: 'system',
    title: '构建完成通知',
    body: 'body',
    priority: 'normal',
    read: false,
    createdAt: new Date(Date.UTC(2026, 9, 18, 11, 59, 0)).toISOString(),
  };
  return {
    api: {
      approvals: {
        list: vi.fn(async () => ({ approvals: [pendingApproval], total: 1, limit: 50, offset: 0 })),
        respond: vi.fn(),
      },
      notifications: {
        // `all` 视图 / `unread` 视图都返回同一条未读
        list: vi.fn(async () => ({
          notifications: [unreadNotification],
          totalCount: 1,
          unreadCount: 1,
        })),
        markRead: vi.fn(async () => ({ success: true })),
      },
    },
    wsClient: { on: () => noop },
    hubApi: { getUrl: () => 'http://localhost' },
    invalidateApiCache: noop,
    resolveApprovalDirection: () => 'approve',
  };
});

vi.mock('../src/pages/ChatComponents.tsx', () => ({ muteCreditNotifications: () => {} }));
vi.mock('../src/hooks/useElectron.ts', () => ({ openExternal: () => {} }));

const { NotificationBell } = await import('../src/components/NotificationBell.tsx');

class NoopIO {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  vi.stubGlobal('IntersectionObserver', NoopIO);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function clickTab(label: string): void {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent?.trim().startsWith(label));
  if (!btn) throw new Error(`tab button not found: ${label}`);
  act(() => { (btn as HTMLElement).click(); });
}

describe('移动端通知页：只布局当前标签页', () => {
  it('默认（审批）：审批行在 DOM，通知栏完全不渲染', async () => {
    render(<NotificationBell embeddedMode userId="u1" label="通知" />);

    await waitFor(() => expect(screen.getAllByText(APPROVAL_TITLE).length).toBeGreaterThan(0));

    // 关键不变量：非活动栏不在 DOM 里 → 它的高度不可能进入文档高度
    expect(document.body.textContent).not.toContain(NOTIF_TITLE);
  });

  it('切到通知：通知行出现，审批栏同时卸载（两栏永不同时布局）', async () => {
    render(<NotificationBell embeddedMode userId="u1" label="通知" />);
    await waitFor(() => expect(screen.getAllByText(APPROVAL_TITLE).length).toBeGreaterThan(0));

    clickTab('通知');

    await waitFor(() => expect(screen.getAllByText(NOTIF_TITLE).length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toContain(APPROVAL_TITLE);
  });

  it('切回审批：仍只有一栏在 DOM —— 反复切换不会累积', async () => {
    render(<NotificationBell embeddedMode userId="u1" label="通知" />);
    await waitFor(() => expect(screen.getAllByText(APPROVAL_TITLE).length).toBeGreaterThan(0));

    clickTab('通知');
    await waitFor(() => expect(screen.getAllByText(NOTIF_TITLE).length).toBeGreaterThan(0));
    clickTab('审批');
    await waitFor(() => expect(screen.getAllByText(APPROVAL_TITLE).length).toBeGreaterThan(0));

    expect(document.body.textContent).not.toContain(NOTIF_TITLE);
  });
});
