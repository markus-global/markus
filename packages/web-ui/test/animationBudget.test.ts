/**
 * animationBudget 回归护栏。
 *
 * 这个模块是「Team 页 100%+ CPU」P0 故障的修复落点：
 *   - 页面不在屏幕上（visibilityState === 'hidden'）时必须暂停，否则永远运行的 CSS
 *     动画会让主线程每帧做一次全量 style recalc（实测 120 次/秒，量化/合成层提升都无效）。
 *   - 暂停判据只看可见性，**不看焦点**。右栏是 Electron WebContentsView，用户焦点在
 *     app 内任何别处时它的 document 都算「失焦」，而面板始终可见。旧判据把
 *     !hasFocus() 也算进暂停条件 → 面板整个生命周期被冻结（流式环画着但
 *     border-rotate 停在 0deg：“边框没了、内容还在涨”）。见下方 2026-10-08 回归用例。
 *   - tick 定时器在暂停后必须被真正 clearInterval，而不是「不更新属性」——否则
 *     CPU 问题根本没修好（只是看不见了）。
 *
 * 两个测试隔离要点：
 *   1. 模块持有模块级可变状态（installed / tickTimer），所以每个用例都用
 *      vi.resetModules() + 动态 import 拿一个干净实例。
 *   2. 每拿一个新实例都会往同一个 document / window 上再挂一套监听器；vitest 的
 *      DOM 在同一文件内是复用的，旧监听器不会自己消失。因此这里用「记录 + 卸载」
 *      的方式在每个用例结束后摘掉本用例挂上的监听器，否则旧实例的 sync 会被后续
 *      用例的事件触发，导致 setInterval 被多调，产生假阳性/假阴性。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type BudgetModule = typeof import('../src/animationBudget.ts');

const PAUSED_ATTR = 'data-anim-paused';
const TICK_ATTR = 'data-anim-tick';

/** 用一个受控变量驱动 document 的「可见性」与「聚焦」状态。 */
let visState: 'visible' | 'hidden' = 'visible';
let focused = true;

/** 本用例期间被挂到 document / window 上的监听器，用于收尾摘除。 */
let docAddSpy: ReturnType<typeof vi.spyOn>;
let winAddSpy: ReturnType<typeof vi.spyOn>;

function applyEnv(): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visState });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => visState === 'hidden' });
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
}

/** 每个用例都拿一个新的模块实例（模块级 installed / tickTimer 归零）。 */
async function loadModule(): Promise<BudgetModule> {
  vi.resetModules();
  return await import('../src/animationBudget.ts');
}

function tickValue(): number | null {
  const raw = document.documentElement.getAttribute(TICK_ATTR);
  return raw === null ? null : Number(raw);
}

beforeEach(() => {
  visState = 'visible';
  focused = true;
  applyEnv();
  document.documentElement.removeAttribute(PAUSED_ATTR);
  document.documentElement.removeAttribute(TICK_ATTR);

  // 真实计时器会被 tick 用到，统一用 fake timers 避免 250ms 真实定时器在用例之间泄漏。
  vi.useFakeTimers();

  // call-through 的 spies：既保留真实的注册行为（含 options 归一化），又记录挂上了哪些监听器。
  docAddSpy = vi.spyOn(document, 'addEventListener');
  winAddSpy = vi.spyOn(window, 'addEventListener');
});

afterEach(() => {
  // 摘掉本用例挂上的监听器，避免污染后续用例（DOM 在同一文件内是复用的）。
  for (const c of docAddSpy?.mock.calls ?? []) {
    document.removeEventListener(c[0] as never, c[1] as never);
  }
  for (const c of winAddSpy?.mock.calls ?? []) {
    window.removeEventListener(c[0] as never, c[1] as never);
  }
  docAddSpy?.mockRestore();
  winAddSpy?.mockRestore();

  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute(PAUSED_ATTR);
  document.documentElement.removeAttribute(TICK_ATTR);
});

describe('animationBudget — 暂停判定与幂等安装', () => {
  it('installAnimationBudget() 幂等：重复调用只安装一次监听器', async () => {
    const { installAnimationBudget } = await loadModule();

    installAnimationBudget();
    // visibilitychange 在 document 上，pageshow 在 window 上。
    // focus / blur 不再注册 —— 它们答不了「页面是否在屏幕上」，已从判据里删除。
    expect(docAddSpy.mock.calls.filter(c => c[0] === 'visibilitychange')).toHaveLength(1);
    expect(winAddSpy.mock.calls.filter(c => c[0] === 'pageshow')).toHaveLength(1);
    expect(winAddSpy.mock.calls.filter(c => c[0] === 'focus')).toHaveLength(0);
    expect(winAddSpy.mock.calls.filter(c => c[0] === 'blur')).toHaveLength(0);

    const total = docAddSpy.mock.calls.length + winAddSpy.mock.calls.length;

    // 再调两次，监听器数量不能增长。
    installAnimationBudget();
    installAnimationBudget();
    expect(docAddSpy.mock.calls.length + winAddSpy.mock.calls.length).toBe(total);
  });

  it('页面可见：不带 data-anim-paused，且开启 tick', async () => {
    const { installAnimationBudget } = await loadModule();
    installAnimationBudget();

    expect(document.documentElement.hasAttribute(PAUSED_ATTR)).toBe(false);
    expect(tickValue()).toBe(0);
  });

  it('窗口隐藏：带 data-anim-paused 且完全不启动 tick', async () => {
    visState = 'hidden';
    focused = true; // 即使聚焦，隐藏也要暂停
    const { installAnimationBudget } = await loadModule();
    installAnimationBudget();

    expect(document.documentElement.getAttribute(PAUSED_ATTR)).toBe('true');
    expect(tickValue()).toBeNull();
  });

  it('回归 2026-10-08：页面可见但未聚焦 —— 不暂停（右栏 WebContentsView 的常态）', async () => {
    // 右栏是 Electron WebContentsView：用户焦点在 app 内别处时，它一直是「失焦」状态，
    // 但面板完全可见。旧判据把 !hasFocus() 算进暂停条件 → 面板被永久冻结：
    // 流式环的 conic-gradient 照画，border-rotate 却停在 0deg（看着像没有动态边框），
    // 而正文由 React state 驱动照常更新 —— 即「边框没了、内容还在涨」。
    visState = 'visible';
    focused = false;
    const { installAnimationBudget } = await loadModule();
    installAnimationBudget();

    expect(document.documentElement.hasAttribute(PAUSED_ATTR)).toBe(false);
    expect(tickValue()).toBe(0);
  });
});

describe('animationBudget — 各事件触发后状态翻转', () => {
  it('visibilitychange：visible→hidden 暂停，hidden→visible 恢复', async () => {
    const { installAnimationBudget } = await loadModule();
    installAnimationBudget();
    expect(document.documentElement.hasAttribute(PAUSED_ATTR)).toBe(false);

    visState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.documentElement.getAttribute(PAUSED_ATTR)).toBe('true');

    visState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.documentElement.hasAttribute(PAUSED_ATTR)).toBe(false);
    expect(tickValue()).toBe(0);
  });

  it('回归 2026-10-08：blur / focus 不改变暂停状态（焦点不是可见性）', async () => {
    const { installAnimationBudget } = await loadModule();
    installAnimationBudget();
    expect(document.documentElement.hasAttribute(PAUSED_ATTR)).toBe(false);

    // 失焦 —— 页面仍然可见 → 必须继续动。
    focused = false;
    window.dispatchEvent(new Event('blur'));
    expect(document.documentElement.hasAttribute(PAUSED_ATTR)).toBe(false);
    expect(tickValue()).toBe(0);

    // 重新聚焦 —— 状态不变。
    focused = true;
    window.dispatchEvent(new Event('focus'));
    expect(document.documentElement.hasAttribute(PAUSED_ATTR)).toBe(false);
    expect(tickValue()).toBe(0);
  });

  it('pageshow：休眠唤醒后按真实的可见性状态重新纠偏', async () => {
    const { installAnimationBudget } = await loadModule();
    installAnimationBudget();

    // 陈旧状态：属性说 paused（例如睡眠前是隐藏的）。
    visState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(document.documentElement.getAttribute(PAUSED_ATTR)).toBe('true');

    // 唤醒后页面可见 —— pageshow 必须把它拉回未暂停。
    visState = 'visible';
    window.dispatchEvent(new Event('pageshow'));
    expect(document.documentElement.hasAttribute(PAUSED_ATTR)).toBe(false);
    expect(tickValue()).toBe(0);
  });
});

describe('animationBudget — tick 相位循环', () => {
  it('每 250ms 推进一次，相位在 0..7 之间循环（2s 一个周期）', async () => {
    const { installAnimationBudget } = await loadModule();
    installAnimationBudget();
    expect(tickValue()).toBe(0);

    // 8 个 250ms → 完成一个 2s 周期，回到 0。中途相位必须始终落在 0..7。
    const observed: number[] = [];
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(250);
      const v = tickValue();
      expect(v).not.toBeNull();
      expect(v!).toBeGreaterThanOrEqual(0);
      expect(v!).toBeLessThanOrEqual(7);
      observed.push(v!);
    }
    expect(observed).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);

    // 不满一个 250ms 时不应更新。
    vi.advanceTimersByTime(249);
    expect(tickValue()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(tickValue()).toBe(1);
  });

  it('暂停后真正 clearInterval（不只是停止更新属性）', async () => {
    const setSpy = vi.spyOn(window, 'setInterval');
    const clearSpy = vi.spyOn(window, 'clearInterval');
    const { installAnimationBudget } = await loadModule();

    // 只在 install 的那一刻取自己的 timerId —— 用「基线下标」而不是绝对次数，
    // 避免环境自身的 setInterval 噪声把断言打崩。
    const baseline = setSpy.mock.calls.length;
    installAnimationBudget();
    const timerId = setSpy.mock.results[baseline].value;
    expect(setSpy.mock.calls.length).toBe(baseline + 1);

    // 推进到某个非 0 相位，记下来。
    vi.advanceTimersByTime(250);
    const frozen = tickValue();
    expect(frozen).toBe(1);

    // 隐藏窗口 → 必须调用 clearInterval(同一个 id)。
    visState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(clearSpy).toHaveBeenCalledWith(timerId);

    // 关键断言：定时器真的没了 —— 再推进很久属性也不再变。
    vi.advanceTimersByTime(5000);
    expect(tickValue()).toBe(frozen);

    // 恢复后重新起一个定时器（旧的已清），并且相位继续推进而不是卡住。
    visState = 'visible';
    focused = true;
    const beforeResume = setSpy.mock.calls.length;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(setSpy.mock.calls.length).toBeGreaterThan(beforeResume);
    vi.advanceTimersByTime(250);
    expect(tickValue()).toBe((frozen! + 1) % 8);
  });
});

describe('animationBudget — 测试钩子行为', () => {
  it('__setPausedForTest(true) 暂停并停表；__setPausedForTest(false) 恢复', async () => {
    const setSpy = vi.spyOn(window, 'setInterval');
    const clearSpy = vi.spyOn(window, 'clearInterval');
    const { installAnimationBudget, __setPausedForTest } = await loadModule();

    const baseline = setSpy.mock.calls.length;
    installAnimationBudget();
    const timerId = setSpy.mock.results[baseline].value;

    __setPausedForTest(true);
    expect(document.documentElement.getAttribute(PAUSED_ATTR)).toBe('true');
    expect(clearSpy).toHaveBeenCalledWith(timerId);
    vi.advanceTimersByTime(2000);
    expect(tickValue()).toBe(0); // 停表后不再推进

    __setPausedForTest(false);
    expect(document.documentElement.hasAttribute(PAUSED_ATTR)).toBe(false);
    vi.advanceTimersByTime(250);
    expect(tickValue()).toBe(1);
  });

  it('__setTickForTest(phase) 写入相位并对 8 取模', async () => {
    const { __setTickForTest } = await loadModule();

    __setTickForTest(3);
    expect(tickValue()).toBe(3);

    __setTickForTest(10);
    expect(tickValue()).toBe(2); // 10 % 8

    __setTickForTest(8);
    expect(tickValue()).toBe(0); // 8 % 8
  });
});
