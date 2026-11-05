import { useEffect, useRef, useSyncExternalStore } from 'react';
import { type PageId, getPageFromHash } from '../routes.ts';

let currentPage: PageId = getPageFromHash();
const listeners = new Set<() => void>();

function notifyAll() {
  currentPage = getPageFromHash();
  listeners.forEach(cb => cb());
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', notifyAll);
  window.addEventListener('popstate', notifyAll);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 非响应式读取当前可见页（给事件 / 回调里用，不触发重渲染）。 */
export function getActivePage(): PageId {
  return currentPage;
}

/**
 * 订阅「本页是否可见」。**会让调用组件在每次切页时重渲染。**
 *
 * 只给**小而廉价**的组件用（角标之类）。
 *
 * ⚠️ 页面级大组件不要用：实测 `work → home` 时 React 段 93ms，而同为「进入 Home」
 * 的 `builder → home` 只有 7ms —— 差值就是离场页那一次整树重算，而它的渲染输出里
 * 没有任何一处读这个布尔值（Work 10 处、Team 32 处用法全在 effect 里）。
 */
export function usePageActive(pageId: PageId): boolean {
  return useSyncExternalStore(
    subscribe,
    () => currentPage === pageId,
    () => false,
  );
}

// ── 泄漏检测 ────────────────────────────────────────────────────────────────
// 上一版这套机制在真机上把切页拖慢了 5–10 倍，单测却是绿的 —— 所以这次把
// 「当前有多少个未释放的激活会话」做成可读的事实，而不是靠推断。
let liveSessions = 0;
/** 测试 / 探针用：当前未释放的激活会话数。稳态下应等于「正在运行的 hook 数」。 */
export function __livePageSessions(): number {
  return liveSessions;
}

/**
 * 在「本页可见期间」挂载一组副作用；切走时拆除，切回来时重新挂载。
 *
 * 语义与 `useEffect(() => { if (!isActive) return; ...; return cleanup }, [...deps, isActive])`
 * 一致，但**不产生任何 state 更新** ⇒ 切页不会让宿主组件重渲染，只有这段副作用启停。
 */
export function useWhilePageActive(
  pageId: PageId,
  setup: () => void | (() => void),
  deps: readonly unknown[] = [],
): void {
  // setup 每次渲染都更新，但 effect 只在 deps / 激活状态变化时重跑（与普通
  // useEffect 读最新闭包的行为一致）。不把 setup 放进依赖，避免每次渲染都重挂。
  const setupRef = useRef(setup);
  setupRef.current = setup;

  useEffect(() => {
    let disposed = false;
    let active = false;
    let cleanup: void | (() => void);

    const start = () => {
      if (active || disposed) return;
      active = true;
      liveSessions++;
      cleanup = setupRef.current();
    };
    const stop = () => {
      if (!active) return;
      active = false;
      liveSessions--;
      const fn = cleanup;
      cleanup = undefined;
      if (typeof fn === 'function') fn();
    };

    if (currentPage === pageId) start();
    const unsubscribe = subscribe(() => {
      if (currentPage === pageId) start();
      else stop();
    });

    return () => {
      disposed = true;
      unsubscribe();
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, ...deps]);
}
