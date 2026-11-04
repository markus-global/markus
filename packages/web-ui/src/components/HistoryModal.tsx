import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type ApprovalInfo, type NotificationInfo } from '../api.ts';
import { navigateForApproval, navigateForNotification, notificationHasTarget } from '../lib/notifyNavigate.ts';
import { markNotificationThreadRead } from '../lib/notifyRead.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { formatRelativeAny } from '../lib/threadPresentation.ts';

/**
 * 概览「历史」弹窗 —— 自己设计，不套用通知页的面板。
 *
 * 为什么不直接嵌 NotificationBell（Owner 2026-11-02：太突兀、不友好）：
 *  - 它有自己的一套导航（审批/通知/任务 三个 tab）和密集列表排版，是为整页/popover 设计的，
 *    塞进弹窗后像是把另一个页面搬了进来，与概览卡片的设计语言不一致。
 *  - 历史是**回顾**入口，不是操作台。所以这里刻意不做「就地批准」：
 *    待处理项只给「去处理」，把人送到能看完整上下文的地方再决定（与概览同一个纪律）。
 *
 * 分页：通知按 offset 增长，底部哨兵进入视口即加载更早的（与通知页同一套行为，各自的实现）。
 */

/**
 * 审批的**结局**样式。
 *
 * 历史只放已结束的审批 —— `pending` 的不在这里，它们在概览「等你处理」里。
 * 两边不重叠：概览 = 现在要我动手的，历史 = 已经结束的。
 */
const APPROVAL_STATUS = {
  approved: { label: '已批准', dot: 'bg-green-500', chip: 'bg-green-500/10 text-green-600' },
  rejected: { label: '已拒绝', dot: 'bg-red-500', chip: 'bg-red-500/10 text-red-500' },
  cancelled: { label: '已取消', dot: 'bg-fg-muted/40', chip: 'bg-surface-overlay text-fg-tertiary' },
  expired: { label: '已过期', dot: 'bg-amber-500/60', chip: 'bg-amber-500/10 text-amber-600' },
} as const;

type ResolvedStatus = keyof typeof APPROVAL_STATUS;

type Tab = 'all' | 'approvals' | 'notices';
const PAGE_SIZE = 15;
/**
 * DOM 上限：历史只是回顾，没必要把上万条全堆进页面。
 * 没这个上限时哨兵会持续加载（实测 scrollHeight 一度涨到 25 万像素）。
 */
const MAX_ROWS = 200;

/**
 * 弹窗打开时锁住**所有**可能的滚动源。
 *
 * Owner 2026-11-02 第二次反馈：在内容少的 tab（如「未读」）一滚，背后 Overview 就动。
 *
 * 为什么上一版只锁 [data-app-scroll] 不够：
 *  · 列表内容少时（scrollHeight === clientHeight）它**不再是滚动容器**，
 *    `overscroll-contain` 对一个不可滚动的元素不生效 → 滚轮直接奔父级；
 *  · 根文档也可能是滚动源（移动端骨架就是让 PageSlot 走根文档滚动），
 *    只锁页面里的那个 div 漏掉了它。
 *
 * 所以：把 html / body / 应用滚动容器全部上锁，一个不留。
 */
function useBackgroundScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const targets = [
      document.documentElement,
      document.body,
      document.querySelector<HTMLElement>('[data-app-scroll]'),
    ].filter((el): el is HTMLElement => !!el);
    const prev = targets.map(el => el.style.overflow);
    const prevPadding = targets.map(el => el.style.paddingRight);
    // 去掉滚动条会宽出一截，补上内边距避免整页横向跳动
    const barWidth = window.innerWidth - document.documentElement.clientWidth;
    targets.forEach((el, i) => {
      el.style.overflow = 'hidden';
      if (i === 0 && barWidth > 0) el.style.paddingRight = `${barWidth}px`;
      void prevPadding[i];
    });
    return () => {
      targets.forEach((el, i) => {
        el.style.overflow = prev[i] ?? '';
        el.style.paddingRight = prevPadding[i] ?? '';
      });
    };
  }, [active]);
}



/** 通知 → 跳转：统一走 lib/notifyNavigate（与铃铛同一套按类型分派）。 */
function notificationTarget(n: NotificationInfo): (() => void) | null {
  if (n.actionUrl && !n.actionType) {
    return () => window.open(n.actionUrl!, '_blank', 'noopener');
  }
  return notificationHasTarget(n) ? () => navigateForNotification(n) : null;
}

type Row =
  | { kind: 'approval'; at: string; approval: ApprovalInfo }
  | { kind: 'notice'; at: string; notice: NotificationInfo };

export function HistoryModal({
  open,
  onClose,
  userId,
}: {
  open: boolean;
  onClose: () => void;
  userId?: string;
}) {
  const [tab, setTab] = useState<Tab>('all');
  const [notices, setNotices] = useState<NotificationInfo[]>([]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [total, setTotal] = useState(0);
  /** 未读数取**服务端**口径（与铃铛、概览一致）。本地数分页列表必然偏小。 */
  const [unreadTotal, setUnreadTotal] = useState<number | null>(null);
  const [approvals, setApprovals] = useState<ApprovalInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef({ loading: false, done: false, count: 0 });
  stateRef.current = { loading, done, count: notices.length };

  const loadPage = useCallback(
    async (offset: number) => {
      if (!userId) return;
      setLoading(true);
      try {
        const d = await api.notifications.list(userId, false, { limit: PAGE_SIZE, offset });
        const got = d.notifications ?? [];
        setNotices(prev => {
          const seen = new Set(prev.map(x => x.id));
          return [...prev, ...got.filter(x => !seen.has(x.id))].slice(0, MAX_ROWS);
        });
        setTotal(d.totalCount ?? 0);
        setUnreadTotal((d as { unreadCount?: number }).unreadCount ?? null);
        // 终止条件：本页不满 / 空页 / 已到 DOM 上限
        if (got.length === 0 || got.length < PAGE_SIZE || stateRef.current.count + got.length >= MAX_ROWS) {
          setDone(true);
        }
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : '读取失败');
      } finally {
        setLoading(false);
      }
    },
    [userId],
  );

  // 别处（铃铛 / 概览）标了已读 → 弹窗里的未读点与计数必须跟着变，
  // 否则弹窗开着时永远看不到自己刚点掉的那条变灰。
  useEffect(() => {
    if (!open || !userId) return;
    const onChanged = () => {
      void loadPage(0);
      api.approvals
        .list()
        .then(r => setApprovals((r.approvals ?? []).filter(a => a.status === 'pending')))
        .catch(() => undefined);
    };
    window.addEventListener('markus:notifications-changed', onChanged);
    window.addEventListener('markus:data-changed', onChanged);
    return () => {
      window.removeEventListener('markus:notifications-changed', onChanged);
      window.removeEventListener('markus:data-changed', onChanged);
    };
  }, [open, userId, loadPage]);

  // 打开时重置并拉第一页（每次都重取，避免看到过期数据）
  useEffect(() => {
    if (!open || !userId) return;
    setNotices([]);
    setTotal(0);
    setDone(false);
    setError(null);
    void loadPage(0);
    api.approvals
      // 历史 = 已结束的审批。拉全量取“非 pending”（实际有 35 批准 / 11 拒绝 / 2 取消）。
      .list(undefined, { limit: 100 })
      .then(d => setApprovals((d.approvals ?? []).filter(a => a.status !== 'pending')))
      .catch(() => undefined);
  }, [open, userId, loadPage]);

  // 底部哨兵：进入视口即加载更早的通知
  useEffect(() => {
    if (!open) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      entries => {
        const s = stateRef.current;
        if (!entries[0]?.isIntersecting || s.loading || s.done) return;
        void loadPage(s.count);
      },
      { rootMargin: '120px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [open, loadPage, notices.length]);

  /**
   * 滞回路保险已删除（Owner 2026-11-02 第三次反馈）。
   *
   * 之前的实现在这里叠了四层：max-h + flex-1 + min-h-0 + 原生 wheel 拦截。
   * 切 tab 后只要 scrollerRef 有一瞬是 null，`if (s && ...)` 就会失败并
   * `preventDefault()` 抹掉所有滚动 —— 这是自造的脆弱面。
   *
   * 现在只用 CSS 做一件事：弹窗固定高度，列表在内部滚；背景靠锁
   * html/body/appScroll 的 overflow 挡住。不再实现任何手势逻辑。
   */

  const rows = useMemo<Row[]>(() => {
    const a: Row[] = approvals.map(x => ({ kind: 'approval', at: x.respondedAt ?? x.requestedAt, approval: x }));
    const n: Row[] = notices.map(x => ({ kind: 'notice', at: x.createdAt, notice: x }));
    const all = [...a, ...n].sort((p, q) => (q.at ?? '').localeCompare(p.at ?? ''));
    if (tab === 'approvals') return all.filter(r => r.kind === 'approval');
    if (tab === 'notices') return all.filter(r => r.kind === 'notice');
    return all;
  }, [approvals, notices, tab]);

  const resolvedCount = approvals.length;
  const unread = unreadTotal ?? notices.reduce((n, x) => n + (x.read ? 0 : 1), 0);

  // 弹窗开着时锁住背后的滚动容器（否则滚轮会滚到 Overview 上）
  useBackgroundScrollLock(open);

  if (!open) return null;
  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 sm:p-6 overflow-hidden overscroll-none"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg h-[78vh] bg-surface-elevated rounded-2xl shadow-xl overflow-hidden flex flex-col mt-4"
        onClick={e => e.stopPropagation()}
      >
        {/* 头 */}
        <div className="flex items-center justify-between px-4 pt-3.5 pb-2 shrink-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-fg-primary">历史</h3>
            {unread > 0 && (
              <span className="text-[10px] font-semibold text-brand-400 bg-brand-500/10 px-1.5 py-0.5 rounded-full tabular-nums">
                {unread} 条未读
              </span>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-overlay text-fg-tertiary" aria-label="关闭">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* 分段器：自己的样式（胶囊），不是通知页的下划线 tab */}
        <div className="px-4 pb-2.5 shrink-0 flex items-center gap-1">
          {([
            { id: 'all' as Tab, label: '全部', count: resolvedCount + notices.length },
            { id: 'approvals' as Tab, label: '审批结果', count: resolvedCount },
            { id: 'notices' as Tab, label: '通知', count: notices.length },
          ]).map(seg => {
            const active = tab === seg.id;
            return (
              <button
                key={seg.id}
                onClick={() => setTab(seg.id)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors flex items-center gap-1 ${
                  active ? 'bg-surface-overlay text-fg-primary' : 'text-fg-tertiary hover:text-fg-secondary'
                }`}
              >
                {seg.label}
                {seg.count > 0 && (
                  <span className="tabular-nums text-fg-muted">{seg.count}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* 列表 */}
        <div ref={scrollerRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain scrollbar-thin px-2 pb-2">
          {error && <div className="mx-1 mb-2 rounded-lg bg-rose-500/10 text-rose-600 text-[11px] px-3 py-2">{error}</div>}

          {rows.length === 0 && !loading && (
            <div className="px-3 py-10 text-center">
              <div className="text-[12px] text-fg-secondary">还没有历史记录</div>
              <div className="text-[11px] text-fg-muted mt-1">团队开始工作后，审批和通知会出现在这里</div>
            </div>
          )}

          {rows.map(row =>
            row.kind === 'approval' ? (
              (() => {
                const st = APPROVAL_STATUS[row.approval.status as ResolvedStatus] ?? APPROVAL_STATUS.cancelled;
                const at = row.approval.respondedAt ?? row.approval.requestedAt;
                return (
                  <div
                    key={`a:${row.approval.id}`}
                    // 审批行**曾经没有任何 onClick**（Owner 2026-11-04：“已批准或已拒绝为什么
                    // 不可点击跳转！！！”）：通知行有跳转，审批行只画了个 hover 样式，点了没反应。
                    // id 一直在（details.taskId / requirementId / agentId），只是没人接上。
                    // 落点交给已有的 navigateForApproval——它是审批落点的唯一实现，
                    // 这里不再写第三套“什么类型跳哪里”。
                    onClick={() => {
                      onClose();
                      navigateForApproval(row.approval);
                    }}
                    title="打开对应的任务 / 需求 / 会话"
                    className="flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl hover:bg-surface-overlay/50 transition-colors cursor-pointer"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${st.dot}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${st.chip}`}>{st.label}</span>
                        <span className="text-xs font-medium text-fg-primary truncate">{row.approval.title}</span>
                      </div>
                      <div className="text-[11px] text-fg-tertiary mt-0.5 truncate">
                        {row.approval.agentName} · {formatRelativeAny(at)}
                      </div>
                    </div>
                  </div>
                );
              })()
            ) : (
              (() => {
                const go = notificationTarget(row.notice);
                return (
                  <div
                    key={`n:${row.notice.id}`}
                    // 不能点的原因写在这里：不是“已读所以不能点”，而是这条通知没有关联对象。
                    // Owner 2026-11-04 实测后直接问「有的没法点？还是已读的没法点？」——
                    // 界面没解释，用户只能猜。
                    title={go ? undefined : '这条通知没有关联的任务 / 需求 / 会话，仅作告知'}
                    className={`flex items-start gap-2.5 px-2.5 py-2.5 rounded-xl transition-colors ${go ? 'hover:bg-surface-overlay/50 cursor-pointer' : ''}`}
                    onClick={go ? () => {
                      // 与铃铛对齐：点一条，就把**同一任务/需求**的其它未读通知一起标已读。
                      // 铃铛一直这么做，历史弹窗只标点中那一条 → 徽标残留、得挨个点。
                      const marked = markNotificationThreadRead(row.notice, notices);
                      setNotices(prev => prev.map(x => (marked.has(x.id) ? { ...x, read: true } : x)));
                      // 点完就走：弹窗留着会遮住刚跳到的页面（铃铛是 popover，导航即关）。
                      onClose();
                      go();
                    } : undefined}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${row.notice.read ? 'bg-fg-muted/40' : 'bg-brand-500'}`} />
                    <div className="flex-1 min-w-0">
                      <div className={`text-xs truncate ${row.notice.read ? 'text-fg-tertiary' : 'text-fg-primary font-medium'}`}>
                        {row.notice.title}
                        {!go && (
                          <span className="ml-1.5 align-middle text-[10px] font-normal text-fg-muted">仅告知</span>
                        )}
                      </div>
                      {row.notice.body && (
                        <div className="text-[11px] text-fg-muted mt-0.5 line-clamp-2 leading-relaxed">{row.notice.body}</div>
                      )}
                      <div className="text-[10px] text-fg-muted mt-1">{formatRelativeAny(row.notice.createdAt)}</div>
                    </div>
                  </div>
                );
              })()
            ),
          )}

          {/* 哨兵：滚到底自动加载更早的 */}
          <div ref={sentinelRef} className="h-8 flex items-center justify-center">
            {loading && <span className="text-[11px] text-fg-muted">加载中…</span>}
            {!loading && done && notices.length > 0 && (
              <span className="text-[10px] text-fg-muted">没有更早的记录了</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
