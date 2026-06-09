import { useTranslation } from 'react-i18next';
import { type PageId, PAGE, PAGE_ICONS, SIDEBAR_NAV, SIDEBAR_SECTIONS } from '../routes.ts';
import { type AuthUser } from '../api.ts';
import { NotificationBell } from './NotificationBell.tsx';


interface Props {
  currentPage: string;
  onNavigate: (page: PageId) => void;
  authUser?: AuthUser;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d={d} />
    </svg>
  );
}

export function Sidebar({ currentPage, onNavigate, authUser, collapsed, onToggleCollapse }: Props) {
  const { t } = useTranslation(['nav', 'common']);

  return (
    <aside className="h-dvh bg-surface-secondary flex flex-col shrink-0 overflow-hidden">
      <div className={`flex items-center ${collapsed ? 'px-2 py-3.5 justify-center' : 'px-4 h-14 justify-between'}`}>
        <button onClick={onToggleCollapse} title={collapsed ? t('sidebar.expandSidebar') : t('sidebar.collapseSidebar')} className="flex items-center gap-2.5 min-w-0 group">
          <img src="/logo.png" alt="Markus" className="w-8 h-8 rounded-lg shrink-0" />
          {!collapsed && <span className="text-[15px] font-bold tracking-tight text-fg-primary whitespace-nowrap">Markus</span>}
        </button>
      </div>
      <nav className={`${collapsed ? 'p-1' : 'px-3 py-2'} flex-1 overflow-y-auto scrollbar-thin`}>
        {SIDEBAR_SECTIONS.map((section, si) => {
          const items = SIDEBAR_NAV.filter(i => i.section === section.key && i.id !== PAGE.SETTINGS);
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
                  return (
                    <button
                      key={item.id}
                      onClick={() => onNavigate(item.id)}
                      title={collapsed ? t(item.id) : undefined}
                      className={`w-full flex items-center ${collapsed ? 'flex-col justify-center px-1 py-1.5 gap-0.5' : 'gap-3 px-3 py-[7px]'} rounded-lg text-[13px] font-medium mb-0.5 transition-colors text-fg-primary ${
                        isActive
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
      <div className={`shrink-0 ${collapsed ? 'p-1' : 'px-3 pb-2'}`}>
        <button
          onClick={() => onNavigate(PAGE.SETTINGS)}
          title={collapsed ? t(PAGE.SETTINGS) : undefined}
          className={`w-full flex items-center ${collapsed ? 'flex-col justify-center px-1 py-1.5 gap-0.5' : 'gap-3 px-3 py-[7px]'} rounded-lg text-[13px] font-medium transition-colors text-fg-secondary hover:bg-surface-overlay/60`}
        >
          <Icon d={PAGE_ICONS[PAGE.SETTINGS] ?? ''} size={collapsed ? 16 : 18} />
          {collapsed
            ? <span className="text-[9px] leading-tight truncate w-full text-center">{t(PAGE.SETTINGS)}</span>
            : <>
                <span className="truncate">{t(PAGE.SETTINGS)}</span>
                <span className="ml-auto text-[10px] text-fg-muted">v{__APP_VERSION__}</span>
              </>
          }
        </button>
      </div>

    </aside>
  );
}
