/**
 * R10（审计 §8.4）**站点级**行为测试：记忆「会话」展开后的消息取数失败必须是 error，
 * 不能是一个安静的空会话（「这个会话没有消息」）。
 *
 * 两个判定器，缺一不可（评审第 7 轮点名 R9/R10 是 0 覆盖）：
 *   1. **接线**（`useReadResource`）：取数 reject → `view.error === true` 且
 *      `view.empty === false`。这条咬的是「把失败折成空集合」的回退。
 *   2. **渲染**（`MemorySessionBody`）：error 资源 → 出「会话消息读取失败 + 重试」，
 *      且**不渲染**「这个会话没有消息」。这条咬的是 JSX 分支：删掉 `view.error`
 *      分支（让失败直接落到空态）本文件必红 —— 而静态探针看不见这种改动。
 * 两条都有反向守卫（真的读到 0 条时不得报失败），否则把 error 焊死也能通过。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import i18n from '../i18n/index.ts';
import { errorResource, okResource } from '../lib/resourceState.ts';
import { useReadResource } from '../hooks/useProfileReads.ts';
import { MemorySessionBody, type MemorySessionMessage } from './AgentProfile.tsx';

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

/** 与组件同源（同一个 i18n 实例），不受测试环境语言影响。 */
const noMessagesCopy = () => i18n.t('agent:profilePage.memoryTab.noMessagesInSession');

/** 探针：只把 hook 判出来的那一个状态词打出来 —— 用来咬「取数接线」。 */
function StateProbe({ load }: { load: () => Promise<readonly MemorySessionMessage[]> }) {
  const { view } = useReadResource<MemorySessionMessage>(load, { deps: [] });
  const word = view.error ? 'error' : view.loading ? 'loading' : view.empty ? 'empty' : 'ok';
  return <span data-testid="state">{word}</span>;
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('R10 记忆会话消息取数失败 → 三态必须分开', () => {
  it('接线：取数 reject → state=error，且 empty 不为真（失败 ≠ 空会话）', async () => {
    render(<StateProbe load={() => Promise.reject(new Error('ECONNREFUSED'))} />);

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('error'));
  });

  it('接线反向守卫：真的读到 0 条 → state=empty，不报失败', async () => {
    render(<StateProbe load={async () => []} />);

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('empty'));
  });

  it('渲染：error 态出「会话消息读取失败」+ 重试，且不渲染「这个会话没有消息」', () => {
    render(
      <MemorySessionBody
        resource={errorResource<MemorySessionMessage>(new Error('ECONNREFUSED'))}
        onRetry={() => {}}
      />,
    );

    expect(screen.getByText(/会话消息读取失败/)).toBeTruthy();
    expect(screen.getByText(/这不等于「这个会话没有消息」/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByText(noMessagesCopy())).toBeNull();
  });

  it('渲染反向守卫：真的 0 条 → 出「这个会话没有消息」，不报失败', () => {
    render(<MemorySessionBody resource={okResource<MemorySessionMessage>([])} onRetry={() => {}} />);

    expect(screen.getByText(noMessagesCopy())).toBeTruthy();
    expect(screen.queryByText(/会话消息读取失败/)).toBeNull();
  });
});
