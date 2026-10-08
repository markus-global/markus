/**
 * scrollDebug — 「跳转 / 滚动意图」路径的**可选**诊断开关。
 *
 * 为什么需要它：这条链路（跨会话跳转 → 翻页 → 落位 → 行高惰性测量）的实际时序
 * 只能在真实 Electron 里观察，单测与代码阅读都无法代替。前几轮反复"按推理修"，
 * 代价是来回试错；所以留一条低成本的证据通道。
 *
 * 默认**关闭**（零输出）。开启方式（在 DevTools console 里执行一次）：
 *
 *   localStorage.setItem('markus.scrollDebug', '1')   // 打开
 *   localStorage.removeItem('markus.scrollDebug')     // 关掉
 *
 * 只在关键决策点输出（一次跳转约 10 行），不做逐帧打印，所以不会刷屏、
 * 也不会在关闭时产生任何开销（读一次 localStorage 是常量级）。
 */

const FLAG_KEY = 'markus.scrollDebug';

let cached: boolean | null = null;
/** 记住了标记就复用；`null` = 还没查过（或上一个动作刚刚清掉缓存）。 */
let cacheLoaded = false;

export function scrollDebugEnabled(): boolean {
  if (!cacheLoaded) {
    try {
      cached = typeof localStorage !== 'undefined' && localStorage.getItem(FLAG_KEY) === '1';
    } catch {
      cached = false;
    }
    cacheLoaded = true;
  }
  return cached === true;
}

/** 测试/运行期切换：只影响缓存，不写 localStorage。 */
export function setScrollDebugForTest(enabled: boolean | null): void {
  cached = enabled;
  cacheLoaded = enabled !== null;
}

export function scrollDebug(event: string, data?: Record<string, unknown>): void {
  if (!scrollDebugEnabled()) return;
  // eslint-disable-next-line no-console
  console.info(`[scroll] ${event}`, { t: Math.round(performance.now()), ...(data ?? {}) });
}
