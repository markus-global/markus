import { describe, it, expect, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useWhilePageActive, usePageActive, __livePageSessions } from './usePageActive.ts';
import { PAGE, pageToHash, type PageId } from '../routes.ts';

/**
 * 这套测试守两条不变量：
 *
 *  1. **切页不得让页面组件重渲染**（性能）
 *  2. **激活会话必须收支平衡**（正确性）
 *
 * 第 2 条是补的、也是最关键的一条：上一版这套机制在真机上把切页拖慢 5–10 倍，
 * 而当时的单测是绿的 —— 因为它只断言了「渲染次数不变」和「开始/结束被调用」，
 * 没有断言**任意时刻活着的会话数**。会话泄漏（切走没拆干净）在单测里看不出来，
 * 在真机上就是越切越慢。所以这里直接盯 __livePageSessions()。
 */

function setHash(page: PageId) {
  act(() => {
    window.location.hash = pageToHash(page);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

let renders = 0;
let starts = 0;
let stops = 0;

function Harness({ pageId = PAGE.WORK }: { pageId?: PageId }) {
  renders++;
  useWhilePageActive(pageId, () => {
    starts++;
    return () => { stops++; };
  }, []);
  return <div data-testid="h" />;
}

describe('useWhilePageActive · 切页只启停副作用，不重渲染宿主', () => {
  beforeEach(() => { renders = 0; starts = 0; stops = 0; });

  it('激活时挂载、切走时拆除、切回来时重新挂载', () => {
    setHash(PAGE.WORK);
    render(<Harness />);
    expect(starts).toBe(1);
    setHash(PAGE.HOME);
    expect(stops).toBe(1);
    setHash(PAGE.WORK);
    expect(starts).toBe(2);
  });

  it('切页不触发宿主重渲染 —— 这是省下的那 93ms 的来源', () => {
    setHash(PAGE.WORK);
    render(<Harness />);
    const afterMount = renders;
    for (let i = 0; i < 10; i++) setHash(i % 2 ? PAGE.WORK : PAGE.HOME);
    expect(renders, `切页 10 次后组件渲染了 ${renders} 次`).toBe(afterMount);
  });

  it('【防泄漏】50 次切页后，活着的激活会话数不得增长', () => {
    setHash(PAGE.WORK);
    render(<Harness />);
    const afterMount = __livePageSessions();

    for (let i = 0; i < 50; i++) {
      setHash(i % 2 ? PAGE.WORK : PAGE.HOME);
      // 任意时刻：活着的会话数只能是「挂载时那个」或 0，绝不允许累积
      const live = __livePageSessions();
      expect(live, `第 ${i + 1} 次切换后 leaked ${live - afterMount} 个会话`).toBeLessThanOrEqual(afterMount);
    }
    // 收尾时停在 WORK（偶数次 ⇒ HOME），切回 WORK 后应恰好回到挂载时的数量
    setHash(PAGE.WORK);
    expect(__livePageSessions()).toBe(afterMount);
    expect(starts - stops).toBe(afterMount);
  });

  it('非激活页面挂载时不启动副作用', () => {
    setHash(PAGE.HOME);
    const before = __livePageSessions();
    render(<Harness />);
    expect(starts).toBe(0);
    expect(__livePageSessions()).toBe(before);
  });

  it('卸载时拆除正在运行的副作用，且计数归零', () => {
    setHash(PAGE.WORK);
    const before = __livePageSessions();
    const { unmount } = render(<Harness />);
    expect(__livePageSessions()).toBe(before + 1);
    unmount();
    expect(stops).toBe(1);
    expect(__livePageSessions(), '卸载后必须回到挂载前的数量').toBe(before);
  });

  it('deps 变化时先拆后挂，计数不涨', () => {
    setHash(PAGE.WORK);
    let dep = 0;
    const before = __livePageSessions();
    function DepHarness() {
      useWhilePageActive(PAGE.WORK, () => {
        starts++;
        return () => { stops++; };
      }, [dep]);
      return null;
    }
    const { rerender } = render(<DepHarness />);
    expect(__livePageSessions()).toBe(before + 1);
    for (let i = 0; i < 5; i++) {
      dep = i + 1;
      act(() => { rerender(<DepHarness />); });
      expect(__livePageSessions(), 'deps 变化后计数不应累积').toBe(before + 1);
    }
    expect(starts).toBe(6);   // 首次 + 5 次依赖变化
    expect(stops).toBe(5);
  });
});

describe('对照：usePageActive 会重渲染（只能给小而廉价的组件用）', () => {
  it('记录它的代价：切页会重渲染', () => {
    let n = 0;
    function Cheap() {
      n++;
      usePageActive(PAGE.WORK);
      return null;
    }
    setHash(PAGE.WORK);
    render(<Cheap />);
    const afterMount = n;
    act(() => { window.location.hash = pageToHash(PAGE.HOME); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    act(() => {});
    expect(n).toBeGreaterThan(afterMount);
  });
});
