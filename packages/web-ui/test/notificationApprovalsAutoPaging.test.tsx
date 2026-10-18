/**
 * 审批历史的自动翻页 —— 与通知同一个触发机制（Owner 追问 2026-10-18）。
 *
 * 报障原话：「为什么审批是需要点击按钮，才能加载更多历史，而不是像通知一样，
 * 滑到底部的时候自动加载？」答案是上一轮只做到「能加载」，加了个按钮就收工，
 * 同一个浮窗里两种交互。现在两个列表共用「列表末尾 sentinel + IntersectionObserver」：
 * 无论浮窗里自己滚、还是整页跟着窗口滚，sentinel 进入视口就请求下一页。
 *
 * 这里钉住三件事（任何一条坏掉，用户就又得点按钮）：
 *  ① 列表末尾有一个 sentinel（没有「加载更多历史」按钮）；
 *  ② sentinel 进入视口 → 用**游标** offset=50 请求第 2 页（不是 list.length）；
 *  ③ 第 2 页到了以后合并进同一个列表（不替换、不塌陷）。
 *
 * 真实浏览器探针在本机不可用：DevTools 里打开的标签页 document.hidden === true，
 * Chrome 会冻结 IntersectionObserver / rAF，回调永远不来。所以这里用 jsdom +
 * 受控的 IntersectionObserver 复现「用户滚到底」这一动作。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import i18n from '../src/i18n/index.ts';
import type { ApprovalInfo } from '../src/api.ts';

// ─── 受控的 IntersectionObserver ─────────────────────────────────────────────

interface MockObserver {
  callback: IntersectionObserverCallback;
  elements: Element[];
  options?: IntersectionObserverInit;
}

const observers: MockObserver[] = [];

class ControllableIO {
  private readonly entry: MockObserver;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.entry = { callback, elements: [], options };
    observers.push(this.entry);
  }
  observe(el: Element) { this.entry.elements.push(el); }
  unobserve(el: Element) { this.entry.elements = this.entry.elements.filter(e => e !== el); }
  disconnect() { this.entry.elements = []; }
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

/** 模拟「这个元素进入视口了」：找到观察它的 observer 并触发回调。 */
function scrollIntoView(el: Element): boolean {
  const o = observers.find(x => x.elements.includes(el));
  if (!o) return false;
  o.callback([{ isIntersecting: true, target: el } as IntersectionObserverEntry], o as unknown as IntersectionObserver);
  return true;
}

// ─── 假 api（只实现组件真的会调的那几个）─────────────────────────────────────

const PAGE = 50;
const TOTAL = 2522;

function approvalFixture(i: number): ApprovalInfo {
  return {
    id: `ap_${i}`,
    agentId: 'agt_x',
    agentName: 'Agent',
    type: 'tool_execution',
    title: `审批 #${i}`,
    description: `desc ${i}`,
    details: {},
    status: 'approved',
    requestedAt: new Date(Date.UTC(2026, 9, 18, 12, 0, 0) - i * 60_000).toISOString(),
    respondedAt: new Date(Date.UTC(2026, 9, 18, 12, 1, 0) - i * 60_000).toISOString(),
  };
}

const approvalsList = vi.fn(async (_status?: string, opts?: { limit?: number; offset?: number }) => {
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? PAGE;
  const rows = Array.from({ length: Math.max(0, Math.min(limit, TOTAL - offset)) }, (_, k) => approvalFixture(offset + k));
  return { approvals: rows, total: TOTAL, limit, offset };
});

vi.mock('../src/api.ts', () => {
  const noop = () => {};
  return {
    api: {
      approvals: { list: approvalsList, respond: vi.fn() },
      notifications: {
        list: vi.fn(async (_userId?: string, unread?: boolean) => ({
          notifications: [],
          totalCount: 0,
          unreadCount: unread ? 0 : 0,
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

// 组件还会 import 这两处（真实实现依赖 window/localStorage，jsdom 下可用）
vi.mock('../src/pages/ChatComponents.tsx', () => ({ muteCreditNotifications: () => {} }));
vi.mock('../src/hooks/useElectron.ts', () => ({ openExternal: () => {} }));

const { NotificationBell } = await import('../src/components/NotificationBell.tsx');

beforeEach(async () => {
  await i18n.changeLanguage('zh-CN');
  observers.length = 0;
  approvalsList.mockClear();
  vi.stubGlobal('IntersectionObserver', ControllableIO);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('审批历史：滑到底自动加载（不再需要点按钮）', () => {
  it('首屏 50 条，列表末尾是 sentinel，没有「加载更多历史」按钮', async () => {
    render(<NotificationBell embeddedMode userId="u1" label="通知" />);

    await waitFor(() => expect(screen.getAllByText('审批 #0').length).toBeGreaterThan(0));

    // 按钮已删除（这就是 Owner 问的那处不一致）
    expect(document.body.textContent).not.toContain('加载更多历史');

    // 首屏只取了一次，游标从 0 开始，limit=50
    expect(approvalsList).toHaveBeenCalledTimes(1);
    expect(approvalsList.mock.calls[0]![1]).toEqual({ limit: 50 });

    // sentinel 就位
    const sentinel = document.querySelector('div[aria-hidden].h-px');
    expect(sentinel).not.toBeNull();
    expect(observers.some(o => o.elements.includes(sentinel!))).toBe(true);
  });

  it('sentinel 进入视口 → 用游标 offset=50 取第 2 页，并合并进同一个列表', async () => {
    render(<NotificationBell embeddedMode userId="u1" label="通知" />);
    await waitFor(() => expect(screen.getAllByText('审批 #0').length).toBeGreaterThan(0));

    const sentinel = document.querySelector('div[aria-hidden].h-px')!;
    expect(scrollIntoView(sentinel)).toBe(true);

    // 第 2 页：offset 必须是服务端已给过的行数（50），不是列表长度
    await waitFor(() => expect(approvalsList).toHaveBeenCalledTimes(2));
    expect(approvalsList.mock.calls[1]![1]).toEqual({ limit: 50, offset: 50 });

    // 第 2 页真的渲染出来了，第 1 页还在（合并不是替换）
    await waitFor(() => expect(screen.getAllByText('审批 #50').length).toBeGreaterThan(0));
    expect(screen.getAllByText('审批 #0').length).toBeGreaterThan(0);
  });

  it('到了总数就停：sentinel 卸载，不会再请求', async () => {
    // 只剩 50 条 → 第 1 页就是全部
    approvalsList.mockImplementationOnce(async (_s?: string, opts?: { limit?: number; offset?: number }) => ({
      approvals: Array.from({ length: 50 }, (_, k) => approvalFixture(k)),
      total: 50,
      limit: opts?.limit ?? PAGE,
      offset: opts?.offset ?? 0,
    }));

    render(<NotificationBell embeddedMode userId="u1" label="通知" />);
    await waitFor(() => expect(screen.getAllByText('审批 #0').length).toBeGreaterThan(0));

    expect(document.querySelector('div[aria-hidden].h-px')).toBeNull();
    expect(approvalsList).toHaveBeenCalledTimes(1);
  });
});
