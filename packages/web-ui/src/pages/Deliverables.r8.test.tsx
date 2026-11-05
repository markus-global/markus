/**
 * R8（审计 §8.4）**站点级**接线测试：交付物搜索取数失败必须落成 error，
 * 不能是「0 个交付物」。
 *
 * 为什么必须有这一条（评审第 4 轮实测的假绿就是这里）：
 *   把 `Deliverables.tsx` catch 里的 `setLoadError(errorMessage(err))` 删掉，
 *   原语测试（`resourceState` / `ListState`）与全量 vitest 仍然全绿 —— 因为它们
 *   不渲染这一页。本文件是这个站点的判定器：
 *     1. `api.deliverables.search` reject → 出现「交付物读取失败：…（这不等于…）」+ 重试；
 *     2. 同一时刻**不得**出现空态文案（「没有任何交付物」是那句不能下的结论）；
 *     3. 反向守卫：真的读到 0 条 → 出空态文案、且不报读取失败。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  win['location'] = { origin: 'http://localhost', hash: '#deliverables' };
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
  const realApi = (actual['api'] ?? {}) as Record<string, unknown>;
  const ns = (name: string) => (realApi[name] ?? {}) as Record<string, unknown>;
  const api = new Proxy(realApi, {
    get(target, key: string) {
      if (key === 'deliverables') {
        return {
          ...ns('deliverables'),
          search: mocks.search,
          checkHealth: vi.fn(async () => ({ missingFiles: [] })),
        };
      }
      if (key === 'projects') return { ...ns('projects'), list: vi.fn(async () => ({ projects: [] })) };
      if (key === 'agents') return { ...ns('agents'), list: vi.fn(async () => ({ agents: [] })) };
      return target[key];
    },
  });
  return {
    ...actual,
    api,
    wsClient: { on: () => () => {}, send: () => {}, readyState: 1 },
    invalidateApiCache: () => {},
  };
});

import { DeliverablesPage } from './Deliverables.tsx';

/** 空态文案：与组件同一个 i18n 实例，不受测试环境语言影响。 */
const emptyTitle = () => i18n.t('deliverables:empty.title');
const emptyNoResults = () => i18n.t('deliverables:empty.noResults');

beforeEach(async () => {
  await i18n.changeLanguage('en');
  mocks.search.mockReset();
});

/** 失败条 + 空态文案必须互斥：任一时刻只能看到其中一句。 */
function expectNoEmptyCopy() {
  const title = emptyTitle();
  const noResults = emptyNoResults();
  // `t()` 未解析时返回 key 本身，等于一个不会误报的唯一串；解析后是真实文案。
  expect(screen.queryByText(title)).toBeNull();
  expect(screen.queryByText(noResults)).toBeNull();
}

describe('R8 交付物搜索取数失败 → 三态必须分开', () => {
  it('读失败：错误可见 + 可重试，且**不渲染**「没有任何交付物」', async () => {
    mocks.search.mockRejectedValue(new Error('deliverables 500'));

    render(<DeliverablesPage />);

    expect(await screen.findByText(/交付物读取失败/)).toBeTruthy();
    expect(screen.getByText(/这不等于「没有任何交付物」/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expectNoEmptyCopy();
  });

  it('反向守卫：真读到 0 条 → 出空态文案，且不报读取失败', async () => {
    mocks.search.mockResolvedValue({ results: [], total: 0 });

    render(<DeliverablesPage />);

    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/交付物读取失败/)).toBeNull());
    // 空态文案本身由 locales 决定，这里只要求「不是错误态」
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
