import { useTranslation } from 'react-i18next';
import { displayHistoryUrl, type BrowserHistoryEntry } from '../lib/browserHistory.ts';

/**
 * Address-bar history dropdown for the embedded browser.
 *
 * Purely presentational: the parent owns query / highlight state and decides
 * when the menu is visible. Items are picked with click, or with ↑/↓ + Enter
 * (the parent wires those keys on the address input).
 *
 * Row removal + "clear all" are handled here so the parent stays small; both
 * fire `onMouseDown` with `preventDefault()` upstream so the input never loses
 * focus (and the native WebContentsView is not re-shown mid-interaction).
 */
export function BrowserHistoryMenu({
  items,
  query,
  activeIndex,
  onHover,
  onPick,
  onRemove,
  onClear,
}: {
  items: BrowserHistoryEntry[];
  /** Current address-bar text — decides the empty-state copy. */
  query: string;
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (entry: BrowserHistoryEntry) => void;
  onRemove: (url: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation('common');
  const heading = query.trim()
    ? t('browserHistoryMatches', { defaultValue: '历史记录' })
    : t('browserHistoryRecent', { defaultValue: '最近访问' });

  if (items.length === 0) {
    return (
      <div
        role="listbox"
        className="absolute left-0 right-0 top-full mt-1 z-50 rounded-lg border border-border-default bg-surface-elevated shadow-xl overflow-hidden"
      >
        <div className="px-2.5 py-3 text-[11px] text-fg-tertiary text-center">
          {query.trim()
            ? t('browserHistoryEmpty', { defaultValue: '没有匹配的历史记录' })
            : t('browserHistoryNone', { defaultValue: '暂无浏览历史' })}
        </div>
      </div>
    );
  }

  return (
    <div
      role="listbox"
      aria-label={heading}
      className="absolute left-0 right-0 top-full mt-1 z-50 rounded-lg border border-border-default bg-surface-elevated shadow-xl overflow-hidden"
    >
      <div className="px-2.5 py-1.5 text-[10px] uppercase tracking-wide text-fg-muted border-b border-border-default/60 select-none">
        {heading}
      </div>
      <ul className="max-h-72 overflow-y-auto scrollbar-thin py-0.5">
        {items.map((entry, index) => {
          const active = index === activeIndex;
          return (
            <li key={entry.url}>
              <div
                role="option"
                aria-selected={active}
                tabIndex={-1}
                className={`group flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 cursor-pointer ${
                  active ? 'bg-brand-500/15' : 'hover:bg-surface-overlay/60'
                }`}
                onMouseEnter={() => onHover(index)}
                // Prevent the input from blurring before the click lands.
                onMouseDown={e => {
                  e.preventDefault();
                  if (e.button !== 0) return;
                  onPick(entry);
                }}
              >
                <svg
                  className={`shrink-0 ${active ? 'text-brand-500' : 'text-fg-muted'}`}
                  width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden
                >
                  <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" />
                </svg>
                <div className="min-w-0 flex-1">
                  {entry.title && (
                    <div className="text-[11px] text-fg-primary truncate leading-tight">{entry.title}</div>
                  )}
                  <div className={`truncate leading-tight ${entry.title ? 'text-[10px] text-fg-tertiary' : 'text-[11px] text-fg-secondary'}`}>
                    {displayHistoryUrl(entry.url)}
                  </div>
                </div>
                <button
                  type="button"
                  title={t('browserHistoryRemove', { defaultValue: '从历史记录中移除' })}
                  aria-label={t('browserHistoryRemove', { defaultValue: '从历史记录中移除' })}
                  className="shrink-0 w-5 h-5 flex items-center justify-center rounded text-fg-muted opacity-0 group-hover:opacity-100 hover:text-fg-secondary hover:bg-surface-overlay transition-opacity"
                  onMouseDown={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    onRemove(entry.url);
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="w-full px-2.5 py-1.5 text-[10px] text-fg-tertiary text-left border-t border-border-default/60 hover:bg-surface-overlay/60 hover:text-fg-secondary transition-colors"
        onMouseDown={e => {
          e.preventDefault();
          onClear();
        }}
      >
        {t('browserHistoryClear', { defaultValue: '清除全部历史记录' })}
      </button>
    </div>
  );
}
