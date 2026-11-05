/**
 * R7（审计 §8.4）**站点级**接线测试：全历史消息搜索（服务端 FTS5）取数失败必须是 error，
 * 不能读成「无命中」。
 *
 * 为什么必须有这一条：`api.messages.search` reject 时旧实现只 `setFindServerResults([])`，
 * 于是「一次都没搜到」与「这次搜索失败了」在界面上完全一样。本文件钉住：
 *   1. 搜索失败 → 面板里出现「历史消息搜索读取失败：…（这不等于「没有匹配的消息」）」+ 重试；
 *   2. 同一时刻**不得**出现任何「无匹配 / 0 条」式结论；
 *   3. 反向守卫：真的 0 命中 → 不报读取失败（否则把「永远报错」焊死也能过 1）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

const mocks = vi.hoisted(() => {
  const emptyish = () => Object.assign([], {
    agents: [], users: [], humans: [], teams: [], ungrouped: [], chats: [], groupChats: [],
    tasks: [], requirements: [], projects: [], skills: [], workflows: [], deliverables: [],
    messages: [], sessions: [], notifications: [], approvals: [], reports: [], threads: [],
    results: [], total: 0, totalCount: 0, unreadCount: 0, page: 1, hasMore: false, totalPages: 1,
  });
  const autoNs = () => new Proxy({}, { get: () => vi.fn(async () => emptyish()) });
  const search = vi.fn();
  const api = new Proxy({} as Record<string, unknown>, {
    get(_t, ns) {
      if (ns === 'sessions') {
        return {
          getMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
          listByAgent: vi.fn(async () => ({
            sessions: [{ id: SESSION_ID, agentId: AGENT_ID, title: 'T', messageCount: 0, updatedAt: new Date().toISOString(), isMain: true }],
            total: 1, page: 1, hasMore: false,
          })),
          list: vi.fn(async () => emptyish()),
        };
      }
      if (ns === 'agents') {
        return {
          list: vi.fn(async () => ({
            agents: [{ id: AGENT_ID, name: 'Alpha', role: 'r', status: 'idle', skills: [], createdAt: new Date().toISOString() }],
          })),
          get: vi.fn(async () => ({ agent: null })),
          roleStatus: vi.fn(async () => null),
        };
      }
      if (ns === 'messages') return { ...autoNs(), search };
      return autoNs();
    },
  });
  return {
    api,
    search,
    wsClient: { on: vi.fn(() => () => {}), send: vi.fn(), readyState: 1 },
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
});

/** 打开「在会话中查找」面板，并往它的输入框里打字（该面板的 input 是唯一的 INPUT 角色）。 */
function typeInFindBar(text: string) {
  fireEvent.click(screen.getByTestId('find-in-conversation-btn'));
  const input = screen.getAllByRole('textbox').find(el => el.tagName === 'INPUT');
  if (!input) throw new Error('find-in-conversation input not found');
  fireEvent.change(input, { target: { value: text } });
}

describe('R7 历史消息搜索失败 → 三态必须分开', () => {
  it('搜索失败：错误可见 + 可重试，且**不冒充「没有匹配的消息」**', async () => {
    mocks.search.mockRejectedValue(new Error('FTS5 unavailable'));
    render(<TeamPage authUser={AUTH} />);

    typeInFindBar('hello');

    expect(await screen.findByText(/历史消息搜索读取失败/, {}, { timeout: 5000 })).toBeTruthy();
    // 「这不等于「没有匹配的消息」」是错误条必须说出的那句 —— 它存在即证明
    // 界面没有把这次失败当成「无命中」结论。
    expect(screen.getByText(/这不等于「没有匹配的消息」/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('反向守卫：真 0 命中 → 不报读取失败', async () => {
    mocks.search.mockResolvedValue({ results: [] });
    render(<TeamPage authUser={AUTH} />);

    typeInFindBar('hello');

    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    expect(screen.queryByText(/历史消息搜索读取失败/)).toBeNull();
  });
});
