import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type SearchSettingsStatus } from '../api.ts';

interface ProviderDef {
  id: string;
  labelKey: string;
  hintKey: string;
  field: string;
  extraField?: string;
  extraPlaceholderKey?: string;
}

const PROVIDERS: ProviderDef[] = [
  { id: 'serper', labelKey: 'searchApi.serper', hintKey: 'searchApi.serperHint', field: 'serperApiKey' },
  { id: 'tavily', labelKey: 'searchApi.tavily', hintKey: 'searchApi.tavilyHint', field: 'tavilyApiKey' },
  { id: 'google', labelKey: 'searchApi.google', hintKey: 'searchApi.googleHint', field: 'googleSearchApiKey', extraField: 'googleSearchCx', extraPlaceholderKey: 'searchApi.googleCxPlaceholder' },
  { id: 'bing', labelKey: 'searchApi.bing', hintKey: 'searchApi.bingHint', field: 'bingApiKey' },
  { id: 'brave', labelKey: 'searchApi.brave', hintKey: 'searchApi.braveHint', field: 'braveApiKey' },
  { id: 'serpapi', labelKey: 'searchApi.serpapi', hintKey: 'searchApi.serpapiHint', field: 'serpApiKey' },
  { id: 'exa', labelKey: 'searchApi.exa', hintKey: 'searchApi.exaHint', field: 'exaApiKey' },
  { id: 'bocha', labelKey: 'searchApi.bocha', hintKey: 'searchApi.bochaHint', field: 'bochaApiKey' },
];

const AUTO_SAVE_DELAY = 800;

/** Hosted retrieval models billed via OpenRouter (cheaper → more expensive). */
const MARKUS_SEARCH_MODELS = [
  { id: 'perplexity/sonar', labelKey: 'searchApi.modelSonar' },
  { id: 'perplexity/sonar-pro', labelKey: 'searchApi.modelSonarPro' },
] as const;

type TestResult = { ok: boolean; text: string };

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg className={`w-4 h-4 text-fg-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
    </svg>
  );
}

function Spinner({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export function WebSearchSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const [searchKeys, setSearchKeys] = useState<SearchSettingsStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [markusSaving, setMarkusSaving] = useState(false);
  const [ownKeysOpen, setOwnKeysOpen] = useState(false);
  const [msgs, setMsgs] = useState<Record<string, { type: 'ok' | 'err'; text: string }>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({});
  const [providerSaving, setProviderSaving] = useState<Record<string, boolean>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.settings.getSearch();
      if (d) {
        setSearchKeys(d);
        const anyOwn = PROVIDERS.some(p => {
          const entry = (d as unknown as Record<string, { configured?: boolean }>)[p.id];
          return !!entry?.configured;
        });
        if (anyOwn) setOwnKeysOpen(true);
      }
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { void loadKeys(); }, [loadKeys]);

  useEffect(() => () => {
    Object.values(saveTimers.current).forEach(clearTimeout);
  }, []);

  const toggleExpanded = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateField = (providerId: string, field: string, value: string) => {
    setFieldValues(prev => ({ ...prev, [field]: value }));

    if (saveTimers.current[providerId]) clearTimeout(saveTimers.current[providerId]);
    saveTimers.current[providerId] = setTimeout(() => {
      void saveProvider(providerId);
    }, AUTO_SAVE_DELAY);
  };

  const saveProvider = async (providerId: string) => {
    const provider = PROVIDERS.find(p => p.id === providerId);
    if (!provider) return;

    const mainVal = fieldValues[provider.field]?.trim();
    const extraVal = provider.extraField ? fieldValues[provider.extraField]?.trim() : undefined;
    if (!mainVal && !extraVal) return;

    setSaving(prev => ({ ...prev, [providerId]: true }));
    setMsgs(prev => { const n = { ...prev }; delete n[providerId]; return n; });

    try {
      const updates: Record<string, string> = {};
      if (mainVal) updates[provider.field] = mainVal;
      if (extraVal && provider.extraField) updates[provider.extraField] = extraVal;
      const d = await api.settings.updateSearch(updates);
      setSearchKeys(d);
      setFieldValues(prev => {
        const n = { ...prev };
        delete n[provider.field];
        if (provider.extraField) delete n[provider.extraField];
        return n;
      });
      setMsgs(prev => ({ ...prev, [providerId]: { type: 'ok', text: t('searchApi.saved') } }));
      setTimeout(() => setMsgs(prev => { const n = { ...prev }; delete n[providerId]; return n; }), 3000);
    } catch {
      setMsgs(prev => ({ ...prev, [providerId]: { type: 'err', text: t('searchApi.failedToSave') } }));
    }
    setSaving(prev => ({ ...prev, [providerId]: false }));
  };

  const keyEntry = (id: string) =>
    (searchKeys as unknown as Record<string, { configured: boolean; preview: string; enabled?: boolean }> | null)?.[id];
  const isConfigured = (id: string) => keyEntry(id)?.configured ?? false;
  const isEnabled = (id: string) => keyEntry(id)?.enabled !== false;

  const toggleProvider = async (id: string, enabled: boolean) => {
    setProviderSaving(prev => ({ ...prev, [id]: true }));
    try {
      // Field is `<id>Enabled` (e.g. serperEnabled). Cast: computed key can't be
      // statically matched to the updateSearch param type.
      const patch = { [`${id}Enabled`]: enabled } as unknown as Parameters<typeof api.settings.updateSearch>[0];
      const d = await api.settings.updateSearch(patch);
      setSearchKeys(d);
    } catch {}
    setProviderSaving(prev => ({ ...prev, [id]: false }));
  };

  const runTest = async (providerId: string) => {
    // Flush any pending auto-save so the test reflects the latest key.
    if (saveTimers.current[providerId]) {
      clearTimeout(saveTimers.current[providerId]);
      delete saveTimers.current[providerId];
      await saveProvider(providerId);
    }
    setTesting(prev => ({ ...prev, [providerId]: true }));
    setTestResults(prev => { const n = { ...prev }; delete n[providerId]; return n; });
    try {
      const r = await api.settings.testSearch(providerId);
      if (r.ok) {
        const parts = [t('searchApi.testOk', { count: r.count ?? 0 })];
        if (r.latencyMs != null) parts.push(`${r.latencyMs}ms`);
        if (r.sample?.title) parts.push(r.sample.title.slice(0, 48));
        setTestResults(prev => ({ ...prev, [providerId]: { ok: true, text: parts.join(' · ') } }));
      } else {
        setTestResults(prev => ({ ...prev, [providerId]: { ok: false, text: r.error || t('searchApi.testFailed') } }));
      }
    } catch {
      setTestResults(prev => ({ ...prev, [providerId]: { ok: false, text: t('searchApi.testFailed') } }));
    }
    setTesting(prev => ({ ...prev, [providerId]: false }));
  };

  const updateMarkus = async (patch: { useMarkusHosted?: boolean; markusSearchModel?: string }) => {
    setMarkusSaving(true);
    try {
      const d = await api.settings.updateSearch(patch);
      setSearchKeys(d);
    } catch {}
    setMarkusSaving(false);
  };

  const TestButton = ({ id, disabled }: { id: string; disabled?: boolean }) => {
    const busy = testing[id];
    return (
      <button
        type="button"
        onClick={() => void runTest(id)}
        disabled={busy || disabled}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-surface-primary border border-border-default text-fg-secondary hover:text-fg-primary hover:border-brand-500 disabled:opacity-50 transition-colors"
      >
        {busy ? <Spinner /> : (
          <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M8.5 2a6.5 6.5 0 104.096 11.553l3.925 3.925a.75.75 0 101.06-1.06l-3.925-3.925A6.5 6.5 0 008.5 2zM3.5 8.5a5 5 0 1110 0 5 5 0 01-10 0z" clipRule="evenodd" /></svg>
        )}
        {busy ? t('searchApi.testing') : t('searchApi.test')}
      </button>
    );
  };

  const TestResultLine = ({ id }: { id: string }) => {
    const r = testResults[id];
    if (!r) return null;
    return (
      <div className={`text-[11px] flex items-start gap-1.5 ${r.ok ? 'text-green-500' : 'text-red-500'}`}>
        <span className="shrink-0 mt-px">{r.ok ? '✓' : '✕'}</span>
        <span className="break-all">{r.text}</span>
      </div>
    );
  };

  // Enable/disable switch shown on each provider row. Stops propagation so
  // flipping it doesn't also expand/collapse the card.
  const ProviderToggle = ({ id }: { id: string }) => {
    const enabled = isEnabled(id);
    const busy = providerSaving[id];
    return (
      <label
        className="inline-flex items-center gap-2 cursor-pointer shrink-0"
        onClick={e => e.stopPropagation()}
        title={enabled ? t('searchApi.enabled') : t('searchApi.disabled')}
      >
        {busy && <Spinner className="w-3 h-3 text-fg-tertiary" />}
        <input
          type="checkbox"
          className="sr-only peer"
          checked={enabled}
          disabled={busy}
          onChange={e => void toggleProvider(id, e.target.checked)}
        />
        <span className="relative w-9 h-5 rounded-full bg-gray-500/40 peer-checked:bg-brand-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />
      </label>
    );
  };

  const markus = searchKeys?.markus;

  return (
    <section>
      <h3 className="text-sm font-semibold text-fg-secondary uppercase tracking-wider mb-4">
        {t('searchApi.title')}
      </h3>

      <div className="space-y-3">
        <div className="text-xs text-fg-tertiary">{t('searchApi.description')}</div>

        {loading ? (
          <div className="text-sm text-fg-tertiary py-8 text-center">{t('common:loading')}</div>
        ) : (
          <>
            {/* Markus-hosted search — primary path */}
            <div className="rounded-xl border border-border-default px-4 py-3 space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-fg-primary">{t('searchApi.markus')}</span>
                    <span className="text-[10px] font-medium text-brand-400">{t('searchApi.markusBadge')}</span>
                  </div>
                  <div className="text-xs text-fg-tertiary mt-0.5 truncate">{t('searchApi.markusHint')}</div>
                </div>
                {markus?.available && markus.enabled && <TestButton id="markus" />}
                {markus?.available ? (
                  <label className="inline-flex items-center gap-2 cursor-pointer shrink-0">
                    {markusSaving && <Spinner className="w-3 h-3 text-fg-tertiary" />}
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={markus.enabled}
                      disabled={markusSaving}
                      onChange={e => void updateMarkus({ useMarkusHosted: e.target.checked })}
                    />
                    <span className="relative w-9 h-5 rounded-full bg-gray-500/40 peer-checked:bg-brand-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:w-4 after:h-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />
                  </label>
                ) : (
                  <span className="text-[11px] text-amber-500 shrink-0">{t('searchApi.markusUnavailable')}</span>
                )}
              </div>
              {!markus?.available && (
                <div className="text-[11px] text-amber-500/90">{t('searchApi.markusUnavailableHint')}</div>
              )}
              {markus?.available && markus.enabled && (
                <div className="flex items-center gap-2 pt-1">
                  <label className="text-[11px] text-fg-tertiary shrink-0" htmlFor="markus-search-model">
                    {t('searchApi.modelLabel')}
                  </label>
                  <select
                    id="markus-search-model"
                    value={markus.markusSearchModel || 'perplexity/sonar'}
                    disabled={markusSaving}
                    onChange={e => void updateMarkus({ markusSearchModel: e.target.value })}
                    className="flex-1 min-w-0 px-2 py-1 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary outline-none focus:border-brand-500"
                  >
                    {MARKUS_SEARCH_MODELS.map(m => (
                      <option key={m.id} value={m.id}>{t(m.labelKey)}</option>
                    ))}
                    {markus.markusSearchModel
                      && !MARKUS_SEARCH_MODELS.some(m => m.id === markus.markusSearchModel) && (
                      <option value={markus.markusSearchModel}>{markus.markusSearchModel}</option>
                    )}
                  </select>
                </div>
              )}
              <div className="text-[11px] text-fg-tertiary">{t('searchApi.modelHint')}</div>
              <TestResultLine id="markus" />
            </div>

            {/* Optional BYOK search APIs — collapsed by default */}
            <div className="rounded-xl border border-border-default overflow-hidden">
              <button
                type="button"
                onClick={() => setOwnKeysOpen(v => !v)}
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02] transition-colors text-left"
              >
                <ChevronIcon expanded={ownKeysOpen} />
                <div className="flex-1 min-w-0 flex items-baseline gap-2 min-w-0">
                  <span className="text-sm font-medium text-fg-primary">{t('searchApi.ownKeysTitle')}</span>
                  <span className="text-xs text-fg-tertiary truncate">{t('searchApi.ownKeysHint')}</span>
                </div>
                <span className="text-[10px] text-fg-tertiary shrink-0 tabular-nums">
                  {PROVIDERS.filter(p => isConfigured(p.id)).length}/{PROVIDERS.length}
                </span>
              </button>

              {ownKeysOpen && (
                <div className="border-t border-border-default px-2 pb-2 space-y-1">
                  {PROVIDERS.map(prov => {
                    const configured = isConfigured(prov.id);
                    const isExpanded = expanded.has(prov.id);
                    const provMsg = msgs[prov.id];
                    const isSaving = saving[prov.id];

                    return (
                      <div key={prov.id} className="rounded-lg overflow-hidden">
                        <div className="flex items-center">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(prov.id)}
                            className={`flex-1 min-w-0 flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.02] transition-colors text-left ${configured && !isEnabled(prov.id) ? 'opacity-50' : ''}`}
                          >
                            <ChevronIcon expanded={isExpanded} />
                            <div className="flex-1 min-w-0">
                              <span className="text-sm font-medium text-fg-primary">{t(prov.labelKey)}</span>
                              <span className="text-xs text-fg-tertiary ml-2 hidden sm:inline">{t(prov.hintKey)}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {configured ? (
                                <>
                                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                                  <span className="text-[10px] font-medium text-green-500">{t('searchApi.configured')}</span>
                                </>
                              ) : (
                                <>
                                  <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                                  <span className="text-[10px] font-medium text-fg-tertiary">{t('searchApi.notConfigured')}</span>
                                </>
                              )}
                            </div>
                          </button>
                          <div className="shrink-0 pr-3 pl-2 border-l border-border-default self-stretch flex items-center">
                            <ProviderToggle id={prov.id} />
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="px-3 pb-3">
                            <div className="mt-1 space-y-2">
                              <input
                                type="password"
                                value={fieldValues[prov.field] ?? ''}
                                onChange={e => updateField(prov.id, prov.field, e.target.value)}
                                placeholder={configured ? t('modelProviders.apiKeyPlaceholder') : t('searchApi.apiKeyPlaceholder')}
                                className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none font-mono"
                              />
                              {prov.extraField && (
                                <input
                                  type="text"
                                  value={fieldValues[prov.extraField] ?? ''}
                                  onChange={e => updateField(prov.id, prov.extraField!, e.target.value)}
                                  placeholder={prov.extraPlaceholderKey ? t(prov.extraPlaceholderKey) : ''}
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none font-mono"
                                />
                              )}
                              <div className="flex items-center gap-2 min-h-[28px] flex-wrap">
                                <TestButton id={prov.id} disabled={!configured && !fieldValues[prov.field]?.trim()} />
                                {isSaving && (
                                  <span className="text-[10px] text-fg-tertiary flex items-center gap-1">
                                    <Spinner />
                                    {t('common:saving')}
                                  </span>
                                )}
                                {provMsg && (
                                  <span className={`text-[10px] ${provMsg.type === 'ok' ? 'text-green-500' : 'text-red-500'}`}>
                                    {provMsg.text}
                                  </span>
                                )}
                              </div>
                              <TestResultLine id={prov.id} />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
