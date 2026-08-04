import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

export interface ChatModelSelection {
  provider: string;
  model: string;
}

interface ProviderModels {
  provider: string;
  displayName: string;
  models: Array<{ id: string; name?: string }>;
}

interface ChatModelMenuProps {
  value: ChatModelSelection | null;
  onSelect: (sel: ChatModelSelection, applyToGlobal: boolean) => void;
  disabled?: boolean;
}

/**
 * Compact model picker for the chat composer.
 * "Apply to global" defaults ON — switching the model updates global routing
 * unless the user turns the toggle off for a session-only override.
 */
export function ChatModelMenu({ value, onSelect, disabled }: ChatModelMenuProps) {
  const { t } = useTranslation('team');
  const [open, setOpen] = useState(false);
  const [applyGlobal, setApplyGlobal] = useState(true);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [providers, setProviders] = useState<ProviderModels[]>([]);
  const [globalDefault, setGlobalDefault] = useState<ChatModelSelection | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings/llm', { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        defaultProvider?: string;
        routingDefaultModel?: { provider: string; model: string } | null;
        providers?: Record<string, {
          displayName?: string;
          enabled?: boolean;
          configured?: boolean;
          model?: string;
          models?: Array<{ id: string; name?: string }>;
        }>;
      };

      // If Markus is configured but catalog is still empty, force a Hub refresh.
      const markusInfo = data.providers?.['markus'];
      if (markusInfo?.configured && markusInfo.enabled !== false
          && (!markusInfo.models || markusInfo.models.length === 0)) {
        try {
          const live = await fetch('/api/models/live/markus', { credentials: 'include' });
          if (live.ok) {
            const body = await live.json() as { models?: Array<{ id: string; name?: string }> };
            if (body.models?.length) {
              markusInfo.models = body.models;
            }
          }
        } catch {
          /* non-fatal — keep empty catalog */
        }
      }

      const list: ProviderModels[] = [];
      for (const [name, info] of Object.entries(data.providers ?? {})) {
        // Only providers that are configured and switched on (same rule as Settings routing).
        if (!info.configured || info.enabled === false) continue;
        const models = (info.models ?? []).map(m => ({ id: m.id, name: m.name }));
        if (models.length === 0) continue;
        list.push({
          provider: name,
          displayName: info.displayName ?? name,
          models,
        });
      }
      list.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setProviders(list);

      const inCatalog = (sel: ChatModelSelection | null | undefined): boolean => {
        if (!sel?.provider || !sel.model) return false;
        const p = list.find(x => x.provider === sel.provider);
        return !!p?.models.some(m => m.id === sel.model);
      };

      // Prefer explicit routing default; else default provider's active model.
      let nextGlobal: ChatModelSelection | null = null;
      if (data.routingDefaultModel?.provider && data.routingDefaultModel?.model) {
        nextGlobal = {
          provider: data.routingDefaultModel.provider,
          model: data.routingDefaultModel.model,
        };
      } else if (data.defaultProvider) {
        const p = data.providers?.[data.defaultProvider];
        if (p?.model) {
          nextGlobal = { provider: data.defaultProvider, model: p.model };
        }
      }

      // Sticky RDM can outlive geo-filtered catalogs (e.g. CN drops Claude).
      // Fall back to first Markus / first available model and persist globally.
      if (nextGlobal && !inCatalog(nextGlobal)) {
        const markus = list.find(p => p.provider === 'markus');
        const fallback = markus?.models[0]
          ? { provider: 'markus', model: markus.models[0].id }
          : list[0]?.models[0]
            ? { provider: list[0].provider, model: list[0].models[0]!.id }
            : null;
        if (fallback) {
          nextGlobal = fallback;
          void api.settings.updateRouting({
            defaultProvider: fallback.provider,
            routingDefaultModel: fallback,
          }).catch(() => { /* non-fatal */ });
        } else {
          nextGlobal = null;
        }
      }
      setGlobalDefault(nextGlobal);
    } catch {
      setProviders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load once so the trigger shows the real current model without opening the menu.
  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  useEffect(() => {
    if (!open) return;
    setApplyGlobal(true);
    setQuery('');
    void loadModels();
  }, [open, loadModels]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers
      .map(p => ({
        ...p,
        models: q
          ? p.models.filter(m =>
              m.id.toLowerCase().includes(q)
              || (m.name?.toLowerCase().includes(q) ?? false)
              || p.displayName.toLowerCase().includes(q)
              || p.provider.toLowerCase().includes(q))
          : p.models,
      }))
      .filter(p => p.models.length > 0);
  }, [providers, query]);

  const selectionInCatalog = useCallback((sel: ChatModelSelection | null | undefined) => {
    if (!sel?.provider || !sel.model) return false;
    // While catalog is loading, don't treat selection as missing.
    if (providers.length === 0) return true;
    const p = providers.find(x => x.provider === sel.provider);
    return !!p?.models.some(m => m.id === sel.model);
  }, [providers]);

  // Session override can also be sticky-stale after CN catalog filter.
  useEffect(() => {
    if (!value || providers.length === 0) return;
    if (selectionInCatalog(value)) return;
    const fallback = (globalDefault && selectionInCatalog(globalDefault))
      ? globalDefault
      : (() => {
          const markus = providers.find(p => p.provider === 'markus');
          if (markus?.models[0]) return { provider: 'markus', model: markus.models[0].id };
          if (providers[0]?.models[0]) {
            return { provider: providers[0].provider, model: providers[0].models[0]!.id };
          }
          return null;
        })();
    if (fallback) onSelect(fallback, false);
  }, [value, providers, globalDefault, selectionInCatalog, onSelect]);

  const effective = (value && selectionInCatalog(value)) ? value : globalDefault;
  // Trigger shows a short model id (session override or global default).
  const shortModel = effective?.model
    ? (effective.model.includes('/') ? effective.model.split('/').pop()! : effective.model)
    : '';
  const label = shortModel || t('chatModel.title', { defaultValue: 'Model' });

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
        className="max-w-[180px] px-1.5 py-1 text-[12px] text-fg-secondary hover:text-fg-primary disabled:opacity-40 rounded-md hover:bg-surface-elevated transition-colors flex items-center gap-1"
        title={effective ? `${effective.provider}: ${effective.model}` : t('chatModel.title', { defaultValue: 'Model' })}
      >
        <span className="truncate">{label}</span>
        <svg className="w-3 h-3 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-[300px] max-h-[360px] flex flex-col rounded-xl border border-border-default bg-surface-elevated shadow-xl z-50 overflow-hidden">
          <div className="p-2 border-b border-border-default/60 space-y-2">
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('chatModel.search', { defaultValue: 'Search models' })}
              className="w-full px-2.5 py-1.5 text-xs rounded-lg bg-surface-base border border-border-default/50 outline-none focus:border-brand-500/50"
            />
            <label className="flex items-center justify-between gap-2 px-0.5 text-xs text-fg-secondary cursor-pointer select-none">
              <span>{t('chatModel.applyGlobal', { defaultValue: 'Apply to global' })}</span>
              <button
                type="button"
                role="switch"
                aria-checked={applyGlobal}
                onClick={() => setApplyGlobal(v => !v)}
                className={`relative w-9 h-5 rounded-full transition-colors ${applyGlobal ? 'bg-brand-600' : 'bg-fg-tertiary/30'}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${applyGlobal ? 'translate-x-4' : ''}`}
                />
              </button>
            </label>
          </div>

          <div className="flex-1 overflow-y-auto py-1">
            {loading && (
              <div className="px-3 py-4 text-xs text-fg-tertiary">{t('common:loading', { defaultValue: 'Loading…' })}</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-fg-tertiary">
                {t('chatModel.empty', { defaultValue: 'No enabled providers / models' })}
              </div>
            )}
            {!loading && filtered.map(p => (
              <div key={p.provider} className="mb-1">
                <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-fg-tertiary">
                  {p.displayName}
                </div>
                {p.models.slice(0, 80).map(m => {
                  const selected = effective?.provider === p.provider && effective?.model === m.id;
                  return (
                    <button
                      key={`${p.provider}:${m.id}`}
                      type="button"
                      onClick={() => {
                        onSelect({ provider: p.provider, model: m.id }, applyGlobal);
                        if (applyGlobal) {
                          setGlobalDefault({ provider: p.provider, model: m.id });
                        }
                        setOpen(false);
                      }}
                      className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-surface-base transition-colors ${selected ? 'text-fg-primary' : 'text-fg-secondary'}`}
                    >
                      <span className="truncate flex-1">{m.id}</span>
                      {selected && (
                        <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M5 12l5 5L20 7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Persist session override and optionally write global routing default. */
export async function applyChatModelSelection(
  sessionId: string | null,
  sel: ChatModelSelection,
  applyToGlobal: boolean,
): Promise<void> {
  if (sessionId && !sessionId.startsWith('new_')) {
    await api.sessions.setModelOverride(sessionId, sel);
  }
  if (applyToGlobal) {
    await api.settings.updateRouting({
      defaultProvider: sel.provider,
      routingDefaultModel: { provider: sel.provider, model: sel.model },
    });
  }
}
