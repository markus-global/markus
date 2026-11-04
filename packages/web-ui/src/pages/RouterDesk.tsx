/**
 * RouterDesk — 路由台：系统做过什么决定，以及为什么。
 *
 * 这是「把批处理提到前台」的真正落点（实现文档 §5.4）：**不是把批处理过程 UI 化，
 * 而是把「路由决定」这个可审计对象 UI 化**。
 *
 * 它和概览的行动台不是一回事，这也是我上一轮删错的原因：
 *   - 行动台（Inbox）= 「现在要我做什么」（person:* 的待办）
 *   - 路由台        = 「系统替我做/没做什么决定」（含 observe 模式的 would-accept）
 * 前者是待办清单，后者是审计面。合并会让「系统判断对不对」这件事无处可查。
 *
 * 数据全部来自只读接口，零新增写入：
 *   GET /api/threads/dispositions/recent      全局决定
 *   GET /api/threads/:id/subscriptions        撤销 attach 的依据
 *   DELETE /api/threads/:id/subscriptions/:tid 撤销（人喊停由路由层记录）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchRecentDispositions, fetchThreads, fetchThreadSubscriptions, unsubscribeThread } from '../api.ts';
import type { DispositionAPI } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';

import { actionLabel, formatRelative, refDisplay, refKindLabel, shortRef, wouldAcceptVerdict } from '../lib/threadPresentation.ts';
import { entityNavTarget } from '../lib/threadNav.ts';

export function RouterDeskPage() {
  const [rows, setRows] = useState<DispositionAPI[]>([]);
  const [refByThread, setRefByThread] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [subs, setSubs] = useState<Record<string, Array<{ ticketId: string; agentId: string; purpose: string }>>>({});
  const [onlyObserve, setOnlyObserve] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, t] = await Promise.all([
        fetchRecentDispositions(200),
        fetchThreads().catch(() => ({ threads: [] })),
      ]);
      setRows(d.dispositions ?? []);
      const map: Record<string, string> = {};
      for (const th of t.threads ?? []) map[th.id] = th.ref;
      setRefByThread(map);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(
    () => (onlyObserve ? rows.filter(r => wouldAcceptVerdict(r) === 'accept') : rows),
    [rows, onlyObserve],
  );
  const observeCount = useMemo(() => rows.filter(r => wouldAcceptVerdict(r) === 'accept').length, [rows]);

  const toggle = async (r: DispositionAPI) => {
    if (openId === r.id) { setOpenId(null); return; }
    setOpenId(r.id);
    if (subs[r.threadId]) return;
    try {
      const d = await fetchThreadSubscriptions(r.threadId);
      setSubs(prev => ({ ...prev, [r.threadId]: d.subscriptions ?? [] }));
    } catch {
      setSubs(prev => ({ ...prev, [r.threadId]: [] }));
    }
  };

  const revoke = async (threadId: string, ticketId: string) => {
    try {
      await unsubscribeThread(threadId, ticketId);
      setSubs(prev => ({ ...prev, [threadId]: (prev[threadId] ?? []).filter(s => s.ticketId !== ticketId) }));
      setFlash('已撤销该订阅');
      setTimeout(() => setFlash(null), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    // 同 ThreadView：App 的 <main> 是 overflow-hidden，页面必须自己声明滚动区，
    // 否则超出视口的内容被裁掉且滚不动。
    <div className="flex-1 min-h-0 overflow-auto">
    <div className="mx-auto max-w-4xl px-4 py-6">
      <header className="mb-4">
        <button
          onClick={() => navBus.navigate(PAGE.HOME)}
          className="mb-2 flex items-center gap-1 text-[11px] font-medium text-fg-tertiary hover:text-fg-primary transition-colors rounded-lg px-1.5 py-1 -ml-1.5 hover:bg-surface-overlay"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          概览
        </button>
        <h1 className="text-xl font-semibold text-fg-primary">路由台</h1>
        <p className="mt-1 text-sm text-fg-secondary">
          系统对每条进来的信号做了什么判断，以及理由。观察模式下的「本可以接单」也在这里。
        </p>
      </header>

      <div className="mb-3 flex items-center gap-2 text-xs">
        <button
          onClick={() => setOnlyObserve(false)}
          className={`rounded-full px-3 py-1 ${!onlyObserve ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary'}`}
        >全部 {rows.length}</button>
        <button
          onClick={() => setOnlyObserve(true)}
          className={`rounded-full px-3 py-1 ${onlyObserve ? 'bg-amber-500/15 text-amber-600' : 'text-fg-tertiary'}`}
        >观察模式 {observeCount}</button>
        <button onClick={() => void load()} className="ml-auto text-fg-tertiary hover:text-fg-secondary">刷新</button>
      </div>

      {flash && <div className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2 text-sm text-emerald-600">{flash}</div>}
      {loading && <div className="text-sm text-fg-tertiary">加载中…</div>}
      {error && <div className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-600">{error}</div>}

      {!loading && !error && shown.length === 0 && (
        <div className="rounded-lg border border-subtle bg-surface-overlay p-6 text-sm text-fg-secondary">
          还没有路由决定。外部来源接入后，每条信号被接单 / 归入 / 忽略都会在这里留一条带理由的记录。
        </div>
      )}

      <ul className="space-y-2">
        {shown.map(r => {
          const open = openId === r.id;
          const list = subs[r.threadId];
          return (
            <li key={r.id} className="rounded-lg border border-subtle bg-surface-secondary">
              <button onClick={() => void toggle(r)} className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left">
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-[11px] text-fg-secondary">
                      {actionLabel(r.action)}
                    </span>
                    <code className="shrink-0 text-[11px] text-fg-tertiary" title={refByThread[r.threadId] ?? r.threadId}>
                      {refDisplay(refByThread[r.threadId] ?? r.threadId)}
                    </code>
                  </span>
                  {/* 审计面看的是「理由」——它才是判断对不对的依据，所以给它正文位 */}
                  <span className="mt-1.5 block whitespace-pre-wrap text-sm leading-snug text-fg-primary">
                    {r.reason || '未说明理由'}
                  </span>
                  <span className="mt-1 block text-[11px] text-fg-tertiary">
                    {r.actor} · {formatRelative(r.createdAt)}
                  </span>
                </span>
                {wouldAcceptVerdict(r) === 'accept' && (
                  <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">本可接单</span>
                )}
              </button>
              {/* 打开真实实体：审计面必须能「顺藤摸瓜」到那件事上，
                  否则一串判断只是看起来像审计。只有确定入口的才做成按钮。 */}
              {(() => {
                const nav = entityNavTarget(refByThread[r.threadId] ?? r.threadId);
                if (!nav) return null;
                return (
                  <button
                    onClick={() => navBus.navigate(nav.page as never, nav.params)}
                    title={`打开${refKindLabel(refByThread[r.threadId] ?? r.threadId)}`}
                    className="absolute right-2 top-2 rounded px-1.5 py-0.5 text-[11px] text-fg-tertiary opacity-0 transition-opacity hover:bg-surface-overlay hover:text-fg-primary group-hover:opacity-100 focus:opacity-100"
                  >打开 ↗</button>
                );
              })()}

              {open && (
                <div className="border-t border-subtle px-4 py-3">
                  <div className="mb-2 text-xs text-fg-tertiary">触发：<code title={r.triggerId}>{shortRef(r.triggerId)}</code></div>
                  {!list && <div className="text-xs text-fg-tertiary">读取订阅…</div>}
                  {list && list.length === 0 && (
                    <div className="text-xs text-fg-tertiary">这条流当前没有订阅，无需撤销。</div>
                  )}
                  {list && list.length > 0 && (
                    <ul className="space-y-1.5">
                      {list.map(s => (
                        <li key={s.ticketId} className="flex items-center justify-between gap-3 text-xs text-fg-secondary">
                          <span><code title={s.ticketId}>{shortRef(s.ticketId)}</code> · {s.agentId} · {s.purpose === 'own' ? '负责' : '关注'}</span>
                          <button
                            onClick={() => void revoke(r.threadId, s.ticketId)}
                            className="rounded border border-subtle px-2 py-0.5 text-fg-secondary hover:bg-surface-overlay"
                          >撤销</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
    </div>
  );
}
