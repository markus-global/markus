import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { CatalogModel, RoutingCandidate } from '../api.ts';

type ModelItem = CatalogModel & { source?: 'live' | 'catalog' | 'baseline'; tier?: 'base' | 'pro' | 'max'; provider: string };

interface ModelSelectProps {
  models: ModelItem[];
  selectedId?: string;
  onSelect: (modelId: string) => void;
  placeholder?: string;
  compact?: boolean;
}

function SourceBadge({ source }: { source?: 'live' | 'catalog' | 'baseline' }) {
  if (!source) return null;
  const cfg = {
    live: { label: 'Live', dot: 'bg-green-500', bg: 'bg-green-500/10 text-green-600 border-green-500/20' },
    catalog: { label: 'Catalog', dot: 'bg-amber-500', bg: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
    baseline: { label: 'Base', dot: 'bg-red-500', bg: 'bg-red-500/10 text-red-600 border-red-500/20' },
  }[source];
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${cfg.bg}`}>
      <span className={`w-1 h-1 rounded-full ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function TierBadge({ tier }: { tier?: 'base' | 'pro' | 'max' }) {
  if (!tier) return null;
  const cfg = {
    base: { label: 'Base', cls: 'bg-gray-500/10 text-gray-500 border-gray-500/20' },
    pro: { label: 'Pro', cls: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
    max: { label: 'Max', cls: 'bg-purple-500/10 text-purple-600 border-purple-500/20' },
  }[tier];
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

export function ModelSelect({ models, selectedId, onSelect, placeholder, compact }: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Group models by provider
  const grouped = useMemo(() => {
    const map = new Map<string, ModelItem[]>();
    for (const m of models) {
      const p = m.provider || 'unknown';
      if (!map.has(p)) map.set(p, []);
      map.get(p)!.push(m);
    }
    // Sort providers alphabetically, models within each provider
    for (const [, items] of map) {
      items.sort((a, b) => a.id.localeCompare(b.id));
    }
    return new Map([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }, [models]);

  // Flatten for keyboard navigation (provider headers are not selectable)
  const flatItems = useMemo(() => {
    const items: Array<{ type: 'header'; label: string } | { type: 'item'; model: ModelItem }> = [];
    for (const [provider, mods] of grouped) {
      const filtered = query
        ? mods.filter(m => m.id.toLowerCase().includes(query.toLowerCase()))
        : mods;
      if (filtered.length === 0) continue;
      items.push({ type: 'header' as const, label: provider });
      for (const m of filtered) {
        items.push({ type: 'item' as const, model: m });
      }
    }
    return items;
  }, [grouped, query]);

  const itemCount = flatItems.filter(i => i.type === 'item').length;

  const selected = useMemo(() => {
    return models.find(m => m.id === selectedId);
  }, [models, selectedId]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Scroll highlight into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-idx]');
    const el = items[highlightIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightIdx, open]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') {
        setOpen(true);
        e.preventDefault();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightIdx(i => Math.min(i + 1, itemCount - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightIdx(i => Math.max(i - 1, 0));
        break;
      case 'Enter': {
        e.preventDefault();
        const idx = flatItems.filter(i => i.type === 'item')[highlightIdx];
        if (idx && idx.type === 'item') {
          onSelect(idx.model.id);
          setOpen(false);
          setQuery('');
        }
        break;
      }
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        inputRef.current?.blur();
        break;
    }
  }, [open, flatItems, highlightIdx, onSelect, itemCount]);

  let itemCounter = -1;
  return (
    <div ref={containerRef} className={`relative ${compact ? '' : ''}`}>
      {/* Trigger / Input */}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={open ? query : (selected?.id || '')}
          onChange={e => { setQuery(e.target.value); setHighlightIdx(0); setOpen(true); }}
          onFocus={() => { setOpen(true); setQuery(''); }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || 'Search models...'}
          className="w-full px-3 py-2 bg-surface-overlay border border-border-default rounded-lg text-xs text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-brand-500 cursor-text"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
          {selected && selected.source && (
            <SourceBadge source={selected.source} />
          )}
          <svg className={`w-3.5 h-3.5 text-fg-tertiary transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Dropdown */}
      {open && (
        <div
          ref={listRef}
          className="absolute left-0 right-0 top-full mt-1 z-50 max-h-[360px] overflow-y-auto bg-surface-elevated border border-border-default rounded-lg shadow-xl"
          onKeyDown={handleKeyDown}
        >
          {flatItems.length === 0 ? (
            <div className="px-3 py-6 text-xs text-fg-tertiary text-center">No models found</div>
          ) : (
            flatItems.map((entry, idx) => {
              if (entry.type === 'header') {
                return (
                  <div key={`h-${entry.label}`} className="px-3 pt-2 pb-1 text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider">
                    {entry.label}
                  </div>
                );
              }
              itemCounter++;
              const mi = itemCounter;
              const isActive = entry.model.id === selectedId;
              const isHighlighted = highlightIdx === mi;
              return (
                <button
                  key={entry.model.id}
                  data-idx={mi}
                  type="button"
                  onClick={() => { onSelect(entry.model.id); setOpen(false); setQuery(''); }}
                  onMouseEnter={() => setHighlightIdx(mi)}
                  className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 transition-colors ${
                    isHighlighted ? 'bg-surface-overlay' : ''
                  } ${isActive ? 'bg-brand-500/8' : ''}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                      isActive ? 'bg-brand-500' : 'border border-border-default'
                    }`}>
                      {isActive && <div className="w-2 h-2 rounded-full bg-brand-500" />}
                    </div>
                    <span className={`text-xs truncate ${isActive ? 'text-brand-500 font-medium' : 'text-fg-primary'}`}>
                      {entry.model.id}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <SourceBadge source={(entry.model as any).source} />
                    <TierBadge tier={(entry.model as any).tier} />
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
