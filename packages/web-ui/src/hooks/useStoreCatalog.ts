/**
 * 模板库（Hub 资产 + 本地模板）的**唯一取数实现**。
 *
 * ── 为什么单独一个 hook ────────────────────────────────────────────────
 * `TeamsStore.tsx`（团队）与 `TemplateMarketplace.tsx`（角色）长期各写一份
 * 完全相同的 load()：两条腿并行取数，`catch { setTemplates([]); setHubItems([]) }`。
 * 同一语义的第二份实现必然漂移 —— 上一轮只有一处被修成三态、另一处继续撒谎，
 * 就是这种结构的必然结果。合并成一处之后，**改一处两页同时生效**。
 *
 * 两条腿**各自独立**成态（一条腿失败不得把另一条腿的数据清空），
 * 聚合态交给 `combineSources()`（与时间线视图同一实现）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, hubApi, type HubItem } from '../api.ts';
import { readList, combineSources, loadingResource, type Resource, type CombinedSources } from '../lib/resourceState.ts';
import { mergeHighlightedHubItem } from '../lib/hubDeepLink.ts';

export interface StoreCatalog<T> {
  /** Hub 侧（远端社区资产） */
  hub: Resource<HubItem>;
  /** 本地模板侧 */
  templates: Resource<T>;
  /** 两条腿的聚合态：任一在读 → loading；否则任一失败 → error */
  sources: CombinedSources;
  /** 重新取数（失败条上的「重试」只走这一个入口） */
  reload: () => void;
}

/**
 * `catalogType` = 这一页在看哪类资产（团队 / 角色）。
 *
 * 注意两条腿的**失败互不影响**：Hub 挂了仍然显示本地模板（并明确说 Hub 读不到），
 * 反之亦然 —— 这是「部分可用优于全空」的具体实现。
 */
export function useStoreCatalog<T>(options: {
  /** Hub 资产类型 */
  catalogType: 'team' | 'agent';
  /** 搜索词（空 = 全量） */
  search: string;
  /** 从 Hub 深链进来时高亮的那一条（找不到时回调 onHighlightDone） */
  highlightItemId?: string | null | undefined;
  onHighlightDone?: (() => void) | undefined;
  /** 本地模板取数口（两个页面各自的接口不同，由调用方注入） */
  loadTemplates: (search: string) => Promise<readonly T[]>;
  /**
   * Hub 预取缓存（页面进入前预热的列表）。只在无搜索词时有意义；
   * 返回 null 表示没命中预取，走真实请求。
   */
  takeHubPrefetch?: (() => Promise<readonly HubItem[] | null>) | undefined;
}): StoreCatalog<T> {
  const { catalogType, search, highlightItemId, onHighlightDone, loadTemplates, takeHubPrefetch } = options;
  const [hub, setHub] = useState<Resource<HubItem>>(loadingResource<HubItem>());
  const [templates, setTemplates] = useState<Resource<T>>(loadingResource<T>());
  const [nonce, setNonce] = useState(0);

  // 回调/参数用 ref 持有：它们变化不应重跑取数（否则父组件每渲染一次就多打一轮请求）。
  const cbRef = useRef({ highlightItemId, onHighlightDone, loadTemplates, takeHubPrefetch });
  cbRef.current = { highlightItemId, onHighlightDone, loadTemplates, takeHubPrefetch };

  useEffect(() => {
    let cancelled = false;
    setHub(loadingResource<HubItem>());
    setTemplates(loadingResource<T>());

    void (async () => {
      // 两条腿**并行且各自成态**：任意一条失败只影响自己那一格。
      const hubPromise = (async (): Promise<Resource<HubItem>> => {
        const r = await readList<HubItem>(async () => {
          const prefetched = !search ? (await cbRef.current.takeHubPrefetch?.()) ?? null : null;
          if (prefetched) return prefetched;
          const res = await hubApi.search({ type: catalogType, q: search, limit: 50 });
          return res.items ?? [];
        });
        if (r.state !== 'ok') return r;
        const merged = await mergeHighlightedHubItem([...r.items], cbRef.current.highlightItemId ?? null);
        if (merged.missing) cbRef.current.onHighlightDone?.();
        return { state: 'ok', items: merged.items, error: null };
      })();

      const tplPromise = readList<T>(() => cbRef.current.loadTemplates(search));

      const [hubRes, tplRes] = await Promise.all([hubPromise, tplPromise]);
      if (cancelled) return;
      setHub(hubRes);
      setTemplates(tplRes);
    })();

    return () => { cancelled = true; };
  }, [catalogType, search, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);

  const sources = combineSources([
    { label: 'Hub 资产', state: hub.state },
    { label: '本地模板', state: templates.state },
  ]);

  return { hub, templates, sources, reload };
}

/** 模板列表型取数口的默认实现之一：团队模板（TeamsStore）。 */
export function loadTeamTemplates(search: string) {
  return api.teamTemplates.list(search || undefined).then(r => r.templates ?? []);
}
