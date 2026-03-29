import { useState } from 'react';
import { Settings } from '../pages/Settings.tsx';
import { GovernancePage } from '../pages/Governance.tsx';
import { ReportsPage } from '../pages/Reports.tsx';
import { useSwipeTabs } from '../hooks/useSwipeTabs.ts';
import type { ThemeMode } from '../hooks/useTheme.ts';

const tabs = [
  { id: 'settings', label: 'Settings' },
  { id: 'governance', label: 'Governance' },
  { id: 'reports', label: 'Reports' },
] as const;

type TabId = (typeof tabs)[number]['id'];

export function MobileSettingsTabs({ theme, onThemeChange }: { theme?: ThemeMode; onThemeChange?: (m: ThemeMode) => void }) {
  const [activeTab, setActiveTab] = useState<TabId>('settings');
  const swipe = useSwipeTabs(tabs, activeTab, setActiveTab);

  return (
    <div className="flex-1 overflow-hidden flex flex-col" onTouchStart={swipe.onTouchStart} onTouchEnd={swipe.onTouchEnd}>
      <div className="flex border-b border-border-default bg-surface-secondary shrink-0 overflow-x-auto scrollbar-hide">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 min-w-0 px-3 py-2.5 text-xs font-medium text-center whitespace-nowrap transition-colors border-b-2 ${
              activeTab === tab.id
                ? 'border-brand-500 text-brand-500'
                : 'border-transparent text-fg-tertiary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden flex flex-col">
        {activeTab === 'settings' && <Settings theme={theme} onThemeChange={onThemeChange} />}
        {activeTab === 'governance' && <GovernancePage />}
        {activeTab === 'reports' && <ReportsPage />}
      </div>
    </div>
  );
}
