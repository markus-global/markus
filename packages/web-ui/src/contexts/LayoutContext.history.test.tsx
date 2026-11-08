/**
 * 写入点守卫：`openRightPanel` 打开 file / deliverable 时，必须留下一条历史。
 *
 * 为什么盯这一处：卡面要求的「最近访问纳入本地文件与产出物」在生产代码里只有一个
 * 落点 —— 面板打开函数。把它写在任一调用方（聊天文件链接 / 产出物卡片 / 实体卡 /
 * 预览内 markdown 链接）都会漏掉其它入口；反过来，一旦有人删掉这一行，
 * 上面 lib 层的纯函数测试**依然全绿**（它们只验证「记录函数本身对」）。
 * 所以这里挂真实 LayoutProvider 走一次真实打开动作，直接读持久化历史。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { LayoutProvider, useLayout, type LayoutContextValue } from './LayoutContext.tsx';
import { loadBrowserHistory } from '../lib/browserHistory.ts';
import type { DeliverableInfo } from '../api.ts';

/** happy-dom + Node 的实验性 localStorage 会互相抢占 → 自建 stub。 */
function installLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  });
  return store;
}

function deliverable(over: Partial<DeliverableInfo> = {}): DeliverableInfo {
  return {
    id: 'dlv_42',
    type: 'file',
    title: '审计报告',
    summary: 'summary',
    reference: '/out/audit.md',
    tags: [],
    status: 'active',
    accessCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const STORAGE_KEY = 'markus:browser-history';

describe('LayoutContext · right-panel visit history', () => {
  let layout: LayoutContextValue | null = null;

  function Probe() {
    layout = useLayout();
    return null;
  }

  beforeEach(() => {
    installLocalStorage();
    localStorage.setItem(STORAGE_KEY, '[]');
    layout = null;
    render(
      <LayoutProvider>
        <Probe />
      </LayoutProvider>,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records a file open (and bumps the same target on re-open)', () => {
    act(() => layout!.openRightPanel({ kind: 'file', path: '/Users/me/report.md', title: 'report.md' }));
    expect(loadBrowserHistory()).toHaveLength(1);
    expect(loadBrowserHistory()[0]).toMatchObject({
      kind: 'file',
      target: '/Users/me/report.md',
      title: 'report.md',
      visitCount: 1,
    });

    // Same file again (tab already open) → still one row, recency refreshed.
    act(() => layout!.openRightPanel({ kind: 'file', path: '/Users/me/report.md', title: 'report.md' }));
    const history = loadBrowserHistory();
    expect(history).toHaveLength(1);
    expect(history[0].visitCount).toBe(2);
  });

  it('records a deliverable keyed by its id, with the reference as location', () => {
    act(() => layout!.openRightPanel({ kind: 'deliverable', deliverable: deliverable() }));
    expect(loadBrowserHistory()[0]).toMatchObject({
      kind: 'deliverable',
      target: 'dlv_42',
      title: '审计报告',
      location: '/out/audit.md',
    });
  });

  it('does not write url or terminal opens (url rows are written at navigation time)', () => {
    act(() => layout!.openRightPanel({ kind: 'url', url: 'https://a.example.com', title: 'A' }));
    act(() => layout!.openRightPanel({ kind: 'terminal', terminalId: 'tty_test_1' }));
    expect(loadBrowserHistory()).toEqual([]);
  });
});
