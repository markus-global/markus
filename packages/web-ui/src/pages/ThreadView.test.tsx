import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * 全局流页的**定位**测试（B4 判据 3）。
 *
 * 这一页被降级为「检索一条流」，所以断言分两层：
 *   ① 文案层：首屏说的是「搜索一条流」，页面上不出现「全部流 / 目录 / 所有流」这类目录语义；
 *   ② 行为层：空查询**不渲染任何流**；输入关键词命中标题；输入 ref 走按 ref 的直解。
 *
 * 为什么必须有它：把页面改回「列表主视图」不会让任何代码报错，只会悄悄退回旧心智，
 * 而用户看到的差别（多两次点击、每次重新定位）没有任何东西会拦住。这组断言就是那个闸。
 *
 * 【为什么按结构标记查，而不是按文本 find】同一个标题在检索结果行与时间线头部**都会出现**，
 * 纯文本查找的结局取决于两处谁先挂载：只挂上一处时 findByText 绿，两处都挂上时它抛
 * "Found multiple elements"。这曾让本文件 1/5 概率变红（评审复现），而变红的原因与
 * 行为无关 —— 那正是本卡要防的「顺带变红」陷阱。所以结果行带 `data-thread-row`、
 * 时间线头部标题带 `data-thread-title`，断言各查各的，与时序无关。
 */
// 本页靠 `markus_nav_threadRef` 接收从 Inbox 传来的 ref。
// happy-dom 里的 `localStorage` 在本仓库的 vitest 环境下不可靠（实测 `getItem is not a function`：
// Node 实验性 localStorage 先占了全局），所以显式给一个最小实现 —— 页面看到的行为不变。
const ls = vi.hoisted(() => {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = stub;
  return stub;
});

const apiMocks = vi.hoisted(() => ({
  fetchThreads: vi.fn(),
  fetchThreadByRef: vi.fn(),
  fetchThreadEvents: vi.fn(),
  fetchThreadDispositions: vi.fn(),
}));

vi.mock('../api.ts', () => apiMocks);
// navBus 会往 localStorage 写参数并派发事件 —— 这里只要它不炸即可
vi.mock('../navBus.ts', () => ({ navBus: { navigate: vi.fn(), setHandler: vi.fn() } }));

import { ThreadViewPage } from './ThreadView.tsx';

const ROW = {
  id: 'tsk_a',
  ref: 'tsk_a',
  ownerAgent: 'agt_cto',
  ownerSession: null,
  lastActivity: Date.parse('2026-11-03T10:00:00Z'),
  stage: 'person:review',
  stageRank: 2,
  stageBasis: 'partial' as const,
  missingFacts: [],
  taskStatus: 'review',
  title: '修登录超时',
  detail: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  ls.clear();
  apiMocks.fetchThreads.mockResolvedValue({ threads: [ROW, { ...ROW, id: 'tsk_b', ref: 'tsk_b', title: '支付对账' }] });
  // 按 ref 读：标题要与该 ref 对应，否则「时间线头部」会把另一个对象的标题带到当前选中项上
  apiMocks.fetchThreadByRef.mockImplementation(async (ref: string) => ({
    thread: { ...ROW, id: ref, ref, title: ref === 'tsk_b' ? '支付对账' : '修登录超时' },
  }));
  apiMocks.fetchThreadEvents.mockResolvedValue({ events: [] });
  apiMocks.fetchThreadDispositions.mockResolvedValue({ dispositions: [] });
});

describe('ThreadView — 全局页是「搜索一条流」，不是目录', () => {
  it('首屏文案是检索语义，且不含目录语义', async () => {
    render(<ThreadViewPage />);

    expect(screen.getByRole('heading', { name: '搜索一条流' })).toBeTruthy();
    expect(screen.getByLabelText('搜索一条流')).toBeTruthy();
    expect(screen.getByText(/这一页是/)).toBeTruthy();

    const text = document.body.textContent ?? '';
    for (const word of ['全部流', '所有流', '目录视图', '全部 Thread']) {
      expect(text).not.toContain(word);
    }
    // 空查询：一条流都不渲染（检索面的定义）。按结构标记查 —— 候选集已加载但不得上屏。
    await waitFor(() => expect(apiMocks.fetchThreads).toHaveBeenCalled());
    expect(document.querySelectorAll('[data-thread-row]')).toHaveLength(0);
    expect(screen.queryByText('修登录超时')).toBeNull();
    expect(screen.queryByText('支付对账')).toBeNull();
  });

  it('输入关键词 → 在候选流里筛出命中的那一条', async () => {
    render(<ThreadViewPage />);
    await waitFor(() => expect(apiMocks.fetchThreads).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('搜索一条流'), { target: { value: '支付' } });

    const rows = await waitFor(() => {
      const els = [...document.querySelectorAll<HTMLElement>('[data-thread-row]')];
      if (els.length === 0) throw new Error('yet no result row');
      return els;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-thread-row')).toBe('tsk_b');
    expect(rows[0]!.textContent).toContain('支付对账');
    expect(document.querySelector('[data-thread-row="tsk_a"]')).toBeNull();
  });

  /**
   * 事故①（审计 §3）：「还没有任何记录」在首帧闪现。
   *
   * 旧判定只看 `results.length === 0`，而请求**飞行中** `results` 也是空数组 —— 于是刚
   * 输入 ref 的那一帧就已经在说「这条流还没有任何记录」，然后才变成真内容。
   *
   * 两个方向都要钉：还没读到说在读；读失败说读失败。两个方向都禁止说「没有」。
   */
  it('ref 直解还在读 → 说在读，不得说「还没有任何记录」（事故①首帧闪现）', async () => {
    apiMocks.fetchThreadByRef.mockImplementation(() => new Promise(() => { /* 永不落地 */ }));

    render(<ThreadViewPage />);
    await waitFor(() => expect(apiMocks.fetchThreads).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('搜索一条流'), { target: { value: 'tsk_slow' } });

    // 首帧（effect 还没落地）：不得出现空态文案。
    expect(screen.queryByText(/还没有任何记录/)).toBeNull();
    expect(screen.getByText(/正在读取这条流/)).toBeTruthy();
  });

  it('ref 直解读失败 → 说读失败，不得说「还没有任何记录」', async () => {
    apiMocks.fetchThreadByRef.mockRejectedValue(new Error('boom'));

    render(<ThreadViewPage />);
    await waitFor(() => expect(apiMocks.fetchThreads).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('搜索一条流'), { target: { value: 'tsk_dead' } });

    expect(await screen.findByText(/按 ref 读取失败/)).toBeTruthy();
    expect(screen.queryByText(/还没有任何记录/)).toBeNull();
  });

  it('候选语料读失败时，关键词模式不得说「没有命中的流」（那是没读到，不是没命中）', async () => {
    apiMocks.fetchThreads.mockRejectedValue(new Error('list down'));

    render(<ThreadViewPage />);
    expect(await screen.findByText(/候选流读取失败/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('搜索一条流'), { target: { value: '支付' } });

    await waitFor(() => expect(screen.getByText(/候选流读取失败/)).toBeTruthy());
    expect(screen.queryByText(/没有标题或 ref 命中的流/)).toBeNull();
  });

  it('输入 ref → 走按 ref 的直解（列表里没有这条流也能打开）', async () => {
    render(<ThreadViewPage />);
    await waitFor(() => expect(apiMocks.fetchThreads).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('搜索一条流'), { target: { value: 'tsk_not_in_list' } });

    await waitFor(() => expect(apiMocks.fetchThreadByRef).toHaveBeenCalledWith('tsk_not_in_list'));

    // 两件事分开断言，各自指名道姓：
    //   ① 检索结果行：ref 不在候选集里也能造出一行（直解路径）；
    //   ② 时间线头部：标题来自**按 ref 的读取面**（不是列表行里的那个标题）。
    const row = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-thread-row="tsk_not_in_list"]');
      if (!el) throw new Error('ref-direct row not rendered');
      return el;
    });
    expect(row.textContent).toContain('修登录超时');

    const headerTitle = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-thread-ref="tsk_not_in_list"] [data-thread-title]',
      );
      if (!el) throw new Error('timeline header title not rendered');
      return el;
    });
    expect(headerTitle.textContent).toContain('修登录超时');
  });
});
