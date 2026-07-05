import { useState, useRef, useCallback, useEffect } from 'react';
import { api, type SearchResult } from '../api.js';

// ─── Types ────────────────────────────────────────────────────────

export type SearchScope = 'all' | 'channel' | 'direct';

export interface SearchFilters {
  scope: SearchScope;
  agentId?: string;
  channel?: string;
  sessionId?: string;
  from?: string;
  to?: string;
}

type SearchStatus = 'idle' | 'searching' | 'results' | 'empty' | 'error';

// ─── Storage helpers ──────────────────────────────────────────────

const RECENT_SEARCHES_KEY = 'markus_recent_searches';
const MAX_RECENT = 10;

function getRecentSearches(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_SEARCHES_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveSearchQuery(query: string): void {
  const recent = getRecentSearches();
  const filtered = recent.filter(q => q !== query);
  const updated = [query, ...filtered].slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
}

function removeSearchQuery(query: string): void {
  const recent = getRecentSearches();
  const updated = recent.filter(q => q !== query);
  localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
}

// ─── Hook ─────────────────────────────────────────────────────────

export function useMessageSearch(initialFilters?: Partial<SearchFilters>) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [speedMs, setSpeedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [filters, setFilters] = useState<SearchFilters>({
    scope: 'all',
    ...initialFilters,
  });
  const [recentSearches, setRecentSearches] = useState<string[]>(getRecentSearches);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController | undefined>(undefined);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const executeSearch = useCallback(async (q: string, searchFilters: SearchFilters) => {
    if (q.length < 2) {
      setResults([]);
      setTotal(0);
      setStatus('idle');
      return;
    }

    // Abort any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('searching');
    setError(null);
    setSelectedIndex(-1);

    try {
      const response = await api.messages.search(q, {
        scope: searchFilters.scope,
        channel: searchFilters.channel,
        agentId: searchFilters.agentId,
        sessionId: searchFilters.sessionId,
        from: searchFilters.from,
        to: searchFilters.to,
        limit: 30,
      });

      // If aborted, ignore result
      if (controller.signal.aborted) return;

      const resultList = response.results ?? [];
      setResults(resultList);
      setTotal(response.total ?? resultList.length);
      setSpeedMs(response.speedMs ?? 0);
      setStatus(resultList.length > 0 ? 'results' : 'empty');

      // Save to recent searches on successful search
      if (resultList.length > 0 || q.length >= 2) {
        saveSearchQuery(q);
        setRecentSearches(getRecentSearches());
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      setResults([]);
      setTotal(0);
      setError(err instanceof Error ? err.message : 'Search failed');
      setStatus('error');
    }
  }, []);

  const handleQueryChange = useCallback((q: string) => {
    setQuery(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => executeSearch(q, filters), 300);
  }, [executeSearch, filters]);

  const handleFilterChange = useCallback((newFilters: Partial<SearchFilters>) => {
    const merged = { ...filters, ...newFilters };
    setFilters(merged);
    // Re-search immediately with new filters (no debounce)
    setQuery(q => {
      executeSearch(q, merged);
      return q;
    });
  }, [filters, executeSearch]);

  const clearQuery = useCallback(() => {
    setQuery('');
    setResults([]);
    setTotal(0);
    setStatus('idle');
    setError(null);
    setSelectedIndex(-1);
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    clearQuery();
    setFilters({ scope: 'all', ...initialFilters });
  }, [clearQuery, initialFilters]);

  const clearRecentSearches = useCallback(() => {
    localStorage.removeItem(RECENT_SEARCHES_KEY);
    setRecentSearches([]);
  }, []);

  const removeRecentSearch = useCallback((q: string) => {
    removeSearchQuery(q);
    setRecentSearches(getRecentSearches());
  }, []);

  // Keyboard navigation
  const navigateUp = useCallback(() => {
    setSelectedIndex(prev => Math.max(0, prev - 1));
  }, []);

  const navigateDown = useCallback(() => {
    setSelectedIndex(prev => Math.min(results.length - 1, prev + 1));
  }, [results.length]);

  // Trigger search with existing query (for filter changes from imperative calls)
  const triggerSearch = useCallback(() => {
    if (query.length >= 2) {
      executeSearch(query, filters);
    }
  }, [query, filters, executeSearch]);

  return {
    // State
    query,
    status,
    results,
    total,
    speedMs,
    error,
    selectedIndex,
    filters,
    recentSearches,

    // Actions
    setQuery: handleQueryChange,
    setFilters: handleFilterChange,
    clearQuery,
    reset,
    clearRecentSearches,
    removeRecentSearch,
    navigateUp,
    navigateDown,
    triggerSearch,

    // Re-expose for imperative use
    executeSearch: (q: string) => executeSearch(q, filters),
  };
}
