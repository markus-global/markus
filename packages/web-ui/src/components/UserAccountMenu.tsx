import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { type AuthUser, getHubUser, hubApi, validateHubSession } from '../api.ts';
import { PAGE, PAGE_ICONS } from '../routes.ts';
import { navBus } from '../navBus.ts';
import { Avatar, resolveUserAvatarSrc } from './Avatar.tsx';
import { ConfirmModal } from './ConfirmModal.tsx';

interface Props {
  authUser?: AuthUser;
  onLogout?: () => void;
  onEditProfile?: () => void;
  /** Show "Settings" entry (main sidebar). Off on Settings page itself. */
  showSettingsLink?: boolean;
  collapsed?: boolean;
  showVersion?: boolean;
}

function MenuIcon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      <path d={d} />
    </svg>
  );
}

const PANEL_WIDTH = 200;

/**
 * Compact user avatar with Hub status dot. Opens a popover for account info,
 * Hub connection, Settings, and sign-out.
 */
export function UserAccountMenu({
  authUser,
  onLogout,
  onEditProfile,
  showSettingsLink = false,
  collapsed = false,
  showVersion = false,
}: Props) {
  const { t } = useTranslation(['nav', 'common']);
  const [open, setOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  // Optimistic from cache; live-validated below so a stale token doesn't show green.
  const [hubConnected, setHubConnected] = useState(() => hubApi.isAuthenticated());
  const [hubUser, setHubUser] = useState(() => getHubUser());
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const refreshHub = useCallback((opts?: { validate?: boolean }) => {
    setHubUser(getHubUser());
    if (!hubApi.isAuthenticated()) {
      setHubConnected(false);
      return;
    }
    if (!opts?.validate) {
      setHubConnected(true);
      return;
    }
    void validateHubSession().then(ok => {
      setHubConnected(ok);
      setHubUser(getHubUser());
    });
  }, []);

  useEffect(() => {
    refreshHub({ validate: true });
    // hub-auth already means local cache changed — read it; do not re-validate
    // (validate → saveHubAuth → hub-auth was an infinite loop).
    const onAuth = () => refreshHub();
    const onFocus = () => refreshHub({ validate: true });
    window.addEventListener('markus:hub-auth', onAuth);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('markus:hub-auth', onAuth);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshHub]);

  const reposition = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const panelH = panelRef.current?.offsetHeight ?? 220;

    // Prefer opening to the right of the trigger so collapsed sidebar still has room.
    let left = rect.right + 8;
    if (left + PANEL_WIDTH > vw - 8) {
      left = Math.max(8, rect.left - PANEL_WIDTH - 8);
    }
    // Anchor above the avatar; clamp into the viewport.
    let top = rect.top - panelH - 8;
    if (top < 8) top = Math.min(rect.bottom + 8, vh - panelH - 8);
    setPos({ top: Math.max(8, top), left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    // Re-measure after paint so panel height is accurate for upward placement.
    const id = requestAnimationFrame(() => reposition());
    return () => cancelAnimationFrame(id);
  }, [open, reposition, collapsed]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onReposition = () => reposition();
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open, reposition]);

  const displayName =
    authUser?.name
    || hubUser?.displayName
    || hubUser?.username
    || t('common:userPlaceholder');
  const displayEmail = authUser?.email || hubUser?.email || '';
  const avatarUrl = resolveUserAvatarSrc(authUser?.avatarUrl, hubUser?.avatarUrl);

  const statusColor = hubConnected ? 'bg-emerald-500' : 'bg-fg-muted';
  // Credits / plan follow the Hub JWT identity — not the local Markus profile card.
  const statusTitle = !hubConnected
    ? t('sidebar.hubDisconnected')
    : hubUser?.username
      ? t('sidebar.hubConnectedAs', { username: hubUser.username })
      : t('sidebar.hubConnected');
  const hubMismatch = !!(
    hubConnected && hubUser?.username && authUser?.name
    && hubUser.username.toLowerCase() !== authUser.name.toLowerCase()
    && hubUser.email?.toLowerCase() !== authUser.email?.toLowerCase()
  );

  const goAccountSettings = () => {
    setOpen(false);
    // Re-validate when the user inspects Hub status — keeps the dot honest.
    refreshHub({ validate: true });
    navBus.navigate(PAGE.SETTINGS, { tab: 'account' });
  };

  const panel = open && createPortal(
    <div
      ref={panelRef}
      className="fixed bg-surface-elevated border border-border-default rounded-xl shadow-xl z-[9999] overflow-hidden"
      style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH }}
    >
      <div className="px-3.5 py-3 border-b border-border-default flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-fg-primary truncate">{displayName}</div>
          {displayEmail && (
            <div className="text-xs text-fg-tertiary mt-0.5 truncate">{displayEmail}</div>
          )}
        </div>
        {onEditProfile && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onEditProfile();
            }}
            title={t('common:profile.editProfile')}
            className="shrink-0 mt-0.5 p-1.5 rounded-md text-fg-tertiary hover:text-fg-secondary hover:bg-surface-overlay transition-colors"
          >
            <MenuIcon d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" size={14} />
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={goAccountSettings}
        className="w-full px-3.5 py-2.5 border-b border-border-default flex items-center gap-2 hover:bg-surface-overlay transition-colors text-left"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${statusColor}`} />
        <span className="min-w-0 flex-1">
          <span className="text-xs text-fg-secondary block truncate">{statusTitle}</span>
          {hubMismatch && hubUser?.username && (
            <span className="text-[10px] text-amber-500/90 block truncate mt-0.5">
              {t('sidebar.hubAccountMismatch', { username: hubUser.username })}
            </span>
          )}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-muted shrink-0">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>

      <div className="py-1">
        {showSettingsLink && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navBus.navigate(PAGE.SETTINGS);
            }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-fg-secondary hover:bg-surface-overlay transition-colors"
          >
            <MenuIcon d={PAGE_ICONS[PAGE.SETTINGS] ?? ''} />
            {t('settings')}
          </button>
        )}
        {window.markusDesktop && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              window.markusDesktop?.openInBrowser();
            }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-fg-secondary hover:bg-surface-overlay transition-colors"
          >
            <MenuIcon d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />
            {t('common:openInBrowser')}
          </button>
        )}
        {onLogout && (
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setConfirmLogout(true);
            }}
            className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-fg-secondary hover:bg-surface-overlay transition-colors"
          >
            <MenuIcon d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            {t('common:signOut')}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );

  return (
    <div
      className={`relative ${collapsed ? 'flex justify-center' : 'flex items-center justify-between gap-2 w-full'}`}
    >
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        title={displayName}
        className={`relative inline-flex items-center justify-center rounded-full transition-opacity hover:opacity-90 ${collapsed ? 'p-0.5' : ''}`}
      >
        <Avatar name={displayName} avatarUrl={avatarUrl} size={collapsed ? 28 : 32} fallback="icon" />
        <span
          className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-surface-secondary ${statusColor}`}
          title={statusTitle}
        />
      </button>

      {showVersion && !collapsed && (
        <span className="text-[10px] text-fg-muted select-none shrink-0">v{__APP_VERSION__}</span>
      )}

      {panel}

      {confirmLogout && onLogout && (
        <ConfirmModal
          title={t('common:signOutConfirmTitle')}
          message={t('common:signOutConfirmMessage')}
          confirmLabel={t('common:signOut')}
          variant="primary"
          onConfirm={() => {
            setConfirmLogout(false);
            onLogout();
          }}
          onCancel={() => setConfirmLogout(false)}
        />
      )}
    </div>
  );
}
