import { useTranslation } from 'react-i18next';
import { PAGE, PAGE_ICONS, SIDEBAR_NAV, SIDEBAR_SECTIONS } from '../routes.ts';

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d={d} />
    </svg>
  );
}

/**
 * Collapsed-mode sidebar for the product showcase.
 * Mirrors the real Sidebar component's collapsed layout exactly
 * (same routes data, icons, spacing) but avoids API deps like
 * NotificationBell and __APP_VERSION__.
 */
export function SidebarPreview({ activePage }: { activePage: string }) {
  const { t } = useTranslation(['nav', 'common']);

  return (
    <aside className="h-full bg-surface-secondary flex flex-col shrink-0 overflow-hidden rounded-r-2xl" style={{ width: 52 }}>
      {/* Logo — matches Sidebar collapsed header: px-2 py-3.5 justify-center */}
      <div className="flex items-center px-2 py-3.5 justify-center">
        <img src="/logo.png" alt="Markus" className="w-8 h-8 rounded-lg shadow-md shadow-black/30 shrink-0" />
      </div>
      <nav className="p-1 flex-1 overflow-y-auto scrollbar-thin">
        {SIDEBAR_SECTIONS.map((section, si) => (
          <div key={section.key}>
            {si > 0 && <div className="my-3" />}
            {SIDEBAR_NAV.filter(i => i.section === section.key).map((item) => {
              if (item.id === PAGE.NOTIFICATIONS) {
                return (
                  <div
                    key={item.id}
                    className="w-full flex flex-col items-center justify-center px-1 py-1.5 gap-0.5 rounded-xl text-[13px] mb-0.5 text-fg-secondary"
                  >
                    <Icon d={PAGE_ICONS[item.id] ?? ''} size={16} />
                    <span className="text-[9px] leading-tight truncate w-full text-center">{t(item.id)}</span>
                  </div>
                );
              }
              const isActive = activePage === item.id;
              return (
                <div
                  key={item.id}
                  className={`w-full flex flex-col items-center justify-center px-1 py-1.5 gap-0.5 rounded-xl text-[13px] mb-0.5 transition-all ${
                    isActive
                      ? 'bg-brand-600 text-white shadow-sm shadow-brand-900/30 font-medium'
                      : 'text-fg-secondary'
                  }`}
                >
                  <Icon d={PAGE_ICONS[item.id] ?? ''} size={16} />
                  <span className="text-[9px] leading-tight truncate w-full text-center">{t(item.id)}</span>
                </div>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
