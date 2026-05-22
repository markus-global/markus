import { useTranslation } from 'react-i18next';
import { PAGE, PAGE_ICONS, SIDEBAR_NAV, SIDEBAR_SECTIONS } from '../routes.ts';

function Icon({ d, size = 18 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d={d} />
    </svg>
  );
}

const SHOWCASE_PAGES = new Set([PAGE.HOME, PAGE.TEAM, PAGE.WORK, PAGE.DELIVERABLES]);

export function SidebarPreview({ activePage, onNavigate }: { activePage: string; onNavigate?: (page: string) => void }) {
  const { t } = useTranslation(['nav', 'common']);

  return (
    <aside className="h-full bg-surface-secondary flex flex-col shrink-0 overflow-hidden w-[180px]">
      <div className="flex items-center px-4 h-14">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center shadow-md shadow-brand-900/30">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </div>
          <span className="text-[15px] font-bold tracking-tight text-fg-primary">Markus</span>
        </div>
      </div>
      <nav className="px-3 py-2 flex-1 overflow-y-auto">
        {SIDEBAR_SECTIONS.filter(s => s.key === 'workspace').map((section) => (
          <div key={section.key}>
            <div className="px-3 py-1.5 mb-1 text-[10px] font-semibold text-fg-muted uppercase tracking-[0.1em]">
              {t(`sections.${section.key}`)}
            </div>
            {SIDEBAR_NAV.filter(i => i.section === section.key && SHOWCASE_PAGES.has(i.id)).map((item) => {
              const isActive = activePage === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onNavigate?.(item.id)}
                  className={`w-full flex items-center gap-3 px-3 py-[7px] rounded-xl text-[13px] mb-0.5 transition-all ${
                    isActive
                      ? 'bg-brand-600 text-white shadow-sm shadow-brand-900/30 font-medium'
                      : 'text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary'
                  }`}
                >
                  <Icon d={PAGE_ICONS[item.id] ?? ''} />
                  <span className="truncate">{t(item.id)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
