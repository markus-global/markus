/**
 * 「取数 → 三态」的通用 hook。AgentProfile 的两处站点接线（R9 交付物搜索 /
 * R10 记忆会话消息）用它，作为**唯一实现**。
 *
 * ── 为什么必须抽出来（不是复用洁癖，是判定器的位置问题）──────────────
 * 这两处原来把 `items / loading / loadError` 关在页面组件的闭包里：
 *   `try { const r = await api.x(); setItems(r) } catch { setItems([]); setError(…) }`
 * 于是没有任何测试能到达接缝。评审实测过：把升 error 的那一行删掉，
 * 两个探针与全量 vitest **双双照样绿**（`resourceState` / `ListState` 的原语测试
 * 不渲染这两个站点 —— 两个判定器的覆盖集不重叠）。
 *
 * 形状照 `hooks/useStoreCatalog.ts`：**取数口由调用方注入**，测试可以直接
 * `mockRejectedValue`，断言 `view.error === true && view.empty === false`。
 * 三态判据仍然只有 `readList()` + `listView()` 一处，本文件不新造判据。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { listView, loadingResource, readList, type ListView, type Resource } from '../lib/resourceState.ts';

export interface ProfileRead<T> {
  /** 完整事实（状态 + 内容 + 失败原因）；`items` 只在 `ok` 时是事实 */
  resource: Resource<T>;
  /** 渲染判据：`loading` / `error` / `empty` 三者互斥且都被表达 */
  view: ListView<T>;
  /** 重新取数：失败条上的「重试」只能走这一个入口 */
  reload: () => void;
}

/**
 * `enabled: false` 表示「现在不取数」（例如记忆会话尚未展开）：保持初始
 * `loading` 态且不发请求 —— 不要用它表达「读到 0 条」，那是 `ok` 态的事。
 */
export function useReadResource<T>(
  load: () => Promise<readonly T[]>,
  options: { enabled?: boolean; deps?: readonly unknown[] } = {},
): ProfileRead<T> {
  const { enabled = true, deps = [] } = options;
  const [resource, setResource] = useState<Resource<T>>(loadingResource<T>());
  const [nonce, setNonce] = useState(0);

  // 取数口用 ref 持有：它的身份每次渲染都可能变（内联箭头函数），但那不该重跑取数。
  const loadRef = useRef(load);
  loadRef.current = load;
  // deps 用值序列化当 key：调用方不必保证数组身份稳定。
  const depsKey = JSON.stringify(deps);

  useEffect(() => {
    if (!enabled) {
      setResource(loadingResource<T>());
      return;
    }
    let cancelled = false;
    setResource(loadingResource<T>());
    void (async () => {
      const next = await readList<T>(() => loadRef.current());
      if (!cancelled) setResource(next);
    })();
    return () => { cancelled = true; };
    // `load` 故意不入依赖：它每次渲染都是新函数，靠 loadRef 取最新值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, depsKey, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);

  return { resource, view: listView(resource), reload };
}
