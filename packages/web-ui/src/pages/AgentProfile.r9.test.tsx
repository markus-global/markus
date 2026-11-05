/**
 * R9（审计 §8.4）**站点级**接线测试：AgentProfile 交付物搜索取数失败必须是 error，
 * 不能是「0 个交付物」。
 *
 * 为什么必须有这一条（评审第 6/7 轮实测的假绿就是这里）：
 *   把 R9 的计数行闸门 `{!view.error && (` 改成 `{true && (`，探针（静态机检）
 *   看不见、`resourceState` / `ListState` 的原语测试也不渲染这个站点 ——
 *   全部门禁绿灯，而用户又看到「共 0 个交付物」压在「这不等于『这个 Agent
 *   没有任何交付物』」下面。本文件是该站点的判定器：
 *     1. `api.deliverables.search` reject → 「交付物读取失败：…（这不等于…）」+ 重试；
 *     2. 同一时刻**不得**出现空态文案（大字空态「还没有交付物」）；
 *     3. 同一时刻**不得**出现计数行（「0 deliverable(s)」是 R9 的第二种「0」）；
 *     4. 反向守卫：真的读到 0 条 → 出空态文案、且不报读取失败
 *        （否则把「永远报错」焊死也能让 1–3 通过）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '../i18n/index.ts';

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
  win['location'] = { origin: 'http://localhost', hash: '#agents/agent_1' };
  if (typeof win['innerWidth'] !== 'number') win['innerWidth'] = 1024;
  if (typeof win['matchMedia'] !== 'function') {
    win['matchMedia'] = (query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    });
  }
  (globalThis as unknown as { window: unknown }).window = win;
});

const mocks = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realApi = actual['api'] as Record<string, unknown>;
  const api = new Proxy(realApi, {
    get(target, key) {
      // 只替换本卡这一条取数口；其余命名空间保持原样，避免夹具变成整页依赖。
      if (key === 'deliverables') {
        return { ...(target['deliverables'] as object), search: mocks.search };
      }
      return Reflect.get(target, key);
    },
  });
  return {
    ...actual,
    api,
    wsClient: { on: () => () => {}, send: () => {}, readyState: 1 },
  };
});

import { DeliverablesTab } from './AgentProfile.tsx';

/** 与组件同源（同一个 i18n 实例），不受测试环境语言影响。 */
const emptyTitle = () => i18n.t('agent:deliverables.empty');
const emptyHint = () => i18n.t('agent:deliverables.emptyHint');
const countZero = () => i18n.t('agent:deliverables.count', { count: 0 });

beforeEach(async () => {
  await i18n.changeLanguage('en');
  mocks.search.mockReset();
});

describe('R9 AgentProfile 交付物搜索失败 → 三态必须分开', () => {
  it('读失败：错误可见 + 可重试，且不渲染空态文案与「0 个交付物」计数行', async () => {
    mocks.search.mockRejectedValue(new Error('ECONNREFUSED'));

    render(<DeliverablesTab agentId="agent_1" />);

    expect(await screen.findByText(/交付物读取失败/)).toBeTruthy();
    expect(screen.getByText(/这不等于「这个 Agent 没有任何交付物」/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();

    // 空态文案 = 一句断言（「确实一个都没有」）—— 我们并不知道
    expect(screen.queryByText(emptyTitle())).toBeNull();
    expect(screen.queryByText(emptyHint())).toBeNull();
    // R9 的第二种「0」：计数行读的是同一个派生视图（view.error），不得漏过
    expect(screen.queryByText(countZero())).toBeNull();
  });

  it('反向守卫：真读到 0 条 → 出空态文案，且不报读取失败', async () => {
    mocks.search.mockResolvedValue({ results: [], total: 0 });

    render(<DeliverablesTab agentId="agent_1" />);

    expect(await screen.findByText(emptyTitle())).toBeTruthy();
    expect(screen.queryByText(/交付物读取失败/)).toBeNull();
  });
});
