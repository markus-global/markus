import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { CatalogModel, ModelTier } from '../api';

interface ModelPickerProps {
  provider: string;
  models: CatalogModel[];
  selectedModel?: string;
  onSelect: (modelId: string) => void;
  loading?: boolean;
  compact?: boolean;
  maxVisible?: number;
  showTiers?: boolean;
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

function inferTier(model: CatalogModel): ModelTier {
  // Use server-provided tier when available
  if (model.tier) return model.tier;
  // Regex fallback for models without server data
  const id = model.id.toLowerCase();
  const maxPatterns = /opus|5\.4|o3-(?!mini)|o1-(?!mini)|gemini.*ultra|sonnet-4-20/;
  const basePatterns = /haiku|flash|nano|lite|small|fast|free|8b|7b|1b|3b/;
  // Avoid misclassifying reasoning models as base
  const proReasoningPatterns = /o4-mini|o3-mini|o1-mini|gpt-4o-mini/;
  if (proReasoningPatterns.test(id)) return 'pro';
  if (maxPatterns.test(id)) return 'max';
  if (basePatterns.test(id)) return 'base';
  return 'pro';
}

function costTier(inputCost: number, outputCost: number): string {
  const avg = (inputCost + outputCost) / 2;
  if (avg === 0) return 'free';
  if (avg < 0.5) return '$';
  if (avg < 3) return '$$';
  if (avg < 15) return '$$$';
  return '$$$$';
}

const TIER_COLORS: Record<ModelTier, string> = {
  max: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  pro: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  base: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
};

const COST_COLORS: Record<string, string> = {
  free: 'text-green-400',
  '$': 'text-green-400',
  '$$': 'text-yellow-400',
  '$$$': 'text-orange-400',
  '$$$$': 'text-red-400',
};

export function ModelPicker({ models, selectedModel, onSelect, loading, compact, maxVisible, showTiers }: ModelPickerProps) {
  const { t } = useTranslation('settings');
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [tierFilter, setTierFilter] = useState<ModelTier | ''>('');

  const filtered = useMemo(() => {
    let result = models;
    if (filter) {
      const q = filter.toLowerCase();
      result = result.filter(m => m.id.toLowerCase().includes(q));
    }
    if (tierFilter) {
      result = result.filter(m => inferTier(m) === tierFilter);
    }
    return result;
  }, [models, filter, tierFilter]);

  const tierCounts = useMemo(() => {
    const counts = { max: 0, pro: 0, base: 0 };
    for (const m of models) counts[inferTier(m)]++;
    return counts;
  }, [models]);

  const limit = maxVisible ?? (compact ? 5 : 10);
  const visible = showAll ? filtered : filtered.slice(0, limit);
  const hasMore = filtered.length > limit;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-fg-tertiary">
        <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        {t('modelPicker.loading')}
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="py-3 text-sm text-fg-tertiary">
        {t('modelPicker.empty')}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {showTiers && models.length > 3 && (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setTierFilter('')}
            className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
              !tierFilter ? 'bg-brand-500/20 text-brand-500' : 'bg-surface-overlay text-fg-tertiary hover:text-fg-secondary'
            }`}
          >
            {t('modelPicker.allCount', { count: models.length })}
          </button>
          {(['max', 'pro', 'base'] as ModelTier[]).filter(tier => tierCounts[tier] > 0).map(tier => (
            <button
              key={tier}
              onClick={() => setTierFilter(tierFilter === tier ? '' : tier)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium uppercase transition-colors border ${
                tierFilter === tier ? TIER_COLORS[tier] : 'border-transparent bg-surface-overlay text-fg-tertiary hover:text-fg-secondary'
              }`}
            >
              {t('modelPicker.tierCount', { tier: t(`modelRouting.tier.${tier}`), count: tierCounts[tier] })}
            </button>
          ))}
        </div>
      )}

      {models.length > 5 && (
        <input
          type="text"
          value={filter}
          onChange={e => { setFilter(e.target.value); setShowAll(false); }}
          placeholder={t('modelPicker.filterPlaceholder')}
          className="w-full px-3 py-1.5 bg-surface-overlay border border-border-default rounded-lg text-xs text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:border-brand-500"
        />
      )}

      <div className={`space-y-1 ${compact ? 'max-h-[280px] overflow-y-auto' : ''}`}>
        {visible.map(model => {
          const isActive = model.id === selectedModel;
          const tier = inferTier(model);
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
                  {showTiers && (
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase border ${TIER_COLORS[tier]}`}>
                      {t(`modelRouting.tier.${tier}`)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {isActive && (
                    <span className="text-[10px] text-brand-500 font-medium">{t('modelPicker.active')}</span>
                  )}
                </div>
              </div>

              {hasMetadata(model) && model.maxInputTokens > 0 && (
                <div className="ml-5 mt-0.5 flex items-center gap-2 text-[10px] text-fg-tertiary flex-wrap">
                  <span>{formatTokens(model.maxInputTokens)} {t('modelPicker.ctx')}</span>
                </div>
              )}

              {!compact && (
                <div className="ml-5 mt-1 flex items-center gap-1.5 flex-wrap">
                  {model.capabilities.functionCalling && <CapBadge label={t('modelPicker.capabilities.tools')} />}
                  {model.capabilities.vision && <CapBadge label={t('modelPicker.capabilities.vision')} />}
                  {model.capabilities.reasoning && <CapBadge label={t('modelPicker.capabilities.reasoning')} />}
                  {model.capabilities.promptCaching && <CapBadge label={t('modelPicker.capabilities.caching')} />}
                  {model.capabilities.webSearch && <CapBadge label={t('modelPicker.capabilities.search')} />}
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
          {t('modelPicker.showAll', { count: filtered.length })}
        </button>
      )}
      {showAll && hasMore && (
        <button
          type="button"
          onClick={() => setShowAll(false)}
          className="text-xs text-fg-tertiary hover:text-fg-secondary px-3"
        >
          {t('modelPicker.showLess')}
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
