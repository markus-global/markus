import { useEffect, useState } from 'react';
import { api, fetchThreadDispositions, type NotificationInfo, type DispositionAPI } from '../api.ts';
import { HistoryModal } from './HistoryModal.tsx';
import { navigateForNotification, notificationHasTarget } from '../lib/notifyNavigate.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { STAGE_LABEL, formatDuration, formatRelativeAny, wouldAcceptVerdict } from '../lib/threadPresentation.ts';

/**
 * 概览页的「行动台」—— 取代原先并列的两块（独立收件箱卡片 + Needs Your Attention 聚合块）。
 *
 * 设计原则（Owner 2026-11-02）：
 *  1. **一个卡片两个部分**：左「等你处理」（要我动手）、右「动态」（只看不动手），中间细分隔线。
 *     不并排两个卡片，也不做 tab —— 用户一眼看到全部，不必猜另一块里有什么。
 *  2. **逐条，不聚合**：给具体是哪件事、谁在做、等了多久，不给「3 个待验收」这种计数。
 *  3. **整行可点开详情**：概览一行放不下的信息（完整描述、来龙去脉）进弹窗，弹窗里也有操作按钮。
 *  4. **右上角历史**：全量审批/通知走弹窗，滚到底自动加载更早的（复用 NotificationBell 的哨兵分页）。
 *  5. **空态不占位**：动态没有内容就整块不渲染，让行动区占满宽度。
 *  6. **概览不做盲批**：审批/验收必须读内容，所以动作是精确跳转，不在概览里一键通过。
 */

export interface ActionItem {
  id: string;
  kind: 'review' | 'approval' | 'blocked' | 'thread';
  title: string;
  /** 责任人 / 来源等次要信息 */
  meta: string;
  /** 弹窗里的详细说明（任务/需求描述） */
  detail?: string;
  priority?: string;
  /** 已等待多久（毫秒） */
  ageMs?: number;
  actionLabel: string;
  onAction: () => void;
  /**
   * 这条行动项对应的流 ref（tsk_ / req_ / apr_）。
   * 有它才能在同一弹窗里查处置依据 —— 北极星第三句「消失原因可查」。
   * 不新建路由台页面：一条流的信息与动作本就该在一处（奥卡姆）。
   */
  ref?: string;
}

const KIND_META = {
  review: {
    tag: '待验收',
    bar: 'bg-blue-500',
    chip: 'bg-blue-500/10 text-blue-500',
    btn: 'bg-blue-600 text-white hover:bg-blue-700',
  },
  approval: {
    tag: '待批准',
    bar: 'bg-amber-500',
    chip: 'bg-amber-500/10 text-amber-600',
    // 琥珀色上白字对比不足，用深色字
    btn: 'bg-amber-500 text-amber-950 hover:bg-amber-400',
  },
  blocked: {
    tag: '阻塞',
    bar: 'bg-red-500',
    chip: 'bg-red-500/10 text-red-500',
    btn: 'bg-red-500 text-white hover:bg-red-600',
  },
  thread: {
    // 不自带文案副本：直接用展示层唯一实现的 label。
    tag: STAGE_LABEL['person:answer']!.label,
    bar: 'bg-brand-500',
    chip: 'bg-brand-500/10 text-brand-400',
    btn: 'bg-brand-600 text-white hover:bg-brand-700',
  },
} as const;

const PRIORITY_WEIGHT: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const DAY_MS = 86_400_000;



/** 排序：紧急优先，其次等得久的优先。 */
function sortActions(items: ActionItem[]): ActionItem[] {
  return [...items].sort((a, b) => {
    const pa = PRIORITY_WEIGHT[a.priority ?? ''] ?? 4;
    const pb = PRIORITY_WEIGHT[b.priority ?? ''] ?? 4;
    if (pa !== pb) return pa - pb;
    return (b.ageMs ?? 0) - (a.ageMs ?? 0);
  });
}

export function ActionCenter({
  items,
  userId,
  runningSummary,
}: {
  items: ActionItem[];
  userId?: string;
  /** 没有待办时，说明团队此刻在跑什么 */
  runningSummary?: string;
}) {
  const [notices, setNotices] = useState<NotificationInfo[]>([]);
  const [unread, setUnread] = useState(0);
  const [detail, setDetail] = useState<ActionItem | null>(null);
  /**
   * 处置依据：只在弹窗打开时按需拉一次。
   * 不新建「路由台」页面 —— 一条流的详情与它的处置历史本来就在同一处（奥卡姆）。
   */
  const [disp, setDisp] = useState<{ ref: string; rows: DispositionAPI[] | null } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  /** 概览直显上限：待办通常个位数，全显最合理，但不能无上限堆——超过就折叠 */
  const [showAllActions, setShowAllActions] = useState(false);

  /** 弹窗打开时按需拉一次处置依据（只读，不新增写入）。 */
  useEffect(() => {
    const ref = detail?.ref;
    if (!ref) {
      setDisp(null);
      return;
    }
    let cancelled = false;
    setDisp({ ref, rows: null });
    fetchThreadDispositions(ref)
      .then(d => {
        if (!cancelled) setDisp({ ref, rows: d.dispositions ?? [] });
      })
      .catch(() => {
        if (!cancelled) setDisp({ ref, rows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [detail]);
  const ACTION_CAP = 8;
  // 详情弹窗开着时锁住所有滚动源（同 HistoryModal：不可滚的子容器不会拦住滚轮）
  useEffect(() => {
    if (!detail) return;
    const targets = [
      document.documentElement,
      document.body,
      document.querySelector<HTMLElement>('[data-app-scroll]'),
    ].filter((el): el is HTMLElement => !!el);
    const prev = targets.map(el => el.style.overflow);
    targets.forEach(el => {
      el.style.overflow = 'hidden';
    });
    return () => {
      targets.forEach((el, i) => {
        el.style.overflow = prev[i] ?? '';
      });
    };
  }, [detail]);

  const sorted = sortActions(items);
  const visibleActions = showAllActions ? sorted : sorted.slice(0, ACTION_CAP);
  const hiddenActions = sorted.length - visibleActions.length;
  /**
   * 只有**未读且高优先级**的通知才进概览（Owner 2026-11-02）。
   *
   * 普通通知是历史，点「历史」就能看，没必要在概览再铺一遍——概览只放两件事：
   * 要你动手的（左），和真正紧急需要马上知道的消息（右）。
   * 没有这类消息时，右区整块不渲染，行动区占满宽度。
   */
  const important = notices.filter(
    n =>
      !n.read &&
      (n.priority === 'urgent' || n.priority === 'high') &&
      // 审批通知一律不进右栅：它对应的审批已经在左栅「等你处理」里。
      // 判定用 type 这个结构字段，不去比标题（标题会变、会翻译）。
      n.type !== 'approval_request',
  );
  const hasNotices = important.length > 0;

  useEffect(() => {
    if (!userId) return;
    let alive = true;
    // 右栏要「最近发生了什么」——含已读。若只取未读，用户把通知点完那一刻
    // 整块动态就会突然消失（看起来像功能坏了）。未读数由同一次响应给出，
    // 不在前端数列表（列表是分页的，数出来必然少）。
    api.notifications
      .list(userId, false, { limit: 5 })
      .then(d => {
        if (!alive) return;
        setNotices(d.notifications ?? []);
        setUnread((d as { unreadCount?: number }).unreadCount ?? 0);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [userId]);

  return (
    <>
      <div className="bg-surface-elevated shadow-sm rounded-2xl overflow-hidden">
        {/* ── 卡片头：左边行动计数，右上角三个入口 ──
            用 flex-wrap：窄屏上三个入口整体换到第二行，而不是把标题挤成省略号。
            菜单项永远不隐藏 —— 窄屏没入口等于功能不存在（之前删侧栅导航时就踩过）。 ── */}
        <div className="flex flex-wrap items-center justify-between gap-y-1 px-4 sm:px-5 pt-3.5 pb-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sorted.length > 0 ? 'bg-amber-500 animate-pulse' : 'bg-green-500'}`} />
            <h3 className="text-sm font-semibold text-fg-primary">等你处理</h3>
            {sorted.length > 0 && (
              <span className="text-[11px] font-semibold text-amber-600 bg-amber-500/10 px-1.5 py-0.5 rounded tabular-nums">
                {sorted.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {/* 两个新面的入口就放在这里，不占侧标导航（Owner 砍过导航密度）。
                语义上它们就是行动台的下层：行动台答「现在要我做什么」，
                检索页答「这一条到底经过什么」（B4 把它从「全部流目录」降级为检索 ——
                主入口已倒置到任务 / 票据 / agent 详情里），路由台答「系统自己判断了什么」。 */}
            <button
              onClick={() => navBus.navigate(PAGE.THREAD)}
              className="flex items-center gap-1 text-[11px] font-medium text-fg-tertiary hover:text-fg-primary transition-colors rounded-lg px-1.5 py-1 hover:bg-surface-overlay"
              title="按 ref 或关键词检索一条流（来龙去脉在各自的详情页就地展开）"
            >
              搜索一条流
            </button>
            <button
              onClick={() => navBus.navigate(PAGE.ROUTER)}
              className="flex items-center gap-1 text-[11px] font-medium text-fg-tertiary hover:text-fg-primary transition-colors rounded-lg px-1.5 py-1 hover:bg-surface-overlay"
              title="系统对每条信号做过什么决定，以及理由"
            >
              路由台
            </button>
          <button
            onClick={() => setShowHistory(true)}
            className="shrink-0 flex items-center gap-1 text-[11px] font-medium text-fg-tertiary hover:text-fg-primary transition-colors rounded-lg px-1.5 py-1 hover:bg-surface-overlay"
          >
            历史
            {unread > 0 && (
              <span className="text-[10px] font-semibold text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded-full tabular-nums">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          </div>
        </div>

        {/* ── 一个卡片，两个部分 ──
            分隔线用 border-default（暗色 oklch .265）而非 border-subtle（.22，与卡片底 .215 几乎同色＝看不见），
            也不是无 token 的 border 类（会回退 currentColor，暗色下发亮发硬）。
            竖线刻意上下留白（my-3）而不是贯穿到底，暗色下更轻。 ── */}
        <div className={`grid grid-cols-1 ${hasNotices ? 'lg:grid-cols-[3fr_1px_2fr]' : ''}`}>
          {/* 左：等你处理（要动手的） */}
          <div className="pb-2.5">
            {sorted.length === 0 ? (
              <div className="px-4 sm:px-5 pb-3 pt-1">
                <div className="flex items-start gap-3">
                  <span className="w-8 h-8 rounded-xl bg-green-500/10 flex items-center justify-center shrink-0">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-500">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-fg-primary">没有等你处理的事</div>
                    <div className="text-[11px] text-fg-tertiary mt-0.5">{runningSummary || '团队一切正常，可以去做别的了'}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="px-2 pb-1 space-y-0.5">
                {visibleActions.map(item => {
                  const m = KIND_META[item.kind];
                  const stale = (item.ageMs ?? 0) > DAY_MS;
                  return (
                    <div
                      key={`${item.kind}:${item.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetail(item)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setDetail(item);
                        }
                      }}
                      className="group flex items-center gap-2.5 pl-0 pr-2 py-2.5 rounded-xl hover:bg-surface-overlay/60 cursor-pointer transition-colors"
                    >
                      {/* 左侧色条 = 类型，比图标省视觉噪音且窄屏也在 */}
                      <span className={`w-[3px] self-stretch rounded-full shrink-0 ${m.bar}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${m.chip}`}>{m.tag}</span>
                          <span className="text-xs font-medium text-fg-primary truncate">{item.title}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 text-[11px] text-fg-tertiary">
                          {item.meta && <span className="truncate">{item.meta}</span>}
                          {item.ageMs != null && item.ageMs > 60_000 && (
                            <span className={`shrink-0 tabular-nums ${stale ? 'text-red-500 font-medium' : ''}`}>
                              {formatDuration(item.ageMs)}
                            </span>
                          )}
                          {(item.priority === 'urgent' || item.priority === 'high') && (
                            <span className={`shrink-0 font-medium ${item.priority === 'urgent' ? 'text-red-500' : 'text-amber-600'}`}>
                              {item.priority === 'urgent' ? '紧急' : '高'}
                            </span>
                          )}
                        </div>
                      </div>
                      {/* 动作按钮：按类型实心着色 —— 一眼看到「这行要我干什么」 */}
                      <button
                        onClick={e => {
                          e.stopPropagation();
                          item.onAction();
                        }}
                        className={`shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-lg shadow-sm active:scale-[0.97] transition-all ${m.btn}`}
                      >
                        {item.actionLabel}
                      </button>
                    </div>
                  );
                })}
                {hiddenActions > 0 && (
                  <button
                    onClick={() => setShowAllActions(true)}
                    className="w-full text-left px-3 py-2 text-[11px] text-brand-400 hover:text-brand-300 font-medium"
                  >
                    展开其余 {hiddenActions} 条
                  </button>
                )}
              </div>
            )}
          </div>

          {hasNotices && (
            <div aria-hidden className="hidden lg:block w-px bg-border-default my-3" />
          )}

          {/* 右：团队动态（只看不动手）—— 没有内容就整块不渲染 */}
          {hasNotices && (
            <div className="pt-3 lg:pt-0 px-2 pb-2.5 border-t lg:border-t-0 border-border-default">
              <div className="px-2.5 pt-1 pb-1.5 flex items-center gap-2">
                <h4 className="text-[11px] font-semibold text-fg-secondary uppercase tracking-wide">重要</h4>
              </div>
              {important.slice(0, 4).map(n => (
                <button
                  key={n.id}
                  onClick={() => {
                    // 点一条通知，就去它该去的地方。
                    // 之前这里有个「没有明确去处就弹历史」的兜底 —— 那是我自己编的，
                    // 用户点通知却弹出历史弹窗完全莫名其妙（Owner 2026-11-02 直接指出）。
                    // navigateForNotification 自带兜底：至少会落到 Team，而不是什么弹窗。
                    // 与 NotificationBell 一致：agent_report 要在 Chat 里显示「知道了」确认卡，
                    // 提前标已读会把那张卡抹掉，所以它留到 Chat 那边处理。
                    if (n.type !== 'agent_report') {
                      api.notifications.markRead(n.id).catch(() => undefined);
                      setNotices(prev => prev.map(x => (x.id === n.id ? { ...x, read: true } : x)));
                      window.dispatchEvent(new CustomEvent('markus:notifications-changed'));
                    }
                    navigateForNotification(n);
                  }}
                  className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-surface-overlay/60 transition-colors flex items-start gap-2"
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                      n.priority === 'urgent' ? 'bg-red-500' : 'bg-amber-500'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] text-fg-primary font-medium truncate">{n.title}</div>
                    <div className="text-[10px] text-fg-muted mt-0.5 truncate">
                      {formatRelativeAny(n.createdAt)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── 单条详情弹窗：概览一行放不下的信息 + 操作 ── */}
      {detail && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 sm:p-8 overflow-hidden overscroll-none"
          onClick={() => setDetail(null)}
        >
          <div
            className="w-full max-w-md h-[min(85vh,32rem)] bg-surface-elevated rounded-2xl shadow-xl overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${KIND_META[detail.kind].chip}`}>
                  {KIND_META[detail.kind].tag}
                </span>
                {(detail.priority === 'urgent' || detail.priority === 'high') && (
                  <span className={`text-[10px] font-semibold shrink-0 ${detail.priority === 'urgent' ? 'text-red-500' : 'text-amber-600'}`}>
                    {detail.priority === 'urgent' ? '紧急' : '高优先级'}
                  </span>
                )}
              </div>
              <button
                onClick={() => setDetail(null)}
                className="p-1 rounded-lg hover:bg-surface-overlay text-fg-tertiary shrink-0"
                aria-label="关闭"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="px-4 pb-3 flex-1 min-h-0 overflow-y-auto overscroll-contain">
              <h3 className="text-sm font-semibold text-fg-primary leading-snug">{detail.title}</h3>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-tertiary">
                {detail.meta && <span>{detail.meta}</span>}
                {detail.ageMs != null && detail.ageMs > 60_000 && (
                  <span className={(detail.ageMs ?? 0) > DAY_MS ? 'text-red-500 font-medium' : ''}>
                    已{formatDuration(detail.ageMs)}
                  </span>
                )}
              </div>
              {detail.detail ? (
                <p className="mt-3 text-[12px] text-fg-secondary leading-relaxed whitespace-pre-wrap">{detail.detail}</p>
              ) : (
                <p className="mt-3 text-[11px] text-fg-muted">没有更多说明，点下面的按钮去处理。</p>
              )}

              {/* 处置依据：北极星第三句「消失原因可查」。
                  不另开页面 —— 这条流的来龙去脉就在这一屏里说完。 */}
              {detail.ref && disp?.ref === detail.ref && (
                <div className="mt-4 border-t border-border-default pt-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-fg-tertiary">处置依据</div>
                  {disp.rows === null && <div className="mt-1.5 text-[11px] text-fg-muted">读取中…</div>}
                  {disp.rows?.length === 0 && (
                    <div className="mt-1.5 text-[11px] text-fg-muted">
                      没有处置记录 —— 这条由业务状态直接派生（零写入），不存在「决定」这一步。
                    </div>
                  )}
                  {disp.rows && disp.rows.length > 0 && (
                    <ol className="mt-1.5 space-y-1.5">
                      {disp.rows.map(d => (
                        <li key={d.id} className="text-[11px] text-fg-secondary">
                          <span className="font-medium text-fg-primary">{d.action}</span>
                          {' · '}
                          {d.reason || '未说明理由'}
                          <span className="text-fg-tertiary">
                            {' · '}
                            {d.actor}
                          </span>
                          {wouldAcceptVerdict(d) === 'reject' && (
                            <span className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-amber-600">当时判定不该来</span>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-default bg-surface-primary/40">
              {detail.ref && (
                <button
                  onClick={() => {
                    setDetail(null);
                    navBus.navigate(PAGE.THREAD, { threadRef: detail.ref! });
                  }}
                  className="mr-auto text-[11px] font-medium px-3 py-1.5 rounded-lg text-brand-400 hover:bg-surface-overlay transition-colors"
                  title="这条流的时间线：决定 + 当前状态"
                >
                  看这条流的来龙去脉
                </button>
              )}
              <button
                onClick={() => setDetail(null)}
                className="text-[11px] font-medium px-3 py-1.5 rounded-lg text-fg-secondary hover:bg-surface-overlay transition-colors"
              >
                关闭
              </button>
              <button
                onClick={() => {
                  detail.onAction();
                  setDetail(null);
                }}
                className={`text-[11px] font-semibold px-3.5 py-1.5 rounded-lg shadow-sm transition-colors ${KIND_META[detail.kind].btn}`}
              >
                {detail.actionLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 历史弹窗：自己设计的回顾视图（不套用通知页面板），滚到底自动加载更早的 ── */}
      <HistoryModal open={showHistory} onClose={() => setShowHistory(false)} userId={userId} />
    </>
  );
}
