/**
 * 全局流页 —— **检索**，不是主视图（B4）。
 *
 * 为什么改定位：Thread 是「视角」不是对象，视角的主入口应该长在**被看的那个对象**上
 * —— 任务详情 / 票据详情 / agent 详情各自就地打开（契约 Q2「这份工作属于哪条上下文」、
 * Q4「删除不赚回注意力的东西」）。把这一页保留成「全部流的目录」，等于让人为了看一条流
 * 先离开他正在看的东西，再去一堆流里找它：多两次点击，而且每次都要重新定位自己。
 *
 * 所以这里只做两件事：
 *   ① 输入一个 ref（`tsk_…` / `tkt_…` / `agent:…` / `gh:o/r`）→ **直接解析**成那条流，
 *      即使它不在任何列表里（列表只是检索语料，不是权限边界）；
 *   ② 输入关键词 → 在候选流里按标题 / ref 过滤。
 *
 * 空查询**不列任何流**：没有查询就没有结果 —— 这是检索面的定义，也是它与目录页的分界线。
 *
 * 渲染节点只有一份实现（`components/threadTimelineNodes.tsx`），本页与就地打开的面板共用。
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchThreadByRef, fetchThreads } from '../api.ts';
import type { ThreadAPI } from '../api.ts';
import { orderTodos } from '../lib/todoOrder.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { looksLikeRef, matchesThreadQuery } from '../lib/threadSearch.ts';
import { refDisplay, stageLabel, stageTone, waitPhrase } from '../lib/threadPresentation.ts';
import { entityNavTarget } from '../lib/threadNav.ts';
import { ThreadTimeline } from '../components/ThreadTimeline.tsx';

export function ThreadViewPage() {
  const [query, setQuery] = useState('');
  /** 检索语料：候选流（不是「主视图数据」）。只取一次。 */
  const [candidates, setCandidates] = useState<ThreadAPI[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  /** ref 直解的结果：按 ref 读，与候选集无关。 */
  const [direct, setDirect] = useState<ThreadAPI | null>(null);
  const [directError, setDirectError] = useState<string | null>(null);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);

  const q = query.trim();
  const asRef = looksLikeRef(q);

  useEffect(() => {
    let alive = true;
    fetchThreads()
      .then(r => { if (alive) { setCandidates(r.threads ?? []); setListError(null); } })
      .catch(e => { if (alive) setListError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  // ref 直解：只给 ref 就够（同一读取面，任务详情/票据详情/agent 详情也用它）
  useEffect(() => {
    if (!asRef) { setDirect(null); setDirectError(null); return; }
    let alive = true;
    fetchThreadByRef(q)
      .then(r => { if (alive) { setDirect(r.thread); setDirectError(null); } })
      .catch(e => { if (alive) { setDirect(null); setDirectError(e instanceof Error ? e.message : String(e)); } });
    return () => { alive = false; };
  }, [q, asRef]);

  // 从「等你处理」详情里点「看这条流的来龙去脉」进来时，把 ref 填进检索框。
  //
  // 为什么监听事件而不是挂载时读一次：App 会保留已挂载的页面（mountedPages），
  // 第二次进本页**组件不会重新挂载** —— 只跑一次的 effect 会让参数永远没被消费。
  // 交接机制与 openTask / installItem 同一套（`markus_nav_*`），不另造一种。
  useEffect(() => {
    const consume = () => {
      const wantRef = localStorage.getItem('markus_nav_threadRef');
      if (!wantRef) return;
      localStorage.removeItem('markus_nav_threadRef'); // 读完即清，避免陈旧跳转
      setQuery(wantRef);
      setSelectedRef(wantRef);
    };
    consume();
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ page?: string }>).detail;
      if (detail?.page === PAGE.THREAD) consume();
    };
    window.addEventListener('markus:navigate', onNav);
    return () => window.removeEventListener('markus:navigate', onNav);
  }, []);

  const results = useMemo(() => {
    if (!q) return [];
    if (asRef) return direct ? [direct] : [];
    return candidates.filter(t => matchesThreadQuery(t, q));
  }, [q, asRef, direct, candidates]);

  const selected = results.find(t => t.ref === selectedRef) ?? results[0] ?? null;
  const now = Date.now();

  return (
    // `flex-1 min-h-0 overflow-auto` 是滚动的前提：App 的 <main> 是 overflow-hidden，
    // 页面自己不声明滚动区 → 超出视口的内容被裁掉且滚不动（Owner 实测「没法正常滚动」）。
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-3">
          <button
            onClick={() => navBus.navigate(PAGE.HOME)}
            className="mb-2 flex items-center gap-1 rounded-lg px-1.5 py-1 -ml-1.5 text-[11px] font-medium text-fg-tertiary transition-colors hover:bg-surface-overlay hover:text-fg-primary"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            概览
          </button>
          <h1 className="text-xl font-semibold text-fg-primary">搜索一条流</h1>
          <p className="mt-1 text-sm text-fg-secondary">
            来龙去脉是<b>视角</b>：任务 / 票据 / agent 详情页就地打开。这里按 ref 或关键词检索一条流。
          </p>
        </header>

        <div className="mb-3">
          <input
            value={query}
            onChange={e => { setQuery(e.target.value); setSelectedRef(null); }}
            placeholder="输入 ref（tsk_… / tkt_… / agent:…）或标题关键词"
            aria-label="搜索一条流"
            className="w-full rounded-lg border border-border-subtle bg-surface-secondary px-3 py-2 text-sm text-fg-primary placeholder:text-fg-muted focus:border-selected-border focus:outline-none"
          />
          {asRef && directError && (
            <p className="mt-1.5 text-[11px] text-rose-600">按 ref 读取失败：{directError}</p>
          )}
        </div>

        {listError && !asRef && (
          <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-600">
            候选流读取失败：{listError}（按 ref 直接检索仍然可用）
          </div>
        )}

        {/* 空查询：不列任何流。检索面没有「默认列表」。 */}
        {!q && (
          <div className="rounded-lg border border-border-subtle bg-surface-secondary p-6 text-sm text-fg-secondary">
            没有查询就没有结果 —— 这一页是<b>检索</b>，不是目录。
            <span className="mt-1 block text-xs text-fg-tertiary">
              看某件事的来龙去脉，去它自己的页面：任务详情、票据详情、agent 详情，各自就地展开。
            </span>
          </div>
        )}

        {q && results.length === 0 && !directError && (
          <div className="rounded-lg border border-border-subtle bg-surface-secondary p-6 text-sm text-fg-secondary">
            {asRef ? '这条流还没有任何记录（也没有头部事实可读）。' : `没有标题或 ref 命中的流：${q}`}
          </div>
        )}

        {results.length > 0 && (
          <div className="flex flex-col gap-3 md:flex-row md:items-start">
            {/* 检索结果：不是「分组目录」，只按 stage 排序给出优先级 */}
            <div className="w-full shrink-0 space-y-1.5 md:w-80">
              <h2 className="px-0.5 text-[11px] font-medium text-fg-tertiary">
                命中 <span className="rounded bg-surface-overlay px-1 text-fg-muted">{results.length}</span>
              </h2>
              <ul className="space-y-1.5">
                {orderTodos(results)
                  .map(t => {
                    const active = selected?.ref === t.ref;
                    const nav = entityNavTarget(t.ref);
                    return (
                      // `data-thread-row` 是检索结果行的**结构标记**，不是样式钩子：
                      // 测试要靠它区分「结果行里的标题」与「时间线头部的标题」。
                      // 同一个标题会在两处出现（行 + 头部），按纯文本查找必然撞车 ——
                      // 那会让判据 3 的测试依赖渲染时序（先找到一处就绿，两处都挂上就抛
                      // multiple elements）。标记一行，比放宽断言更能守住语义。
                      <li key={t.ref} data-thread-row={t.ref} className="group relative">
                        <button
                          onClick={() => setSelectedRef(t.ref)}
                          className={`w-full rounded-lg border px-3 py-2 pr-14 text-left transition-colors ${
                            active ? 'border-selected-border bg-selected-bg' : 'border-border-subtle bg-surface-secondary hover:bg-surface-elevated'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <span className={`mt-px shrink-0 rounded px-1.5 py-0.5 text-[11px] ${stageTone(t.stage)}`}>
                              {stageLabel(t.stage).label}
                            </span>
                            <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug text-fg-primary">
                              {t.title || t.detail || refDisplay(t.ref)}
                            </span>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-tertiary">
                            <code className="shrink-0 text-fg-muted" title={t.ref}>{refDisplay(t.ref)}</code>
                            <span className="text-fg-muted">·</span>
                            <span className="truncate">{waitPhrase(t.stage, now - t.lastActivity)}</span>
                          </div>
                        </button>
                        {nav && (
                          <button
                            onClick={e => { e.stopPropagation(); navBus.navigate(nav.page as never, nav.params); }}
                            title="打开这个对象自己的页面"
                            className="absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-[11px] text-fg-tertiary opacity-0 transition-opacity hover:bg-surface-overlay hover:text-fg-primary group-hover:opacity-100 focus:opacity-100"
                          >
                            打开 ↗
                          </button>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </div>

            {selected && <ThreadTimeline refId={selected.ref} className="min-w-0 flex-1" />}
          </div>
        )}
      </div>
    </div>
  );
}
