import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type RoutingConfig, type CatalogModel } from '../api.ts';
import { ModelSelect } from './ModelSelect.tsx';

// ── Types ──────────────────────────────────────────────────────────

interface DraftAssignment {
  primary: string;
  fallback: string;
  enabled: boolean;
}

interface DraftConfig {
  defaultModel: string;
  autoStrategy: string;
  defaultTier: string;
  taskRouting: Record<string, DraftAssignment>;
}

function toDraft(cfg: RoutingConfig): DraftConfig {
  const taskRouting: Record<string, DraftAssignment> = {};
  for (const tr of cfg.taskRouting ?? []) {
    taskRouting[tr.taskType] = {
      primary: tr.assignment?.model ?? '',
      fallback: tr.assignment?.fallback?.model ?? '',
      enabled: tr.enabled ?? true,
    };
  }
  for (const t of TASK_TYPES) {
    if (!taskRouting[t.key]) {
      taskRouting[t.key] = { primary: '', fallback: '', enabled: true };
    }
  }
  return {
    defaultModel: cfg.defaultModel ?? '',
    autoStrategy: cfg.autoStrategy ?? 'balanced',
    defaultTier: cfg.defaultTier ?? 'pro',
    taskRouting,
  };
}

function fromDraft(d: DraftConfig): RoutingConfig {
  const taskRouting: RoutingConfig['taskRouting'] = [];
  for (const t of TASK_TYPES) {
    const a = d.taskRouting[t.key];
    if (!a) continue;
    taskRouting.push({
      taskType: t.key,
      assignment: {
        provider: a.primary ? t.key : '',
        model: a.primary,
        ...(a.fallback ? { fallback: { provider: t.key, model: a.fallback } } : {}),
      },
      enabled: a.enabled,
    });
  }
  return {
    defaultModel: d.defaultModel,
    autoStrategy: d.autoStrategy as RoutingConfig['autoStrategy'],
    defaultTier: d.defaultTier as RoutingConfig['defaultTier'],
    taskRouting,
  };
}

// ── Constants (i18n keys used in render) ────────────────────────────

const TASK_TYPES: Array<{ key: string; labelKey: string; icon: string }> = [
  { key: 'text_chat', labelKey: 'modelRouting.taskTypes.text_chat', icon: '💬' },
  { key: 'text_reasoning', labelKey: 'modelRouting.taskTypes.text_reasoning', icon: '🧠' },
  { key: 'text_coding', labelKey: 'modelRouting.taskTypes.text_coding', icon: '💻' },
  { key: 'text_translation', labelKey: 'modelRouting.taskTypes.text_translation', icon: '🌐' },
  { key: 'text_summary', labelKey: 'modelRouting.taskTypes.text_summary', icon: '📝' },
  { key: 'image_recognition', labelKey: 'modelRouting.taskTypes.image_recognition', icon: '👁️' },
  { key: 'image_generation', labelKey: 'modelRouting.taskTypes.image_generation', icon: '🎨' },
  { key: 'audio_tts', labelKey: 'modelRouting.taskTypes.audio_tts', icon: '🔊' },
  { key: 'audio_stt', labelKey: 'modelRouting.taskTypes.audio_stt', icon: '🎙️' },
  { key: 'video_generation', labelKey: 'modelRouting.taskTypes.video_generation', icon: '🎬' },
  { key: 'embedding', labelKey: 'modelRouting.taskTypes.embedding', icon: '📊' },
  { key: 'web_search', labelKey: 'modelRouting.taskTypes.web_search', icon: '🔍' },
];

const STRATEGY_OPTIONS = [
  { value: 'always_max', labelKey: 'modelRouting.strategies.alwaysMax', descKey: 'modelRouting.strategies.alwaysMaxDesc' },
  { value: 'always_cheapest', labelKey: 'modelRouting.strategies.alwaysCheapest', descKey: 'modelRouting.strategies.alwaysCheapestDesc' },
  { value: 'balanced', labelKey: 'modelRouting.strategies.balanced', descKey: 'modelRouting.strategies.balancedDesc' },
  { value: 'cache_optimized', labelKey: 'modelRouting.strategies.cacheOptimized', descKey: 'modelRouting.strategies.cacheOptimizedDesc' },
] as const;

const TIER_OPTIONS = [
  { value: 'base', labelKey: 'modelRouting.tiers.base', descKey: 'modelRouting.tiers.baseDesc' },
  { value: 'pro', labelKey: 'modelRouting.tiers.pro', descKey: 'modelRouting.tiers.proDesc' },
  { value: 'max', labelKey: 'modelRouting.tiers.max', descKey: 'modelRouting.tiers.maxDesc' },
] as const;

// ── Helper Components ──────────────────────────────────────────────

function SectionHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-sm font-semibold text-fg-primary uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  );
}

function Msg({ type, text }: { type: 'ok' | 'err'; text: string }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
      type === 'ok'
        ? 'bg-green-500/10 text-green-600 border border-green-500/30'
        : 'bg-red-500/10 text-red-600 border border-red-500/30'
    }`}>
      {type === 'ok' ? (
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
      ) : (
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
      )}
      {text}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────

export function ModelRoutingSection() {
  const { t } = useTranslation('settings');
  const [allModels, setAllModels] = useState<CatalogModel[]>([]);
  const [cfg, setCfg] = useState<RoutingConfig | null>(null);
  const [draft, setDraft] = useState<DraftConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ taskType: string; taskLabel: string; suggested: { provider: string; model: string }; reason: string }>>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const aborted = useRef(false);

  const modelItems = useCallback(() => {
    return allModels.map(m => ({
      ...m,
      provider: m.provider || 'unknown',
      source: 'catalog' as const,
      tier: 'pro' as const,
    }));
  }, [allModels]);

  // ── Initial Load (full: models + routing config) ──
  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const [modelsRes, routing] = await Promise.all([
        api.modelCatalog.getAll(),
        api.modelCatalog.getRouting(),
      ]);
      if (aborted.current) return;

      const models = modelsRes.models ?? [];
      if (modelsRes.providers) {
        for (const list of Object.values(modelsRes.providers)) {
          models.push(...list);
        }
      }

      const seen = new Set<string>();
      const unique = models.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      setAllModels(unique);
      setCfg(routing);
      setDraft(toDraft(routing));
      setDirty(false);
    } catch (e) {
      if (!aborted.current) setMsg({ type: 'err', text: `Failed to load: ${e}` });
    } finally {
      if (!aborted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    return () => { aborted.current = true; };
  }, [load]);

  // ── ⭐ P0: Manual refresh (models only, preserves routing config) ──
  const refreshModels = useCallback(async () => {
    setRefreshing(true);
    setMsg(null);
    try {
      const modelsRes = await api.modelCatalog.getAll();
      if (aborted.current) return;

      const models = modelsRes.models ?? [];
      if (modelsRes.providers) {
        for (const list of Object.values(modelsRes.providers)) {
          models.push(...list);
        }
      }

      const seen = new Set<string>();
      const unique = models.filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });

      setAllModels(unique);
      setMsg({ type: 'ok', text: t('modelRouting.refreshSuccess', { time: new Date().toLocaleTimeString() }) });
    } catch (e) {
      if (!aborted.current) setMsg({ type: 'err', text: `${t('modelRouting.refreshFailed')}: ${e}` });
    } finally {
      if (!aborted.current) setRefreshing(false);
    }
  }, [t]);

  // ── Load suggestions ──
  const loadSuggestions = useCallback(async () => {
    setSuggestionsLoading(true);
    try {
      const res = await api.modelCatalog.getSuggestedAssignments();
      setSuggestions(res.assignments ?? []);
      setSuggestionsOpen(true);
    } catch (e) {
      setMsg({ type: 'err', text: `Failed to load suggestions: ${e}` });
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  // ── Apply a suggestion ──
  const applySuggestion = useCallback((taskType: string, model: string) => {
    setDraft(p => {
      if (!p) return p;
      const cur = p.taskRouting[taskType];
      if (!cur || !model) return p;
      return {
        ...p,
        taskRouting: {
          ...p.taskRouting,
          [taskType]: { ...cur, primary: model },
        },
      };
    });
    setDirty(true);
  }, []);

  // ── Save ──
  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setMsg(null);
    try {
      const payload = fromDraft(draft);
      await api.modelCatalog.saveRouting(payload);
      setCfg(payload);
      setDirty(false);
      setMsg({ type: 'ok', text: t('modelRouting.saveSuccess') });
    } catch (e) {
      setMsg({ type: 'err', text: `${t('modelRouting.saveFailed')}: ${e}` });
    } finally {
      setSaving(false);
    }
  }, [draft, t]);

  // ── Cancel ──
  const cancel = useCallback(() => {
    if (cfg) setDraft(toDraft(cfg));
    setDirty(false);
    setMsg(null);
  }, [cfg]);

  // ── Field updaters ──
  const setDefaultModel = useCallback((m: string) => {
    setDraft(p => p ? { ...p, defaultModel: m } : p);
    setDirty(true);
  }, []);

  const setStrategy = useCallback((s: string) => {
    setDraft(p => p ? { ...p, autoStrategy: s } : p);
    setDirty(true);
  }, []);

  const setDefaultTier = useCallback((t: string) => {
    setDraft(p => p ? { ...p, defaultTier: t } : p);
    setDirty(true);
  }, []);

  const setTaskPrimary = useCallback((taskType: string, model: string) => {
    setDraft(p => {
      if (!p) return p;
      return {
        ...p,
        taskRouting: {
          ...p.taskRouting,
          [taskType]: { ...p.taskRouting[taskType], primary: model },
        },
      };
    });
    setDirty(true);
  }, []);

  const setTaskFallback = useCallback((taskType: string, model: string) => {
    setDraft(p => {
      if (!p) return p;
      return {
        ...p,
        taskRouting: {
          ...p.taskRouting,
          [taskType]: { ...p.taskRouting[taskType], fallback: model },
        },
      };
    });
    setDirty(true);
  }, []);

  const toggleTaskEnabled = useCallback((taskType: string) => {
    setDraft(p => {
      if (!p) return p;
      const cur = p.taskRouting[taskType];
      return {
        ...p,
        taskRouting: {
          ...p.taskRouting,
          [taskType]: { ...cur, enabled: !cur.enabled },
        },
      };
    });
    setDirty(true);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <svg className="w-5 h-5 animate-spin text-fg-tertiary" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="ml-2 text-sm text-fg-tertiary">{t('modelRouting.loadingCatalog')}</span>
      </div>
    );
  }

  if (!draft) {
    return <div className="text-sm text-fg-tertiary py-8 text-center">{t('modelRouting.noChanges')}</div>;
  }

  const items = modelItems();
  const curSugg = suggestions.find(s => !draft.taskRouting[s.taskType]?.primary || draft.taskRouting[s.taskType]?.primary === '');

  return (
    <div className="space-y-6">
      {/* ═══ Status message ═══ */}
      {msg && <Msg type={msg.type} text={msg.text} />}

      {/* ═══ Default model + Refresh button (P0 fix) ═══ */}
      <div>
        <SectionHead title={t('modelRouting.defaultModel')}>
          <button
            type="button"
            disabled={refreshing}
            onClick={refreshModels}
            className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium bg-surface-overlay border border-border-default rounded-md hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            {refreshing ? (
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            )}
            {refreshing ? t('modelRouting.refreshing') : t('modelRouting.refresh')}
          </button>
        </SectionHead>
        <ModelSelect
          models={items}
          selectedId={draft.defaultModel}
          onSelect={setDefaultModel}
          placeholder={t('modelRouting.selectDefaultModel')}
        />
      </div>

      {/* ═══ Strategy + Tier ═══ */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <SectionHead title={t('modelRouting.autoStrategy')} />
          <select
            value={draft.autoStrategy}
            onChange={e => setStrategy(e.target.value)}
            className="w-full px-3 py-2 bg-surface-overlay border border-border-default rounded-lg text-xs text-fg-primary focus:outline-none focus:border-brand-500"
          >
            {STRATEGY_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
            ))}
          </select>
          <p className="text-[10px] text-fg-tertiary mt-1">
            {t(STRATEGY_OPTIONS.find(o => o.value === draft.autoStrategy)?.descKey ?? '')}
          </p>
        </div>

        <div>
          <SectionHead title={t('modelRouting.defaultTier')} />
          <select
            value={draft.defaultTier}
            onChange={e => setDefaultTier(e.target.value)}
            className="w-full px-3 py-2 bg-surface-overlay border border-border-default rounded-lg text-xs text-fg-primary focus:outline-none focus:border-brand-500"
          >
            {TIER_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
            ))}
          </select>
          <p className="text-[10px] text-fg-tertiary mt-1">
            {t(TIER_OPTIONS.find(o => o.value === draft.defaultTier)?.descKey ?? '')}
          </p>
        </div>
      </div>

      {/* ═══ Top suggestion banner ═══ */}
      {curSugg && (
        <div className="flex items-center gap-3 px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg">
          <span className="text-xs text-amber-600">{t('modelRouting.suggest')}: <strong>{curSugg.suggested.model}</strong> → <strong>{curSugg.taskLabel}</strong></span>
          <button
            type="button"
            onClick={() => applySuggestion(curSugg.taskType, curSugg.suggested.model)}
            className="px-2.5 py-1 text-[10px] font-medium bg-amber-500/20 text-amber-600 rounded-md hover:bg-amber-500/30 transition-colors"
          >
            {t('modelRouting.apply')}
          </button>
        </div>
      )}

      {/* ═══ Suggestions panel ═══ */}
      {suggestionsOpen && suggestions.length > 0 && (
        <div className="bg-surface-overlay border border-border-default rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between mb-1">
            <h4 className="text-xs font-semibold text-fg-primary">{t('modelRouting.suggest')}</h4>
            <button
              type="button"
              onClick={() => setSuggestionsOpen(false)}
              className="text-[10px] text-fg-tertiary hover:text-fg-primary transition-colors"
            >
              {t('modelRouting.close')}
            </button>
          </div>
          <div className="space-y-1.5">
            {suggestions.map(s => {
              const cur = draft.taskRouting[s.taskType];
              const isApplied = cur?.primary === s.suggested.model;
              return (
                <div key={s.taskType} className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-surface-hover transition-colors">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-medium text-fg-primary">{s.taskLabel}</span>
                    <span className="text-[10px] text-fg-tertiary truncate">{s.reason}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <code className="text-[10px] px-1.5 py-0.5 bg-surface-hover rounded text-fg-secondary">{s.suggested.model}</code>
                    {isApplied ? (
                      <span className="text-[10px] text-green-600 font-medium">{t('modelRouting.refreshDone')} ✓</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => applySuggestion(s.taskType, s.suggested.model)}
                        className="px-2 py-0.5 text-[10px] font-medium bg-brand-500/10 text-brand-600 rounded-md hover:bg-brand-500/20 transition-colors"
                      >
                        {t('modelRouting.suggest')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ Task routing table ═══ */}
      <div>
        <SectionHead title={t('modelRouting.taskTypeRouting')}>
          <button
            type="button"
            disabled={suggestionsLoading}
            onClick={loadSuggestions}
            className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium bg-surface-overlay border border-border-default rounded-md hover:bg-surface-hover transition-colors disabled:opacity-50"
          >
            {suggestionsLoading ? (
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            ) : (
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            )}
            {suggestionsLoading ? t('modelRouting.suggestLoading') : t('modelRouting.suggest')}
          </button>
        </SectionHead>

        <div className="space-y-1.5">
          {TASK_TYPES.map(task => {
            const a = draft.taskRouting[task.key];
            if (!a) return null;
            return (
              <div key={task.key} className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-colors ${
                a.enabled ? 'border-border-default bg-surface' : 'border-border-default/50 bg-surface/50 opacity-60'
              }`}>
                {/* Enabled toggle */}
                <button
                  type="button"
                  onClick={() => toggleTaskEnabled(task.key)}
                  className={`w-4 h-4 rounded flex items-center justify-center border transition-colors ${
                    a.enabled
                      ? 'bg-brand-500 border-brand-500 text-white'
                      : 'border-border-default bg-surface-overlay'
                  }`}
                >
                  {a.enabled && (
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>

                {/* Task type label (i18n) */}
                <span className="text-xs font-medium text-fg-primary w-36 shrink-0">
                  {task.icon} {t(task.labelKey)}
                </span>

                {/* Primary model */}
                <div className="flex-1 min-w-0">
                  <ModelSelect
                    models={items}
                    selectedId={a.primary}
                    onSelect={(m) => setTaskPrimary(task.key, m)}
                    placeholder={t('modelRouting.selectDefaultModel')}
                    compact
                  />
                </div>

                {/* Fallback model */}
                <div className="flex-1 min-w-0">
                  <ModelSelect
                    models={items}
                    selectedId={a.fallback}
                    onSelect={(m) => setTaskFallback(task.key, m)}
                    placeholder={t('modelRouting.selectDefaultModel')}
                    compact
                  />
                </div>

                {/* Clear fallback */}
                {a.fallback && (
                  <button
                    type="button"
                    onClick={() => setTaskFallback(task.key, '')}
                    className="p-1 text-fg-tertiary hover:text-fg-primary transition-colors"
                    title={t('modelRouting.clearFallback')}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══ Action bar ═══ */}
      <div className="flex items-center justify-between pt-2">
        <div className="flex items-center gap-2">
          {dirty && !msg && (
            <span className="text-[10px] text-amber-600 font-medium">{t('modelRouting.unsavedChanges')}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={cancel}
            disabled={!dirty || saving}
            className="px-4 py-2 text-xs font-medium text-fg-primary bg-surface-overlay border border-border-default rounded-lg hover:bg-surface-hover transition-colors disabled:opacity-40"
          >
            {t('modelRouting.cancel')}
          </button>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-brand-500 rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-50"
          >
            {saving && (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {saving ? t('modelRouting.saving') : t('modelRouting.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
