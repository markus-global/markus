import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type PageId, PAGE, PAGE_ICONS, SIDEBAR_NAV, SIDEBAR_SECTIONS } from '../routes.ts';
import { type AuthUser } from '../api.ts';
import { readAttentionCount, subscribeAttentionCount } from '../lib/attentionCount.ts';
import { UserAccountMenu } from './UserAccountMenu.tsx';

interface Props {
  currentPage: string;
  onNavigate: (page: PageId) => void;
  authUser?: AuthUser;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onLogout?: () => void;
  /** Keyboard L0 focus highlight (j/k while pane is l0). */
  keyboardFocusPageId?: string | null;
  keyboardPaneActive?: boolean;
}

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d={d} />
    </svg>
  );
}

export function Sidebar({
  currentPage, onNavigate, authUser, collapsed, onToggleCollapse, onLogout,
  keyboardFocusPageId, keyboardPaneActive,
}: Props) {
  const { t } = useTranslation(['nav', 'common']);
  // 待办数只有一个计算点（概览把结果 publish 出来，见 lib/attentionCount）。
  // 这里只订阅，不再自己算「未读 + 待批」—— 曾经三个口径各算各的，移动端因此永远是 0。
  const [noticeCount, setNoticeCount] = useState(readAttentionCount);
  useEffect(() => subscribeAttentionCount(setNoticeCount), []);

  return (
    <aside data-keyboard-pane="l0" className="markus-app-sidebar h-dvh bg-surface-secondary flex flex-col shrink-0 overflow-hidden">
      {/* Drag region includes traffic-light clearance (padding is on this node, not aside). */}
      <div
        data-electron-drag
        className={`electron-mac-sidebar-header flex items-center ${collapsed ? 'px-2 py-3.5 justify-center' : 'px-4 h-14 justify-between'}`}
      >
        <button
          data-no-drag
          onClick={onToggleCollapse}
          title={collapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')}
          className="flex items-center gap-2.5 min-w-0 group"
        >
          <img src="/logo.png" alt="Markus" className="w-8 h-8 rounded-lg shrink-0" />
          {!collapsed && <span className="text-[15px] font-bold tracking-tight text-fg-primary whitespace-nowrap">Markus</span>}
        </button>
      </div>
      <nav className={`${collapsed ? 'p-1' : 'px-3 py-2'} flex-1 overflow-y-auto scrollbar-thin`}>
        {SIDEBAR_SECTIONS.map((section, si) => {
          const items = SIDEBAR_NAV.filter(i => i.section === section.key);
          if (items.length === 0) return null;
          const sectionLabel = t(`sections.${section.key}`);
          return (
            <div key={section.key}>
              <div className={si > 0 ? 'mt-3' : ''}>
                {!collapsed && sectionLabel && (
                  <div className="px-3 py-1.5 mb-1 text-[10px] font-semibold text-fg-muted uppercase tracking-[0.1em]">
                    {sectionLabel}
                  </div>
                )}
                {collapsed && si > 0 && <div className="my-3" />}
                {items.map((item) => {
                  const isActive = currentPage === item.id;
                  const isKbFocus = keyboardPaneActive && keyboardFocusPageId === item.id;
                  return (
                    <button
                      key={item.id}
                      data-l0-page-id={item.id}
                      onClick={() => onNavigate(item.id)}
                      title={collapsed ? t(item.id) : undefined}
                      className={`relative w-full flex items-center ${collapsed ? 'flex-col justify-center px-1 py-1.5 gap-0.5' : 'gap-3 px-3 py-[7px]'} rounded-lg text-[13px] font-medium mb-0.5 transition-colors text-fg-primary ${
                        isKbFocus
                          ? 'bg-brand-500/25 ring-1 ring-inset ring-brand-500/40'
                          : isActive
                            ? 'bg-surface-overlay'
                            : 'hover:bg-surface-overlay/60'
                      }`}
                    >
                      <Icon d={PAGE_ICONS[item.id] ?? ''} size={collapsed ? 16 : 18} />
                      {collapsed
                        ? <span className="text-[9px] leading-tight truncate w-full text-center">{t(item.id)}</span>
                        : <span className="truncate">{t(item.id)}</span>
                      }
                      {item.id === PAGE.HOME && noticeCount > 0 && (
                        collapsed ? (
                          /* 收起态：角标钉在图标右上角 —— 收起时也不能丢待办数 */
                          <span className="absolute top-0.5 right-1.5 min-w-[13px] h-[13px] px-[3px] rounded-full bg-red-500 text-white text-[8px] font-bold flex items-center justify-center tabular-nums">
                            {noticeCount > 9 ? '9+' : noticeCount}
                          </span>
                        ) : (
                          <span className="ml-auto shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-red-500 text-white font-semibold tabular-nums">
                            {noticeCount > 99 ? '99+' : noticeCount}
                          </span>
                        )
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
      <div className={`shrink-0 border-t border-border-subtle ${collapsed ? 'p-1.5 flex justify-center' : 'px-3 py-2.5'}`}>
        <UserAccountMenu
          authUser={authUser}
          onLogout={onLogout}
          onEditProfile={() => {
            window.dispatchEvent(new Event('markus:open-edit-profile'));
          }}
          showSettingsLink={false}
          collapsed={collapsed}
          showVersion={!collapsed}
        />
      </div>
    </aside>
  );
}
