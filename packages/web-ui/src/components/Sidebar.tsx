import { useTranslation } from 'react-i18next';
import { type PageId, PAGE, PAGE_ICONS, SIDEBAR_NAV, SIDEBAR_SECTIONS } from '../routes.ts';
import { type AuthUser } from '../api.ts';
import { NotificationBell } from './NotificationBell.tsx';
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

  return (
    <aside className="markus-app-sidebar h-dvh bg-surface-secondary flex flex-col shrink-0 overflow-hidden">
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
                  if (item.id === PAGE.NOTIFICATIONS) {
                    return (
                      <NotificationBell
                        key={item.id}
                        sidebarMode
                        collapsed={collapsed}
                        userId={authUser?.id}
                        label={t(item.id)}
                        iconPath={PAGE_ICONS[item.id]}
                        isActive={currentPage === item.id}
                      />
                    );
                  }
                  const isActive = currentPage === item.id;
                  const isKbFocus = keyboardPaneActive && keyboardFocusPageId === item.id;
                  return (
                    <button
                      key={item.id}
                      data-l0-page-id={item.id}
                      onClick={() => onNavigate(item.id)}
                      title={collapsed ? t(item.id) : undefined}
                      className={`w-full flex items-center ${collapsed ? 'flex-col justify-center px-1 py-1.5 gap-0.5' : 'gap-3 px-3 py-[7px]'} rounded-lg text-[13px] font-medium mb-0.5 transition-colors text-fg-primary ${
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
