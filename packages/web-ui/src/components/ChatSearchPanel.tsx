import { useEffect, useRef, useState, useCallback, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { SearchResultItem } from './SearchResultItem.js';
import { useMessageSearch } from '../hooks/useMessageSearch.js';
import type { SearchResult } from '../api.js';

// ─── Icons ─────────────────────────────────────────────────────────

function SearchIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-fg-tertiary shrink-0" viewBox="0 0 16 16" fill="none">
      <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 10L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-fg-tertiary" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 5V8.5L10 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg className="w-3 h-3 text-fg-tertiary transition-transform" viewBox="0 0 12 12" fill="none">
      <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 14 14" fill="none">
      <path d="M1 3H13M3.5 7H10.5M6 11H8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// ─── Props ─────────────────────────────────────────────────────────

interface ChatSearchPanelProps {
  /** Optional initial scope filter */
  scope?: 'all' | 'channel' | 'direct';
  /** Optional initial channel filter */
  channel?: string;
  /** Optional initial agent filter */
  agentId?: string;
  /** Optional agent display names for filter selection */
  agents?: { id: string; name: string }[];
  /** Called when user selects a result — e.g. jump to message */
  onSelectResult: (result: SearchResult) => void;
  /** Called when user dismisses/close the search panel */
  onClose: () => void;
}

// ─── Component ─────────────────────────────────────────────────────

export function ChatSearchPanel({ scope, channel, agentId, agents, onSelectResult, onClose }: ChatSearchPanelProps) {
  const { t } = useTranslation(['team', 'common']);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const search = useMessageSearch({ scope, channel, agentId });

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Scroll selected item into view
  const selectedResult = search.selectedIndex >= 0 ? search.results[search.selectedIndex] : null;

  useEffect(() => {
    if (selectedResult && listRef.current) {
      const selectedEl = listRef.current.querySelector('[data-selected="true"]');
      selectedEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedResult]);

  // Keyboard handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      search.navigateDown();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      search.navigateUp();
    } else if (e.key === 'Enter') {
      if (selectedResult) {
        onSelectResult(selectedResult);
      } else if (search.results.length > 0) {
        onSelectResult(search.results[0]);
      }
    } else if (e.key === 'Escape') {
      if (search.query) {
        search.clearQuery();
      } else {
        onClose();
      }
    }
  }, [search, selectedResult, onSelectResult, onClose]);

  const handleSelectResult = useCallback((result: SearchResult) => {
    onSelectResult(result);
  }, [onSelectResult]);

  const handleClickRecent = useCallback((q: string) => {
    search.setQuery(q);
  }, [search]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ─── Search Input ───────────────────────────────────── */}
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="relative flex-1">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
            <SearchIcon />
          </span>
          <input
            ref={inputRef}
            type="text"
            value={search.query}
            onChange={e => search.setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('page.searchPlaceholder')}
            className="w-full h-8 pl-8 pr-7 text-xs bg-surface-secondary rounded-lg border border-border-primary focus:outline-none focus:border-brand-500/50 placeholder:text-fg-tertiary/50 text-fg-primary"
          />
          {search.query && (
            <button
              onClick={search.clearQuery}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-tertiary hover:text-fg-secondary transition-colors"
              tabIndex={-1}
            >
              <ClearIcon />
            </button>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-[11px] text-fg-tertiary hover:text-fg-primary transition-colors shrink-0"
        >
          {t('common.done') || 'Done'}
        </button>
      </div>

      {/* ─── Filter Toggle ───────────────────────────────────── */}
      <button
        onClick={() => setFiltersOpen(!filtersOpen)}
        className="flex items-center justify-between mx-3 px-2 py-1.5 rounded-md text-[11px] text-fg-tertiary hover:bg-surface-elevated transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <FilterIcon />
          <span>{t('page.searchFilters') || 'Filters'}</span>
        </span>
        <ChevronDownIcon />
      </button>

      {/* ─── Filters Panel (collapsible) ──────────────────────── */}
      {filtersOpen && (
        <div className="mx-3 mb-1 p-2.5 rounded-lg bg-surface-secondary border border-border-primary space-y-2">
          {/* Scope filter */}
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-fg-tertiary w-14 shrink-0">{t('page.searchScope') || 'Scope'}:</label>
            <div className="flex gap-1">
              {(['all', 'channel', 'direct'] as const).map(s => (
                <button
                  key={s}
                  onClick={() => search.setFilters({ scope: s })}
                  className={`px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                    search.filters.scope === s
                      ? 'bg-brand-500/15 text-brand-500 ring-1 ring-brand-500/30'
                      : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-elevated'
                  }`}
                >
                  {s === 'all' ? (t('page.searchAll') || 'All') :
                   s === 'channel' ? (t('page.searchChannel') || 'Channels') :
                   (t('page.searchDirect') || 'Direct')}
                </button>
              ))}
            </div>
          </div>

          {/* Agent filter (if agents provided) */}
          {agents && agents.length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-fg-tertiary w-14 shrink-0">{t('page.searchAgent') || 'Agent'}:</label>
              <select
                value={search.filters.agentId ?? ''}
                onChange={e => search.setFilters({ agentId: e.target.value || undefined })}
                className="flex-1 h-7 text-[11px] bg-surface-primary rounded border border-border-primary px-2 text-fg-primary focus:outline-none focus:border-brand-500/50"
              >
                <option value="">{t('page.searchAllAgents') || 'All agents'}</option>
                {agents.map(a => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {/* ─── Results Area (scrollable) ────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 pb-2 space-y-0.5 min-h-0">
        {search.status === 'idle' && search.query.length < 2 && (
          /* ── Recent Searches ── */
          <div className="py-2">
            {search.recentSearches.length > 0 && (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-fg-tertiary font-medium uppercase tracking-wider">
                    {t('page.recentSearches') || 'Recent Searches'}
                  </span>
                  <button
                    onClick={search.clearRecentSearches}
                    className="text-[10px] text-fg-tertiary hover:text-fg-primary transition-colors uppercase tracking-wider"
                  >
                    {t('common.clear') || 'Clear'}
                  </button>
                </div>
                {search.recentSearches.map(q => (
                  <button
                    key={q}
                    onClick={() => handleClickRecent(q)}
                    className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-fg-secondary hover:bg-surface-elevated transition-colors"
                  >
                    <ClockIcon />
                    <span className="truncate">{q}</span>
                  </button>
                ))}
              </>
            )}
            {search.recentSearches.length === 0 && (
              <div className="py-4 text-center">
                <p className="text-[11px] text-fg-tertiary">{t('page.noRecentSearches') || 'No recent searches'}</p>
              </div>
            )}
          </div>
        )}

        {search.status === 'searching' && (
          <div className="flex items-center justify-center py-6 gap-2">
            <div className="w-4 h-4 border-2 border-brand-500/30 border-t-brand-500 rounded-full animate-spin" />
            <span className="text-[11px] text-fg-tertiary">{t('page.searching')}</span>
          </div>
        )}

        {search.status === 'results' && search.results.length > 0 && (
          <div ref={listRef}>
            {/* Result count + speed */}
            <div className="flex items-center justify-between px-1 py-1.5 text-[10px] text-fg-tertiary/60">
              <span>
                {search.total > 0
                  ? `${search.total} ${search.total === 1 ? 'result' : 'results'}`
                  : ''}
              </span>
              {search.speedMs > 0 && (
                <span className="tabular-nums">{search.speedMs}ms</span>
              )}
            </div>

            {/* Result items */}
            {search.results.map((r, i) => (
              <div key={r.id} data-selected={i === search.selectedIndex ? 'true' : undefined}>
                <SearchResultItem
                  result={r}
                  query={search.query}
                  selected={i === search.selectedIndex}
                  onSelect={handleSelectResult}
                />
              </div>
            ))}
          </div>
        )}

        {search.status === 'empty' && (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <SearchIcon />
            <p className="text-[11px] text-fg-tertiary">{t('page.noSearchResults') || 'No messages found'}</p>
            <p className="text-[10px] text-fg-tertiary/60 max-w-[200px] text-center">
              Try different keywords or broader scope
            </p>
          </div>
        )}

        {search.status === 'error' && (
          <div className="flex flex-col items-center justify-center py-6 gap-1">
            <p className="text-[11px] text-red-500">{search.error}</p>
            <button
              onClick={() => search.triggerSearch()}
              className="text-[10px] text-brand-500 hover:text-brand-400 transition-colors"
            >
              {t('common.retry') || 'Retry'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
