/**
 * 频道/群聊消息取数的**三态**契约（审计 §3 事故① 的第二个形态）。
 *
 * 事故原文：`catch { setMessages([]) }` 把「没读到」写成了「这个会话没有消息」，
 * 界面安静地渲染出一个空会话 —— 与历史面板未读数不刷新是同一条谎话。
 *
 * 三条断言（改坏任何一条都应该红）：
 *   1. `api.channels.getMessages` reject → **不得**出现空会话的空态文案，
 *      必须出现可见的「消息读取失败」提示（含「重试」）；
 *   2. WS 重连的 `quiet` 补拉路径（无 spinner）失败时，同样必须升起 error
 *      —— 它失败时界面上不能「什么都没发生」，这是本卡最容易漏的一条；
 *   3. 反向守卫：真的读到 0 条时仍然可以渲染空态（否则把 error 焊死也能让 1 通过）。
 *
 * 为什么不在测试里断言 `messages.length === 0`：「有没有东西」只能由页面自己的
 * 三态判据回答，测试去数数组等于写第二份判据（见 `lib/threadTimeline.ts` 的先例）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// 本仓库 vitest 下 Node 实验性 localStorage 会占住全局（实测 `.clear is not a function`），
// 显式给一个最小实现；同时补齐 api.ts 模块加载期要读的 window 属性。
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  const win = ((globalThis as unknown as { window?: Record<string, unknown> }).window ?? {}) as Record<string, unknown>;
  win['__MARKUS_HUB_BASE_URL__'] = '';
  win['location'] = { origin: 'http://localhost', hash: '#team/d' };
  if (typeof win['innerWidth'] !== 'number') win['innerWidth'] = 1024;
  if (typeof win['matchMedia'] !== 'function') {
    win['matchMedia'] = (query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
  }
  (globalThis as unknown as { window: unknown }).window = win;
});

/**
 * 这一页很大（6000+ 行、几十个取数口）。为了让断言聚焦在**本卡的那条路径**上，
 * 除 `channels.getMessages` 外一律给「读到了 0 条」的空结果 —— 这恰好是页面
 * 认为「什么都没配对」的合法输入。未登记的方法由 Proxy 兜底，页面长出新取数口
 * 时不会因为测试桩而整页炸掉（否则这个文件会变成又一个"维护不起的夹具"）。
 */
const mocks = vi.hoisted(() => {
  const emptyish = () => Object.assign([], {
    agents: [], users: [], humans: [], teams: [], ungrouped: [], chats: [], groupChats: [],
    tasks: [], requirements: [], projects: [], skills: [], workflows: [], deliverables: [],
    messages: [], sessions: [], notifications: [], approvals: [], reports: [], threads: [],
    total: 0, totalCount: 0, unreadCount: 0, page: 1, hasMore: false, totalPages: 1,
  });
  const getMessages = vi.fn(async () => ({ messages: [], hasMore: false }));
  // direct 模式的会话列表取数口。必须能被单独打到 reject：若让它落进 `autoNs()`
  // 的兜底空结果，「读失败」这条路就永远测不到三态中的 error 一态。
  const listByAgent = vi.fn(async () => ({ sessions: [] as unknown[], total: 0, page: 1, hasMore: false }));
  const autoNs = () => new Proxy({}, {
    get: () => vi.fn(async () => emptyish()),
  });
  const api = new Proxy({} as Record<string, unknown>, {
    get(_t, ns) {
      if (ns === 'channels') return { getMessages, list: vi.fn(async () => emptyish()) };
      if (ns === 'sessions') return { listByAgent, list: vi.fn(async () => emptyish()) };
      return autoNs();
    },
  });
  return {
    api,
    getMessages,
    listByAgent,
    // `on` 必须带**真实签名**：写成无参 `vi.fn(() => () => {})` 会让 `mock.calls` 的元素
    // 类型退化成 `[]`，于是测试里取 `c[0]` / 解构 `[, handler]` 全部类型错（实测 5 条
    // TS2493/TS2352）。夹具的签名是契约，不是可选装饰 —— 去掉强转才能让类型重新有用。
    wsClient: { on: vi.fn((_event: string, _handler: (event: unknown) => void) => () => {}), send: vi.fn(), readyState: 1 },
    invalidateApiCache: vi.fn(),
    fetchThreads: vi.fn(async () => ({ threads: [] })),
  };
});

vi.mock('../api.ts', () => ({
  api: mocks.api,
  wsClient: mocks.wsClient,
  invalidateApiCache: mocks.invalidateApiCache,
  fetchThreads: mocks.fetchThreads,
}));

import { TeamPage } from './Team.tsx';

const AUTH = { id: 'user_1', name: 'Owner', email: 'o@example.com', role: 'owner' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // 频道模式：这条路径直接走 `api.channels.getMessages`（DM 走同一条取数口）
  localStorage.setItem('markus_chat_mode', 'channel');
  localStorage.setItem('markus_chat_channel', '#general');
  mocks.getMessages.mockResolvedValue({ messages: [], hasMore: false });
  mocks.listByAgent.mockResolvedValue({ sessions: [], total: 0, page: 1, hasMore: false });
});

describe('频道消息取数失败 → 三态必须分开', () => {
  it('读失败：不渲染空会话，错误可见且可重试', async () => {
    mocks.getMessages.mockRejectedValue(new Error('ECONNRESET'));
    render(<TeamPage authUser={AUTH} />);

    expect(await screen.findByText(/消息读取失败/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/ECONNRESET/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    // 空态文案不得出现：那是「这个会话没有消息」——一个我们并不知道的事实
    expect(screen.queryByText(/还没有消息|暂无消息|还没有任何记录|开始新的对话/)).toBeNull();
  });

  it('反向守卫：真的读到 0 条时，不得报读取失败', async () => {
    render(<TeamPage authUser={AUTH} />);
    await waitFor(() => expect(mocks.getMessages).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/消息读取失败/)).toBeNull());
  });

  it('quiet 补拉失败同样升起 error（WS 重连路径不能静默）', async () => {
    render(<TeamPage authUser={AUTH} />);
    await waitFor(() => expect(mocks.getMessages).toHaveBeenCalled());

    // 页面里 `wsClient.on('connected')` 的处理器会走 quiet 补拉（无 spinner）
    const connected = mocks.wsClient.on.mock.calls.filter(([event]) => event === 'connected');
    expect(connected.length).toBeGreaterThan(0);
    mocks.getMessages.mockRejectedValue(new Error('WS-refetch-failed'));
    // 第一次 connected 是首次连接（页面刻意跳过，正常加载路径已覆盖），
    // 第二次才是"重连"——quiet 补拉在这里发生。
    for (const [, handler] of connected) handler({ type: 'connected' });
    for (const [, handler] of connected) handler({ type: 'connected' });

    expect(await screen.findByText(/消息读取失败/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/WS-refetch-failed/)).toBeTruthy();
  });
});

describe('direct 模式会话列表取数失败 → 必须是 error，不是永久 spinner', () => {
  it('读失败：spinner 必须结束、错误可见、空态文案不出现', async () => {
    localStorage.setItem('markus_chat_mode', 'direct');
    // 这是用户真实会遇到的那条路径：`loadSessions` 的 catch 把失败折成 `null`，
    // 回到调用点的 `if (!s)` 分支。裸 return 时 `loadingChat` 恒为 true，聊天区
    // 就永远转圈 —— 所以本用例同时咬三件事：有 error、没 spinner、没假空态。
    mocks.listByAgent.mockRejectedValue(new Error('SESSIONS_UNREACHABLE'));
    render(<TeamPage authUser={AUTH} initialAgentId="agent_1" />);

    // ① 说失败：`chatError` 横幅可见（`role="alert"` 是本仓错误面的既有标记）
    expect(await screen.findByText(/会话列表读取失败/, {}, { timeout: 5000 })).toBeTruthy();
    // ② 结束 loading：转圈容器（`role="status"`）必须消失。
    //    这条是「永久 spinner」的直接反证 —— 去掉 `setLoadingChat(false)` 即红。
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 5000 });
    // ③ 不得渲染空态：那是「这个 Agent 还没有会话」——一个我们并不知道的事实
    expect(screen.queryByText(/还没有消息|暂无消息|还没有任何记录|开始新的对话/)).toBeNull();
  });
});
