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

/** Optional modifiers for a global-scope selection. */
export interface GlobalScopeOptions {
  /**
   * When true (default), applying to global ALSO resets the current agent's
   * per-agent binding back to "follow global" — so the composer's shown model
   * equals both the global default and the agent's actual model (no ambiguity).
   * Internal fallback repairs pass false to avoid wiping a user's per-agent setup.
   */
  resetCurrentAgent?: boolean;
}

interface ChatModelMenuProps {
  value: ChatModelSelection | null;
  onSelect: (sel: ChatModelSelection, scope: 'global' | 'agent', opts?: GlobalScopeOptions) => void;
  /** Agent to bind a per-agent model selection to (scope 'agent'). */
  agentId?: string;
  disabled?: boolean;
}

/**
 * Compact model picker for the chat composer.
 * Two mutually-exclusive scopes:
 *   - 'agent'   (default ON) — switching updates ONLY the current agent's
 *     default model; enabling it turns off 'global' automatically.
 *   - 'global'  — switching the model updates global routing; when an agent is
 *     selected, the current agent is ALSO reset to follow global, so the shown
 *     model equals both the global default and the agent's actual model.
 * The per-agent scope is the default: picking a model writes the current
 * agent's per-agent default. Turning on 'agent' clears any session override so
 * the per-agent model is what applies to this agent (no leftover session pick).
 */
export function ChatModelMenu({ value, onSelect, agentId, disabled }: ChatModelMenuProps) {
  const { t } = useTranslation('team');
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<'global' | 'agent'>('agent');
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
    setScope('agent');
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
    if (fallback) onSelect(fallback, 'global', { resetCurrentAgent: false });
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
                aria-checked={scope === 'global'}
                disabled={!agentId}
                onClick={() => setScope('global')}
                className={`relative w-9 h-5 rounded-full transition-colors ${scope === 'global' ? 'bg-brand-600' : 'bg-fg-tertiary/30 disabled:opacity-40'}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${scope === 'global' ? 'translate-x-4' : ''}`}
                />
              </button>
            </label>
            <label className="flex items-center justify-between gap-2 px-0.5 text-xs text-fg-secondary cursor-pointer select-none">
              <span>{t('chatModel.applyAgent', { defaultValue: 'Apply to current agent' })}</span>
              <button
                type="button"
                role="switch"
                aria-checked={scope === 'agent'}
                disabled={!agentId}
                onClick={() => setScope('agent')}
                className={`relative w-9 h-5 rounded-full transition-colors ${scope === 'agent' ? 'bg-brand-600' : 'bg-fg-tertiary/30 disabled:opacity-40'}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${scope === 'agent' ? 'translate-x-4' : ''}`}
                />
              </button>
            </label>
            {!agentId && (
              <div className="px-0.5 text-[10px] text-fg-tertiary">
                {t('chatModel.noAgent', { defaultValue: 'Select an agent to apply per-agent' })}
              </div>
            )}
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
                        onSelect({ provider: p.provider, model: m.id }, scope);
                        if (scope === 'global') {
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

/** Persist a model selection at the requested scope.
 * - scope 'global': update global LLM routing (and optionally the session
 *   override). When agentId is given, ALSO reset that agent's per-agent
 *   binding to "follow global", so the composer's selected model matches the
 *   agent's actual model and the global default — no ambiguity.
 * - scope 'agent' : update ONLY the given agent's per-agent default model
 *                   (llmConfig.modelMode='custom', primary=provider,
 *                   defaultModel=model) and clear the session override so the
 *                   per-agent model is what applies.
 */
export async function applyChatModelSelection(
  sessionId: string | null,
  sel: ChatModelSelection,
  scope: 'global' | 'agent',
  agentId?: string,
  opts?: GlobalScopeOptions,
): Promise<void> {
  if (scope === 'agent') {
    if (agentId) {
      // Clear any session override so the agent's default actually applies on
      // this session (per-agent > global; session override would win, which we
      // don't want when the user picked "apply to current agent").
      if (sessionId && !sessionId.startsWith('new_')) {
        await api.sessions.setModelOverride(sessionId, null).catch(() => {});
      }
      await api.agents.updateConfig(agentId, {
        llmConfig: {
          modelMode: 'custom',
          primary: sel.provider,
          defaultModel: sel.model,
        },
      });
    }
    return;
  }
  // global scope
  // If the user picks a global model while an agent is selected, also reset
  // that agent to "follow global" — otherwise the composer shows the global
  // pick but the agent still uses its own bound model (ambiguous).
  if (agentId && opts?.resetCurrentAgent !== false) {
    await api.agents.updateConfig(agentId, {
      llmConfig: { modelMode: 'default', primary: '', defaultModel: undefined },
    }).catch(() => { /* best-effort; per-agent cache refreshes on next agent switch */ });
  }
  if (sessionId && !sessionId.startsWith('new_')) {
    await api.sessions.setModelOverride(sessionId, sel);
  }
  await api.settings.updateRouting({
    defaultProvider: sel.provider,
    routingDefaultModel: { provider: sel.provider, model: sel.model },
  });
}
