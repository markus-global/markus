import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type PageId, PAGE, PAGE_ICONS, MOBILE_TABS } from '../routes.ts';
import { api, type NotificationInfo } from '../api.ts';
import { useUnreadCounts, sumTeamChatUnread } from '../hooks/useUnreadCounts.ts';
import { readAttentionCount, subscribeAttentionCount } from '../lib/attentionCount.ts';

interface Props {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  userId?: string;
}

/**
 * Scroll-direction driven auto-hide for the mobile bottom nav.
 *
 * Mobile pages scroll the DOCUMENT (see `lib/mobileDocScroll.ts`), so `window`
 * is the single scroller and the browser toolbar's own gesture is what we
 * mirror: content moving up = the user is reading downward → give them the
 * pixels; any upward gesture = they want the chrome back.
 *
 * Thresholds exist so a jittery finger (or rubber-band overscroll) does not
 * flicker the bar: hide only after a deliberate downward move past the first
 * screenful, show on the first meaningful upward move or at the very top.
 */
const HIDE_AFTER_PX = 6;
const SHOW_AFTER_PX = 6;
const TOP_ALWAYS_VISIBLE_PX = 56;

export function BottomNav({ currentPage, onNavigate, userId }: Props) {
  const { t } = useTranslation('nav');
  const [unreadCount, setUnreadCount] = useState(readAttentionCount);
  const [hidden, setHidden] = useState(false);
  const hiddenRef = useRef(false);

  const applyHidden = useCallback((next: boolean) => {
    if (hiddenRef.current === next) return;
    hiddenRef.current = next;
    setHidden(next);
  }, []);

  // Auto-hide on downward scroll, reveal on any upward gesture (or at the top).
  useEffect(() => {
    let lastY = window.scrollY;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY;
        const dy = y - lastY;
        lastY = y;
        if (y <= TOP_ALWAYS_VISIBLE_PX) { applyHidden(false); return; }
        if (dy > HIDE_AFTER_PX) applyHidden(true);
        else if (dy < -SHOW_AFTER_PX) applyHidden(false);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [applyHidden]);

  // Entering a page (or re-entering the tab) always starts with the nav visible:
  // the new page begins at scrollTop 0, and a nav left hidden would look broken.
  useEffect(() => {
    applyHidden(false);
  }, [currentPage, applyHidden]);

  const { counts: chatUnreadCounts, sessionAgentMap } = useUnreadCounts({ enabled: true });
  // 与 Team 页会话列表口径一致（agent 映射的 session + 所有 channel），
  // 而不是全量 counts 求和——孤儿 session / 无映射会话不再污染徽标数字。
  const teamUnread = useMemo(() => sumTeamChatUnread(chatUnreadCounts, sessionAgentMap), [chatUnreadCounts, sessionAgentMap]);

  // 概览徽标：订阅概览页发布的待办数（唯一计算点）。
  // 之前这里只拉「未读通知」—— 用户把通知点完那一刻徽标就永远空了，
  // 而真正等他的待批审批在审批表里，根本不在通知里。
  useEffect(() => subscribeAttentionCount(setUnreadCount), []);

  return (
    <nav
      data-mobile-bottom-nav
      className={`fixed bottom-0 left-0 right-0 z-50 bg-surface-secondary flex items-stretch h-14 safe-area-bottom transition-transform duration-300 ease-out will-change-transform ${
        hidden ? 'translate-y-[calc(100%+1px)]' : 'translate-y-0'
      }`}
    >
      {MOBILE_TABS.map(tab => {
        const isActive = tab.group.includes(currentPage);
        const isHome = tab.id === PAGE.HOME;
        const isTeam = tab.id === PAGE.TEAM;

        return (
          <button
            key={tab.id}
            onClick={() => onNavigate(tab.id)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
              isActive ? 'text-fg-primary' : 'text-fg-tertiary active:text-fg-secondary'
            }`}
          >
            <div className="relative">
              <svg
                width={20}
                height={20}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={isActive ? 2 : 1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
                className="shrink-0"
              >
                <path d={PAGE_ICONS[tab.id]!} />
              </svg>
              {/* 未读数挂在概览 tab（通知页已移除） */}
              {isHome && unreadCount > 0 && (
                <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 flex items-center justify-center bg-red-500 text-white text-[9px] font-bold rounded-full leading-none">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
              {isTeam && teamUnread > 0 && (
                <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 flex items-center justify-center bg-red-500 text-white text-[9px] font-bold rounded-full leading-none">
                  {teamUnread > 99 ? '99+' : teamUnread}
                </span>
              )}
            </div>
            <span className={`text-[10px] leading-tight ${isActive ? 'font-semibold' : ''}`}>
              {t(tab.id)}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
