import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatSearchMatch } from '../lib/chatSearch.ts';

/**
 * Find-in-conversation bar.
 *
 * Rendered as a normal flow row above the message list rather than a floating
 * overlay: the message area is a virtualized scroll container, and a `position:
 * absolute` panel inside it would scroll away (or be clipped) — the same family
 * of bug the right-panel browser had.
 */
export interface ChatHistorySearchProps {
  query: string;
  onQueryChange: (q: string) => void;
  matches: readonly ChatSearchMatch[];
  /** Index into `matches` of the selected hit, or -1 when nothing is selected. */
  cursor: number;
  /** How many messages the search scanned (the loaded transcript). */
  scanned: number;
  /** Older messages exist on the server but are not loaded, so they were not scanned. */
  hasMore: boolean;
  loadingMore: boolean;
  truncated: boolean;
  onLoadEarlier: () => void;
  onJump: (index: number) => void;
  onClose: () => void;
  /** Optional per-message label (sender / time) shown next to each hit. */
  labelFor?: (match: ChatSearchMatch) => string;
}

const FIELD_KEY: Record<ChatSearchMatch['field'], string> = {
  text: 'page.findFieldText',
  thinking: 'page.findFieldThinking',
  tool: 'page.findFieldTool',
};

const FIELD_CLASS: Record<ChatSearchMatch['field'], string> = {
  text: 'bg-brand-500/10 text-brand-500',
  thinking: 'bg-amber-500/10 text-amber-600',
  tool: 'bg-sky-500/10 text-sky-600',
};

/** The snippet with the hit itself emphasised. */
function Snippet({ match }: { match: ChatSearchMatch }) {
  const before = match.snippet.slice(0, match.snippetMatchStart);
  const hit = match.snippet.slice(match.snippetMatchStart, match.snippetMatchStart + match.snippetMatchLength);
  const after = match.snippet.slice(match.snippetMatchStart + match.snippetMatchLength);
  return (
    <span className="text-xs text-fg-secondary">
      {before}
      <mark className="bg-yellow-500/30 text-fg-primary rounded-[3px] px-0.5">{hit}</mark>
      {after}
    </span>
  );
}

export function ChatHistorySearch({
  query, onQueryChange, matches, cursor, scanned, hasMore, loadingMore, truncated,
  onLoadEarlier, onJump, onClose, labelFor,
}: ChatHistorySearchProps) {
  const { t } = useTranslation(['team', 'common']);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Keep the selected hit visible inside the result list as the cursor moves.
  useEffect(() => {
    if (cursor < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-find-idx="${cursor}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const step = (delta: number) => {
    if (matches.length === 0) return;
    const base = cursor < 0 ? (delta >= 0 ? -1 : 0) : cursor;
    const next = ((base + delta) % matches.length + matches.length) % matches.length;
    onJump(next);
  };

  const hasQuery = query.trim().length > 0;

  return (
    <div className="border-b border-border-default bg-surface-secondary/60 px-4 py-2 space-y-1.5 shrink-0">
      <div className="flex items-center gap-1.5">
        <div className="flex-1 relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-fg-tertiary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
              else if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
            }}
            placeholder={t('page.findPlaceholder')}
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg outline-none focus:border-brand-500/50 transition-colors"
          />
        </div>
        <span className="text-[11px] text-fg-tertiary tabular-nums shrink-0 min-w-[44px] text-center">
          {hasQuery && matches.length > 0
            ? t('page.findMatchCount', { current: (cursor < 0 ? 0 : cursor) + 1, total: matches.length })
            : hasQuery ? '0/0' : ''}
        </span>
        <button
          onClick={() => step(-1)}
          disabled={matches.length === 0}
          title={t('page.findPrev')}
          className="p-1 rounded-md text-fg-tertiary hover:text-fg-primary hover:bg-surface-elevated disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>
        </button>
        <button
          onClick={() => step(1)}
          disabled={matches.length === 0}
          title={t('page.findNext')}
          className="p-1 rounded-md text-fg-tertiary hover:text-fg-primary hover:bg-surface-elevated disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
        </button>
        <button
          onClick={onClose}
          title={t('page.findClose')}
          className="p-1 rounded-md text-fg-tertiary hover:text-fg-primary hover:bg-surface-elevated transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>

      {/* Scope line — the honest answer to "what did you actually search?" */}
      {hasQuery && (
        <div className="flex items-center gap-2 text-[10px] text-fg-tertiary">
          <span>{t('page.findScopeLoaded', { count: scanned })}</span>
          {truncated && <span className="text-amber-600">{t('page.findTruncated', { count: matches.length })}</span>}
          {matches.length === 0 && !hasMore && <span className="text-fg-secondary">{t('page.findNoMatches')}</span>}
          {hasMore && (
            <button
              onClick={onLoadEarlier}
              disabled={loadingMore}
              className="ml-auto text-brand-500 hover:text-brand-500 disabled:opacity-50 underline decoration-dotted"
            >
              {loadingMore ? t('page.findLoadingEarlier') : t('page.findLoadEarlier')}
            </button>
          )}
        </div>
      )}

      {hasQuery && matches.length > 0 && (
        <div ref={listRef} className="max-h-52 overflow-y-auto scrollbar-thin space-y-0.5">
          {matches.map((m, i) => (
            <button
              key={`${m.messageId}-${m.field}-${i}`}
              data-find-idx={i}
              onClick={() => onJump(i)}
              className={`w-full text-left px-2.5 py-1.5 rounded-lg transition-colors ${
                i === cursor ? 'bg-brand-500/15 ring-1 ring-brand-500/40' : 'hover:bg-surface-elevated'
              }`}
            >
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className={`px-1.5 py-0 rounded text-[9px] font-medium shrink-0 ${FIELD_CLASS[m.field]}`}>
                  {t(FIELD_KEY[m.field])}
                </span>
                {labelFor && <span className="text-[10px] text-fg-tertiary truncate">{labelFor(m)}</span>}
              </div>
              <div className="line-clamp-2 break-words">
                <Snippet match={m} />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
