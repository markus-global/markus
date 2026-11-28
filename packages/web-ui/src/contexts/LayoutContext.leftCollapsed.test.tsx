/**
 * L1/L2 rails 与 L0 应用侧栏是**两个不同的状态**（Owner 2026-11-27）。
 *
 * 曾经的实现把它们当一个：`LayoutContext.leftCollapsed` 既驱动各页面自己的 L1/L2
 * 列表（Team 面板、Work 项目栏），又被 App 镜像进 L0 图标栏 —— 于是「用快捷键展开
 * 页面的 L1」会连带把整个应用侧栏展开。Owner 要求 L0 只认 Markus 图标那一次点击。
 *
 * 这里钉住这条解耦契约的两个可判定面：
 *   ① 页面 L1 默认**展开**，且**不读** L0 的持久化键（重启后 L1 不会继承「收起」）；
 *   ② 页面 L1 的读写**不碰** L0 的持久化键（谁都没法用它当第二写者）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { LayoutProvider, useLayout, type LayoutContextValue } from './LayoutContext.tsx';

/** happy-dom + Node 的实验性 localStorage 会互相抢占 → 自建 stub。 */
function installLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
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

/** L0 应用侧栏（图标栏）的持久化键，由 App.tsx 的 useResizablePanel 拥有。 */
const L0_RAIL_KEY = 'markus_sidebar_c';

describe('LayoutContext · 页面 L1/L2 rails 与 L0 图标栏解耦', () => {
  let layout: LayoutContextValue | null = null;

  function Probe() {
    layout = useLayout();
    return null;
  }

  function mount() {
    layout = null;
    render(
      <LayoutProvider>
        <Probe />
      </LayoutProvider>,
    );
  }

  beforeEach(() => { layout = null; });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('starts the page rails EXPANDED even when the L0 rail was left collapsed', () => {
    installLocalStorage({ [L0_RAIL_KEY]: '1' });
    mount();
    expect(layout!.leftCollapsed).toBe(false);
  });

  it('keeps L0 collapsed while the page rails are collapsed independently', () => {
    const store = installLocalStorage({ [L0_RAIL_KEY]: '1' });
    mount();
    act(() => layout!.setLeftCollapsed(true));
    expect(layout!.leftCollapsed).toBe(true);
    // 收起页面 L1 不是 L0 的事实来源：图标栏保持用户自己那次点击的结果。
    expect(store.get(L0_RAIL_KEY)).toBe('1');
  });

  it('never writes the L0 rail key — there is exactly one writer for it (the logo button)', () => {
    const store = installLocalStorage({ [L0_RAIL_KEY]: '0' });
    mount();
    act(() => layout!.toggleLeftCollapsed()); // 页面 L1：收起
    act(() => layout!.toggleLeftCollapsed()); // 页面 L1：展开
    expect(layout!.leftCollapsed).toBe(false);
    expect(store.get(L0_RAIL_KEY)).toBe('0');
  });
});
