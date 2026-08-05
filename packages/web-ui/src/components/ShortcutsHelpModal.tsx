import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  KEYBOARD_SHORTCUTS,
  formatShortcutKeys,
  type ShortcutGroupId,
} from '../lib/keyboard-shortcuts.ts';
import { PAGE, type PageId } from '../routes.ts';

const GROUP_ORDER: ShortcutGroupId[] = ['layout', 'tasks', 'search', 'rightPanel', 'terminal', 'help'];

function pageScope(page: PageId | undefined): 'team' | 'work' | 'any' {
  if (page === PAGE.TEAM) return 'team';
  if (page === PAGE.WORK) return 'work';
  return 'any';
}

export function ShortcutsHelpModal({
  open,
  onClose,
  page,
}: {
  open: boolean;
  onClose: () => void;
  page?: PageId;
}) {
  const { t } = useTranslation('common');
  const isMac = typeof navigator !== 'undefined'
    && navigator.platform.toUpperCase().includes('MAC');
  const scope = pageScope(page);

  useEffect(() => {
    if (!open) return;
    // Capture phase so Escape closes this modal before RightPanel / xterm handlers.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 backdrop-blur-[1px] p-4"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={t('shortcuts.title')}
    >
      <div className="w-full max-w-lg max-h-[80vh] overflow-auto rounded-xl border border-border-default bg-surface-primary shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 py-3 border-b border-border-default bg-surface-primary">
          <h2 className="text-sm font-semibold text-fg-primary">{t('shortcuts.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-md text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated"
            aria-label={t('shortcuts.close')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="px-4 py-3 space-y-4">
          {GROUP_ORDER.map(group => {
            const items = KEYBOARD_SHORTCUTS.filter(s => {
              if (s.group !== group) return false;
              const p = s.page ?? 'any';
              return p === 'any' || p === scope || scope === 'any';
            });
            if (items.length === 0) return null;
            return (
              <section key={group}>
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-tertiary mb-2">
                  {t(`shortcuts.groups.${group}`)}
                </h3>
                <ul className="space-y-1.5">
                  {items.map(s => (
                    <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="text-fg-secondary min-w-0">
                        {t(s.labelKey ?? s.label, { defaultValue: s.label })}
                      </span>
                      <kbd className="shrink-0 px-1.5 py-0.5 rounded bg-surface-elevated border border-border-default text-[11px] font-medium text-fg-primary font-mono">
                        {formatShortcutKeys(s.keys, isMac)}
                      </kbd>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
