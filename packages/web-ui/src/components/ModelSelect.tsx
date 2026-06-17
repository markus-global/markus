import { useState, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export interface ModelOption {
  provider: string;
  providerLabel: string;
  modelId: string;
  modelName: string;
  mode?: string;
  tier?: string;
  costTier?: string;
  capabilities?: string[];
}

interface Props {
  value: string;
  options: ModelOption[];
  placeholder?: string;
  onChange: (value: string) => void;
}

export function ModelSelect({ value, options, placeholder, onChange }: Props) {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(-1);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return options;
    const q = search.toLowerCase();
    return options.filter(
      o => o.modelId.toLowerCase().includes(q) ||
        o.modelName.toLowerCase().includes(q) ||
        o.provider.toLowerCase().includes(q) ||
        o.providerLabel.toLowerCase().includes(q) ||
        (o.tier && o.tier.toLowerCase().includes(q)),
    );
  }, [options, search]);

  const grouped = useMemo(() => {
    const groups = new Map<string, ModelOption[]>();
    for (const opt of filtered) {
      const key = opt.providerLabel;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(opt);
    }
    const tierOrder: Record<string, number> = { max: 0, pro: 1, base: 2 };
    for (const models of groups.values()) {
      models.sort((a, b) => (tierOrder[a.tier ?? 'base'] ?? 9) - (tierOrder[b.tier ?? 'base'] ?? 9));
    }
    return groups;
  }, [filtered]);

  const flatList = useMemo(() => {
    const items: ModelOption[] = [];
    for (const models of grouped.values()) items.push(...models);
    return items;
  }, [grouped]);

  const displayValue = useMemo(() => {
    if (!value) return placeholder ?? t('modelRouting.auto');
    const opt = options.find(o => `${o.provider}/${o.modelId}` === value);
    if (opt) return `${opt.providerLabel}/${opt.modelName}`;
    return value;
  }, [value, options, placeholder, t]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setFocusIndex(i => Math.min(i + 1, flatList.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setFocusIndex(i => Math.max(i - 1, -1));
        break;
      case 'Enter':
        e.preventDefault();
        if (focusIndex === -1) {
          onChange('');
        } else if (flatList[focusIndex]) {
          onChange(`${flatList[focusIndex].provider}/${flatList[focusIndex].modelId}`);
        }
        setOpen(false);
        setSearch('');
        break;
      case 'Escape':
        setOpen(false);
        setSearch('');
        break;
    }
  }

  useEffect(() => {
    if (listRef.current && focusIndex >= 0) {
      const el = listRef.current.querySelector(`[data-focus-index="${focusIndex}"]`) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, [focusIndex]);

  return (
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      <button
        type="button"
        onClick={() => { setOpen(!open); setSearch(''); setFocusIndex(-1); }}
        className="w-full px-2 py-1 bg-surface-overlay border border-border-default rounded text-xs text-fg-primary text-left truncate focus:outline-none focus:border-brand-500"
      >
        {displayValue}
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[240px] max-h-[280px] bg-surface-elevated border border-border-default rounded-lg shadow-xl overflow-hidden flex flex-col">
          <div className="p-1.5 border-b border-border-default">
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={e => { setSearch(e.target.value); setFocusIndex(-1); }}
              placeholder={t('modelPicker.searchPlaceholder') || 'Search models...'}
              className="w-full px-2 py-1 bg-surface-overlay border border-border-default rounded text-xs text-fg-primary focus:outline-none focus:border-brand-500"
            />
          </div>
          <div ref={listRef} className="overflow-y-auto flex-1">
            <div
              className={`px-3 py-1.5 text-xs cursor-pointer ${focusIndex === -1 ? 'bg-brand-500/20 text-brand-500' : 'text-fg-secondary hover:bg-surface-overlay'}`}
              onClick={() => { onChange(''); setOpen(false); setSearch(''); }}
            >
              {placeholder ?? t('modelRouting.auto')}
            </div>
            {[...grouped.entries()].map(([providerLabel, models]) => (
              <div key={providerLabel}>
                <div className="px-3 py-1 text-[10px] font-semibold text-fg-tertiary uppercase tracking-wider bg-surface-overlay/50 sticky top-0">
                  {providerLabel}
                </div>
                {models.map(m => {
                  const idx = flatList.indexOf(m);
                  const isActive = `${m.provider}/${m.modelId}` === value;
                  return (
                    <div
                      key={`${m.provider}/${m.modelId}`}
                      data-focus-index={idx}
                      className={`px-3 py-1.5 text-xs cursor-pointer flex items-center gap-2 ${
                        idx === focusIndex ? 'bg-brand-500/20' : isActive ? 'bg-surface-overlay' : 'hover:bg-surface-overlay/50'
                      }`}
                      onClick={() => { onChange(`${m.provider}/${m.modelId}`); setOpen(false); setSearch(''); }}
                    >
                      <span className="flex-1 truncate text-fg-primary">{m.modelName}</span>
                      {m.tier && <TierMicroBadge tier={m.tier} />}
                      {m.costTier && <span className="text-[9px] text-fg-tertiary">{m.costTier}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
            {flatList.length === 0 && (
              <div className="px-3 py-3 text-xs text-fg-tertiary text-center">{t('modelPicker.empty')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TierMicroBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    max: 'bg-purple-500/20 text-purple-400',
    pro: 'bg-blue-500/20 text-blue-400',
    base: 'bg-gray-500/20 text-gray-400',
  };
  return (
    <span className={`px-1 py-0.5 rounded text-[8px] font-bold uppercase ${colors[tier] ?? colors.base}`}>
      {tier}
    </span>
  );
}
