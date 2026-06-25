import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';

type SearchKeyStatus = Record<string, { configured: boolean; preview: string }>;

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

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg className={`w-4 h-4 text-fg-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
    </svg>
  );
}

export function WebSearchSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const [searchKeys, setSearchKeys] = useState<SearchKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [msgs, setMsgs] = useState<Record<string, { type: 'ok' | 'err'; text: string }>>({});
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.settings.getSearch();
      if (d) setSearchKeys(d);
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

  const isConfigured = (id: string) => searchKeys?.[id]?.configured ?? false;

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
            {PROVIDERS.map(prov => {
              const configured = isConfigured(prov.id);
              const isExpanded = expanded.has(prov.id);
              const provMsg = msgs[prov.id];
              const isSaving = saving[prov.id];

              return (
                <div key={prov.id} className="bg-surface-elevated rounded-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(prov.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors text-left"
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
                          {searchKeys?.[prov.id]?.preview && (
                            <code className="text-[10px] text-fg-tertiary hidden sm:inline">{searchKeys[prov.id].preview}</code>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                          <span className="text-[10px] font-medium text-fg-tertiary">{t('searchApi.notConfigured')}</span>
                        </>
                      )}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-4 border-t border-border-default">
                      <div className="mt-3 space-y-2">
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
                        <div className="flex items-center gap-2 min-h-[20px]">
                          {isSaving && (
                            <span className="text-[10px] text-fg-tertiary flex items-center gap-1">
                              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                              </svg>
                              {t('common:saving')}
                            </span>
                          )}
                          {provMsg && (
                            <span className={`text-[10px] ${provMsg.type === 'ok' ? 'text-green-500' : 'text-red-500'}`}>
                              {provMsg.text}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* DuckDuckGo — always free */}
            <div className="bg-surface-elevated rounded-xl px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <span className="text-sm font-medium text-fg-primary">DuckDuckGo</span>
                  <span className="text-xs text-fg-tertiary ml-2">{t('searchApi.freeBackend')}</span>
                </div>
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-500/15 text-green-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                  {t('searchApi.freeLabel', { defaultValue: 'Free' })}
                </span>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
