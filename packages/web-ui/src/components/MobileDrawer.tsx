import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Avatar } from './Avatar.tsx';
import { PAGE, type PageId } from '../routes.ts';
import type { AuthUser } from '../api.ts';

interface MobileDrawerProps {
  authUser?: AuthUser;
  onNavigate: (page: PageId) => void;
}

export function MobileDrawer({ authUser, onNavigate }: MobileDrawerProps) {
  const { t } = useTranslation(['settings', 'common']);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('markus:open-drawer', handler);
    return () => window.removeEventListener('markus:open-drawer', handler);
  }, []);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  const handleNav = (page: string) => {
    setOpen(false);
    if (page === '__edit_profile') {
      window.location.hash = '#settings';
      onNavigate(PAGE.SETTINGS);
      setTimeout(() => window.dispatchEvent(new CustomEvent('markus:open-edit-profile')), 100);
      return;
    }
    onNavigate(page as PageId);
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]">
      <div
        className="absolute inset-0 bg-black/40 animate-fadeIn"
        onClick={() => setOpen(false)}
      />
      <aside className="absolute inset-y-0 left-0 w-72 bg-surface-secondary shadow-2xl flex flex-col animate-slideInLeft">
        {/* User section */}
        <div className="px-5 pt-6 pb-4 border-b border-border-default">
          {authUser ? (
            <button
              onClick={() => handleNav('__edit_profile')}
              className="flex items-center gap-3 w-full text-left"
            >
              <Avatar name={authUser.name || 'User'} avatarUrl={authUser.avatarUrl} size={40} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-fg-primary truncate">{authUser.name || t('common:userPlaceholder')}</div>
                <div className="text-xs text-fg-tertiary truncate">{authUser.email || authUser.role}</div>
              </div>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-tertiary shrink-0">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          ) : (
            <div className="text-sm text-fg-tertiary">{t('common:loading')}</div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-3 px-3 space-y-1">
          <DrawerNavItem
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>}
            label={t('common:home', { defaultValue: 'Home' })}
            onClick={() => handleNav(PAGE.HOME)}
          />
          <DrawerNavItem
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>}
            label={t('settings:title')}
            onClick={() => handleNav(PAGE.SETTINGS)}
          />
          <DrawerNavItem
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 20V10" /><path d="M12 20V4" /><path d="M6 20v-6" /></svg>}
            label={t('common:reports', { defaultValue: 'Reports' })}
            onClick={() => handleNav(PAGE.REPORTS)}
          />
        </nav>
      </aside>
    </div>
  );
}

function DrawerNavItem({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-fg-secondary hover:text-fg-primary hover:bg-surface-overlay transition-colors"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

export function openMobileDrawer() {
  window.dispatchEvent(new CustomEvent('markus:open-drawer'));
}
