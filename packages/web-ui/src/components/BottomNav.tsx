import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { type PageId, PAGE, PAGE_ICONS, MOBILE_TABS } from '../routes.ts';
import { api, type NotificationInfo } from '../api.ts';
import { useUnreadCounts } from '../hooks/useUnreadCounts.ts';

interface Props {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
  userId?: string;
}

export function BottomNav({ currentPage, onNavigate, userId }: Props) {
  const { t } = useTranslation('nav');
  const [unreadCount, setUnreadCount] = useState(0);

  const { counts: chatUnreadCounts } = useUnreadCounts({ enabled: true });
  const teamUnread = useMemo(() => {
    let total = 0;
    for (const count of Object.values(chatUnreadCounts)) total += count;
    return total;
  }, [chatUnreadCounts]);

  const fetchUnread = useCallback(async () => {
    try {
      const n = await api.notifications.list(userId, false);
      setUnreadCount(n.unreadCount ?? n.notifications.filter((x: NotificationInfo) => !x.read).length);
    } catch { /* */ }
  }, [userId]);

  useEffect(() => {
    fetchUnread();
    const timer = setInterval(fetchUnread, 15000);
    const onChanged = () => fetchUnread();
    window.addEventListener('markus:notifications-changed', onChanged);
    return () => {
      clearInterval(timer);
      window.removeEventListener('markus:notifications-changed', onChanged);
    };
  }, [fetchUnread]);

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-surface-secondary flex items-stretch h-14 safe-area-bottom">
      {MOBILE_TABS.map(tab => {
        const isActive = tab.group.includes(currentPage);
        const isNotif = tab.id === PAGE.NOTIFICATIONS;
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
              {isNotif && unreadCount > 0 && (
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
