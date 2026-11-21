import { openMobileDrawer } from './MobileDrawer.tsx';
import { useTranslation } from 'react-i18next';

export function MobileMenuButton({ className = '' }: { className?: string }) {
  const { t } = useTranslation('common');
  return (
    <button
      onClick={openMobileDrawer}
      className={`p-1.5 -ml-1 rounded-lg hover:bg-surface-overlay transition-colors shrink-0 ${className}`}
      aria-label={t('menu')}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    </button>
  );
}
