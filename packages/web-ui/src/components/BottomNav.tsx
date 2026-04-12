import { useTranslation } from 'react-i18next';
import { type PageId, PAGE_ICONS, MOBILE_TABS } from '../routes.ts';

interface Props {
  currentPage: PageId;
  onNavigate: (page: PageId) => void;
}

// i18n key mapping for each mobile tab
const TAB_I18N_KEYS: Record<PageId, string> = {
  [MOBILE_TABS[0].id]: 'bottomNav.home',      // Home
  [MOBILE_TABS[1].id]: 'bottomNav.team',      // Team
  [MOBILE_TABS[2].id]: 'bottomNav.work',      // Work
  [MOBILE_TABS[3].id]: 'bottomNav.deliverables', // Deliverables
  [MOBILE_TABS[4].id]: 'bottomNav.builder',   // Builder
  [MOBILE_TABS[5].id]: 'bottomNav.settings',  // Settings
};

export function BottomNav({ currentPage, onNavigate }: Props) {
  const { t } = useTranslation();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-surface-secondary border-t border-border-default flex items-stretch h-14 safe-area-bottom">
      {MOBILE_TABS.map(tab => {
        const isActive = tab.group.includes(currentPage);
        const i18nKey = TAB_I18N_KEYS[tab.id] || tab.label;
        return (
          <button
            key={tab.id}
            onClick={() => onNavigate(tab.id)}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors ${
              isActive
                ? 'text-brand-500'
                : 'text-fg-tertiary active:text-fg-secondary'
            }`}
          >
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
            <span className={`text-[10px] leading-tight ${isActive ? 'font-semibold' : ''}`}>
              {t(i18nKey)}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
