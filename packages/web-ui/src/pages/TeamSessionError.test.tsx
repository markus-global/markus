/**
 * R6（审计 §8.4）：**会话消息**（direct 模式 DB transcript）取数失败必须是 error，
 * 不能是一个安静的空会话。
 *
 * 旧实现在取数层 `catch { setMessages([]) }` —— 用户看到的就是「这个会话没有消息」
 * 这句**断言**，而我们其实一次都没读到。本卡把失败落成 `ConvPhase = 'error'`
 * 并由 Team 渲染可见的错误条 + 重试。
 *
 * 会咬人的判据（改回旧实现即红）：
 *   1. `api.sessions.getMessages` reject → 出现「会话消息读取失败：…（这不等于…）」；
 *   2. 空态问候语**不得**出现（那是我们并不知道的事实）；
 *   3. 反向守卫：真的读到 0 条时不报错（否则把 error 焊死也能让 1 通过）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

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

const AGENT_ID = 'agent_1';
const SESSION_ID = 'sess_1';

/**
 * 只打本卡这条路径的取数口：`sessions.getMessages`。其余一切返回「读到了 0 条」
 * （页面认为「什么都没配对」的合法输入），避免夹具变成整页依赖。
 */
const mocks = vi.hoisted(() => {
  const emptyish = () => Object.assign([], {
    agents: [], users: [], humans: [], teams: [], ungrouped: [], chats: [], groupChats: [],
    tasks: [], requirements: [], projects: [], skills: [], workflows: [], deliverables: [],
    messages: [], sessions: [], notifications: [], approvals: [], reports: [], threads: [],
    total: 0, totalCount: 0, unreadCount: 0, page: 1, hasMore: false, totalPages: 1,
  });
  const getMessages = vi.fn(async () => ({ messages: [] as unknown[], hasMore: false }));
  const listByAgent = vi.fn(async () => ({
    sessions: [{ id: 'sess_1', agentId: 'agent_1', title: 'T', messageCount: 0, updatedAt: new Date().toISOString(), isMain: true }] as unknown[],
    total: 1, page: 1, hasMore: false,
  }));
  const agentsList = vi.fn(async () => ({
    agents: [{ id: 'agent_1', name: 'Alpha', role: 'r', status: 'idle', skills: [], createdAt: new Date().toISOString() }] as unknown[],
  }));
  const autoNs = () => new Proxy({}, { get: () => vi.fn(async () => emptyish()) });
  const api = new Proxy({} as Record<string, unknown>, {
    get(_t, ns) {
      if (ns === 'sessions') return { getMessages, listByAgent, list: vi.fn(async () => emptyish()) };
      if (ns === 'agents') return { list: agentsList, get: vi.fn(async () => ({ agent: null })), roleStatus: vi.fn(async () => null) };
      return autoNs();
    },
  });
  return {
    api,
    getMessages,
    listByAgent,
    agentsList,
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
  localStorage.setItem('markus_chat_mode', 'direct');
  localStorage.setItem('markus_chat_agent', AGENT_ID);
  localStorage.setItem(`markus_active_session_${AGENT_ID}`, SESSION_ID);
  mocks.getMessages.mockResolvedValue({ messages: [], hasMore: false });
});

describe('R6 会话消息取数失败 → 三态必须分开', () => {
  it('读失败：错误可见 + 可重试，且**不渲染空会话问候语**', async () => {
    mocks.getMessages.mockRejectedValue(new Error('ECONNREFUSED'));
    render(<TeamPage authUser={AUTH} />);

    expect(await screen.findByText(/会话消息读取失败/, {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/这不等于「这个会话没有消息」/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    // 空态问候语 = 「这个会话没有消息」这句断言 —— 我们并不知道
    expect(screen.queryByText(/开始新的对话|还没有消息|暂无消息/)).toBeNull();
  });

  it('反向守卫：真的读到 0 条时不得报读取失败', async () => {
    render(<TeamPage authUser={AUTH} />);
    await waitFor(() => expect(mocks.getMessages).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/会话消息读取失败/)).toBeNull());
  });
});
