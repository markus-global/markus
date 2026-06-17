import { useState, useMemo } from 'react';
import type { CatalogModel } from '../api';

interface ModelPickerProps {
  provider: string;
  models: CatalogModel[];
  selectedModel?: string;
  onSelect: (modelId: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  loading?: boolean;
  compact?: boolean;
  maxVisible?: number;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count % 1_000_000 === 0 ? 0 : 1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(count % 1_000 === 0 ? 0 : 0)}K`;
  return String(count);
}

function formatCost(costPer1M: number): string {
  if (costPer1M === 0) return '-';
  if (costPer1M < 0.01) return `$${costPer1M.toFixed(4)}`;
  if (costPer1M < 1) return `$${costPer1M.toFixed(2)}`;
  return `$${costPer1M.toFixed(costPer1M % 1 === 0 ? 0 : 2)}`;
}

function hasMetadata(model: CatalogModel): boolean {
  return model.maxInputTokens > 0 || model.inputCostPer1MTokens > 0 || model.outputCostPer1MTokens > 0;
}

export function ModelPicker({ models, selectedModel, onSelect, onRefresh, refreshing, loading, compact, maxVisible }: ModelPickerProps) {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [tierFilter, setTierFilter] = useState<string>('all');

  const filtered = useMemo(() => {
    if (!filter) return models;
    const q = filter.toLowerCase();
    return models.filter(m => m.id.toLowerCase().includes(q));
  }, [models, filter]);

  const tiers = useMemo(() => {
    const set = new Set(models.map(m => m.tier).filter(Boolean));
    return Array.from(set) as string[];
  }, [models]);

  const filteredByTier = useMemo(() => {
    if (!tierFilter || tierFilter === 'all') return filtered;
    return filtered.filter(m => m.tier === tierFilter);
  }, [filtered, tierFilter]);

  const displayModels = filteredByTier;

  const limit = maxVisible ?? (compact ? 5 : 10);
  const visible = showAll ? displayModels : displayModels.slice(0, limit);
  const hasMore = displayModels.length > limit;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-fg-tertiary">
        <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        Loading models...
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="py-3 text-sm text-fg-tertiary">
        No models available for this provider.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Header row: filter + refresh */}
      <div className="flex items-center gap-1.5">
        {models.length > 5 && (
          <input
            type="text"
            value={filter}
            onChange={e => { setFilter(e.target.value); setShowAll(false); }}
            placeholder="Filter models..."
            className="flex-1 px-3 py-1.5 bg-surface-overlay border border-border-default rounded-lg text-xs text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-brand-500"
          />
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="px-2 py-1.5 text-[10px] font-medium bg-surface-overlay border border-border-default rounded-lg hover:bg-surface-hover transition-colors disabled:opacity-50 flex items-center gap-1"
            title="Refresh models"
          >
            <span className={`${refreshing ? 'animate-spin' : ''}`}>⟳</span>
            {refreshing ? '···' : 'Refresh'}
          </button>
        )}
      </div>

      {/* Tier filter tabs */}
      {tiers.length > 1 && (
        <div className="flex items-center gap-1 flex-wrap">
          <button
            type="button"
            onClick={() => setTierFilter('all')}
            className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${tierFilter === 'all' ? 'bg-brand-500/10 text-brand-500 border border-brand-500/30' : 'bg-surface-overlay text-fg-tertiary border border-border-default hover:bg-surface-hover'}`}
          >
            All
          </button>
          {tiers.map(tier => (
            <button
              key={tier}
              type="button"
              onClick={() => setTierFilter(tier)}
              className={`px-2 py-0.5 text-[10px] rounded-md transition-colors ${tierFilter === tier ? 'bg-brand-500/10 text-brand-500 border border-brand-500/30' : 'bg-surface-overlay text-fg-tertiary border border-border-default hover:bg-surface-hover'}`}
            >
              {tier}
            </button>
          ))}
        </div>
      )}

      <div className={`space-y-1 ${compact ? 'max-h-[280px] overflow-y-auto' : ''}`}>
        {visible.map(model => {
          const isActive = model.id === selectedModel;
          return (
            <button
              key={model.id}
              type="button"
              onClick={() => onSelect(model.id)}
              className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                isActive
                  ? 'bg-brand-500/10 border border-brand-500/30'
                  : 'hover:bg-surface-overlay border border-transparent'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                    isActive ? 'border-brand-500' : 'border-border-default'
                  }`}>
                    {isActive && <div className="w-1.5 h-1.5 rounded-full bg-brand-500" />}
                  </div>
                  <span className={`text-xs font-medium ${isActive ? 'text-brand-500' : 'text-fg-primary'}`}>
                    {model.id}
                  </span>
                </div>
                {isActive && (
                  <span className="text-[10px] text-brand-500 font-medium">Active</span>
                )}
              </div>

              {hasMetadata(model) && (
                <div className="ml-5 mt-0.5 flex items-center gap-2 text-[10px] text-fg-tertiary flex-wrap">
                  {model.maxInputTokens > 0 && <span>{formatTokens(model.maxInputTokens)} ctx</span>}
                  {model.maxInputTokens > 0 && (model.inputCostPer1MTokens > 0 || model.outputCostPer1MTokens > 0) && <span className="text-fg-quaternary">|</span>}
                  {(model.inputCostPer1MTokens > 0 || model.outputCostPer1MTokens > 0) && (
                    <span>{formatCost(model.inputCostPer1MTokens)}/{formatCost(model.outputCostPer1MTokens)} per 1M</span>
                  )}
                </div>
              )}

              {!compact && (
                <div className="ml-5 mt-1 flex items-center gap-1.5 flex-wrap">
                  {model.capabilities.functionCalling && <CapBadge label="Tools" />}
                  {model.capabilities.vision && <CapBadge label="Vision" />}
                  {model.capabilities.reasoning && <CapBadge label="Reasoning" />}
                  {model.capabilities.promptCaching && <CapBadge label="Caching" />}
                  {model.capabilities.webSearch && <CapBadge label="Search" />}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {hasMore && !showAll && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="text-xs text-brand-500 hover:text-brand-400 px-3"
        >
          Show all {displayModels.length} models...
        </button>
      )}
      {showAll && hasMore && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="text-xs text-fg-tertiary hover:text-fg-secondary px-3"
        >
          Show less
        </button>
      )}
    </div>
  );
}

function CapBadge({ label }: { label: string }) {
  return (
    <span className="px-1.5 py-0.5 rounded text-[9px] bg-surface-overlay text-fg-tertiary border border-border-default">
      {label}
    </span>
  );
}
