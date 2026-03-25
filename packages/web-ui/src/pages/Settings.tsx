import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api.ts';

interface ModelCost { input: number; output: number; cacheRead?: number; cacheWrite?: number }
interface ModelDef { id: string; name: string; provider: string; contextWindow: number; maxOutputTokens: number; cost: ModelCost; reasoning?: boolean; inputTypes?: string[] }
interface ProviderInfo {
  name: string; displayName?: string; model: string; baseUrl?: string; configured: boolean; enabled: boolean;
  contextWindow?: number; maxOutputTokens?: number; cost?: ModelCost; models?: ModelDef[];
}
interface LLMSettings { defaultProvider: string; providers: Record<string, ProviderInfo> }
interface OpenClawPreview { found: boolean; summary: { configPath: string; models?: { providerCount: number; providers: Array<{ name: string; modelCount: number; baseUrl?: string }> }; channels?: string[] } }
interface EnvModelDetected {
  provider: string; displayName: string; apiKeySet: boolean; apiKeyPreview: string;
  model: string; baseUrl?: string; envVars: Record<string, string>;
}
interface EnvModelsResponse { detected: EnvModelDetected[]; timeoutMs?: number }

export function Settings() {
  const [health, setHealth] = useState<{ status: string; version: string; agents: number } | null>(null);
  const [llm, setLlm] = useState<LLMSettings | null>(null);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [togglingProvider, setTogglingProvider] = useState<string | null>(null);

  // OpenClaw import state
  const [openclawPreview, setOpenclawPreview] = useState<OpenClawPreview | null>(null);
  const [openclawLoading, setOpenclawLoading] = useState(false);
  const [openclawMsg, setOpenclawMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Environment variable model detection state
  const [envModels, setEnvModels] = useState<EnvModelsResponse | null>(null);
  const [envLoading, setEnvLoading] = useState(false);
  const [envMsg, setEnvMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [envSelected, setEnvSelected] = useState<Record<string, boolean>>({});
  const [envApplying, setEnvApplying] = useState(false);

  // Track whether we already triggered auto-detect for first-run
  const autoDetectDone = useRef(false);
  // Track if user dismissed the setup guide
  const [setupDismissed, setSetupDismissed] = useState(false);

  const authHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}`,
  });

  const loadSettings = useCallback(() => {
    api.health().then(setHealth).catch(() => {});
    fetch('/api/settings/llm')
      .then(r => r.ok ? r.json() as Promise<LLMSettings> : Promise.reject(r.status))
      .then(d => {
        if (d && typeof d === 'object' && 'providers' in d) {
          setLlm(d);
          setSelectedProvider(d.defaultProvider);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const detectEnvModels = useCallback(async () => {
    setEnvLoading(true); setEnvMsg(null); setEnvModels(null); setEnvSelected({});
    try {
      const res = await fetch('/api/settings/env-models', { headers: authHeaders() });
      if (!res.ok) {
        setEnvMsg({ type: 'err', text: `Detection failed (HTTP ${res.status})` });
        return;
      }
      const data = await res.json() as EnvModelsResponse;
      setEnvModels(data);
      if (data.detected.length === 0) {
        setEnvMsg({ type: 'err', text: 'No model API keys found in environment variables' });
      } else {
        const sel: Record<string, boolean> = {};
        for (const d of data.detected) sel[d.provider] = true;
        setEnvSelected(sel);
      }
    } catch { setEnvMsg({ type: 'err', text: 'Failed to detect environment variables' }); }
    finally { setEnvLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-detect env vars on first load when no providers are configured
  const hasConfiguredProviders = llm
    ? Object.values(llm.providers).some(p => p.configured)
    : false;

  useEffect(() => {
    if (llm && !hasConfiguredProviders && !autoDetectDone.current) {
      autoDetectDone.current = true;
      void detectEnvModels();
    }
  }, [llm, hasConfiguredProviders, detectEnvModels]);

  const saveLLM = async () => {
    if (!selectedProvider || selectedProvider === llm?.defaultProvider) return;
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ defaultProvider: selectedProvider }),
      });
      const data = await res.json() as LLMSettings;
      if (res.ok) { setLlm(data); setSaveMsg({ type: 'ok', text: `Default provider updated to ${data.defaultProvider}` }); }
      else { setSaveMsg({ type: 'err', text: ((data as unknown as { error: string }).error ?? 'Save failed') }); }
    } catch { setSaveMsg({ type: 'err', text: 'Network error' }); }
    finally { setSaving(false); }
  };

  const toggleProvider = async (providerName: string, enabled: boolean) => {
    setTogglingProvider(providerName);
    try {
      const res = await fetch(`/api/settings/llm/providers/${providerName}/toggle`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ enabled }),
      });
      if (res.ok) {
        const data = await res.json() as LLMSettings;
        setLlm(data);
      }
    } catch { /* ignore */ }
    finally { setTogglingProvider(null); }
  };

  const detectOpenclaw = async () => {
    setOpenclawLoading(true); setOpenclawMsg(null);
    try {
      const res = await fetch('/api/settings/import/openclaw', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ preview: true }),
      });
      const data = await res.json() as OpenClawPreview | { error: string };
      if ('error' in data) { setOpenclawMsg({ type: 'err', text: data.error }); }
      else { setOpenclawPreview(data); }
    } catch { setOpenclawMsg({ type: 'err', text: 'Detection failed' }); }
    finally { setOpenclawLoading(false); }
  };

  const importOpenclaw = async () => {
    setOpenclawLoading(true); setOpenclawMsg(null);
    try {
      const res = await fetch('/api/settings/import/openclaw', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ preview: false }),
      });
      const data = await res.json() as { applied: boolean; appliedModels: number } | { error: string };
      if ('error' in data) { setOpenclawMsg({ type: 'err', text: data.error }); }
      else { setOpenclawMsg({ type: 'ok', text: `Imported ${data.appliedModels} model configs from OpenClaw` }); loadSettings(); }
    } catch { setOpenclawMsg({ type: 'err', text: 'Import failed' }); }
    finally { setOpenclawLoading(false); }
  };

  const applyEnvModels = async () => {
    if (!envModels) return;
    const selected = envModels.detected.filter(d => envSelected[d.provider]);
    if (selected.length === 0) {
      setEnvMsg({ type: 'err', text: 'Select at least one provider to apply' });
      return;
    }
    setEnvApplying(true); setEnvMsg(null);
    try {
      const res = await fetch('/api/settings/env-models', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          providers: selected.map(d => ({
            provider: d.provider,
            model: d.model,
            baseUrl: d.baseUrl,
            enabled: true,
          })),
        }),
      });
      if (!res.ok) {
        setEnvMsg({ type: 'err', text: `Apply failed (HTTP ${res.status})` });
        return;
      }
      const data = await res.json() as { applied: string[]; message: string };
      setEnvMsg({ type: 'ok', text: data.message });
      setEnvModels(null); setEnvSelected({});
      loadSettings();
    } catch { setEnvMsg({ type: 'err', text: 'Failed to apply environment configs' }); }
    finally { setEnvApplying(false); }
  };

  const enabledProviders = llm?.providers
    ? Object.entries(llm.providers).filter(([, v]) => v.configured && v.enabled).map(([k]) => k) : [];

  const showSetupGuide = llm && !hasConfiguredProviders && !setupDismissed;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 h-14 flex items-center border-b border-border-default bg-surface-secondary">
        <h2 className="text-lg font-semibold">Settings</h2>
      </div>

      <div className="p-7 space-y-10 max-w-4xl">

        {/* ───── First-Run Setup Guide ───── */}
        {showSetupGuide && (
          <div className="relative bg-gradient-to-br from-brand-900/40 to-surface-secondary border border-brand-700/40 rounded-2xl p-6 space-y-5">
            <button onClick={() => setSetupDismissed(true)}
              className="absolute top-4 right-4 text-gray-500 hover:text-gray-300 text-xs">Skip</button>
            <div>
              <h3 className="text-base font-semibold text-gray-100">Welcome — Configure Your LLM</h3>
              <p className="text-sm text-gray-400 mt-1">Markus needs at least one LLM provider to work. Choose a way to get started:</p>
            </div>

            {/* Option 1: Environment variables (auto-detected) */}
            <SetupCard
              step="1"
              title="From Environment Variables"
              description="Automatically detected API keys from .env or system environment."
              active={!!(envModels && envModels.detected.length > 0)}
            >
              {envLoading && <div className="text-xs text-gray-500">Detecting...</div>}
              {envModels && envModels.detected.length > 0 && (
                <div className="space-y-2">
                  {envModels.detected.map(d => (
                    <label key={d.provider} className="flex items-center gap-3 bg-surface-elevated/30 rounded-lg px-3 py-2 cursor-pointer hover:bg-surface-elevated/50 transition-colors">
                      <input type="checkbox" checked={envSelected[d.provider] ?? false}
                        onChange={e => setEnvSelected({ ...envSelected, [d.provider]: e.target.checked })}
                        className="w-4 h-4 rounded bg-surface-overlay border-gray-600 text-brand-500 focus:ring-brand-500" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-gray-200">{d.displayName}</span>
                        <span className="text-xs text-gray-500 ml-2">{d.model}</span>
                      </div>
                      <code className="text-[10px] text-gray-600">{d.apiKeyPreview}</code>
                    </label>
                  ))}
                  <button onClick={() => void applyEnvModels()} disabled={envApplying || Object.values(envSelected).filter(Boolean).length === 0}
                    className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                    {envApplying ? 'Applying...' : `Apply ${Object.values(envSelected).filter(Boolean).length} Provider(s)`}
                  </button>
                </div>
              )}
              {envModels && envModels.detected.length === 0 && (
                <div className="text-xs text-gray-500">No API keys found. Set environment variables like <code className="text-gray-400">ANTHROPIC_API_KEY</code> or <code className="text-gray-400">OPENAI_API_KEY</code> and restart the server.</div>
              )}
              {envMsg && <Msg type={envMsg.type} text={envMsg.text} />}
            </SetupCard>

            {/* Option 2: OpenClaw */}
            <SetupCard
              step="2"
              title="From OpenClaw Config"
              description="Import model configs from an existing OpenClaw installation."
            >
              {!openclawPreview ? (
                <button onClick={() => void detectOpenclaw()} disabled={openclawLoading}
                  className="px-4 py-2 bg-surface-overlay hover:bg-gray-600 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                  {openclawLoading ? 'Detecting...' : 'Detect OpenClaw'}
                </button>
              ) : openclawPreview.found ? (
                <div className="space-y-2">
                  <div className="text-xs text-green-400">Found: <code className="text-gray-400">{openclawPreview.summary.configPath}</code></div>
                  {openclawPreview.summary.models && (
                    <div className="text-xs text-gray-400">{openclawPreview.summary.models.providerCount} providers, {openclawPreview.summary.models.providers.reduce((s, p) => s + p.modelCount, 0)} models</div>
                  )}
                  <button onClick={() => void importOpenclaw()} disabled={openclawLoading}
                    className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                    {openclawLoading ? 'Importing...' : 'Import Model Configs'}
                  </button>
                </div>
              ) : (
                <div className="text-xs text-gray-500">No OpenClaw config found.</div>
              )}
              {openclawMsg && <Msg type={openclawMsg.type} text={openclawMsg.text} />}
            </SetupCard>

            {/* Option 3: Manual hint */}
            <SetupCard
              step="3"
              title="Manual Configuration"
              description={<>Edit <code className="text-gray-400">~/.markus/markus.json</code> directly, then restart the server.</>}
            />
          </div>
        )}

        {/* ───── System Status ───── */}
        <Section title="System Status">
          {health ? (
            <div className="grid grid-cols-3 gap-4">
              <InfoCard label="Status" value={health.status === 'ok' ? 'Healthy' : health.status} color="green" />
              <InfoCard label="Version" value={health.version} color="indigo" />
              <InfoCard label="Active Agents" value={String(health.agents)} color="purple" />
            </div>
          ) : <div className="text-sm text-gray-500">Loading...</div>}
        </Section>

        {/* ───── Default Provider ───── */}
        <Section title="Default LLM Provider">
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Primary Provider</div>
                <div className="text-xs text-gray-500 mt-0.5">Used for all agent interactions unless overridden</div>
              </div>
              <div className="flex items-center gap-3">
                {llm ? (
                  <select value={selectedProvider} onChange={e => { setSelectedProvider(e.target.value); setSaveMsg(null); }}
                    className="px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm w-48 focus:border-brand-500 outline-none">
                    {enabledProviders.length > 0 ? enabledProviders.map(p => <option key={p} value={p}>{llm.providers[p]?.displayName ?? p}</option>) : <option value="">No providers configured</option>}
                  </select>
                ) : <div className="text-xs text-gray-500">Loading...</div>}
                {selectedProvider !== llm?.defaultProvider && (
                  <button onClick={() => void saveLLM()} disabled={saving}
                    className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white rounded-lg transition-colors">
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                )}
              </div>
            </div>
            {saveMsg && <Msg type={saveMsg.type} text={saveMsg.text} />}
          </div>
        </Section>

        {/* ───── Model Providers ───── */}
        <Section title="Model Providers & Pricing">
          <div className="space-y-3">
            {llm && Object.entries(llm.providers).map(([name, info]) => (
              <div key={name} className={`bg-surface-secondary border rounded-xl overflow-hidden transition-colors ${info.configured ? 'border-border-default hover:border-gray-600' : 'border-border-default/50 opacity-60'}`}>
                <div className="flex items-center justify-between px-5 py-4 cursor-pointer" onClick={() => setExpandedProvider(expandedProvider === name ? null : name)}>
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${info.configured && info.enabled ? 'bg-green-400' : info.configured ? 'bg-yellow-400' : 'bg-gray-600'}`} />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{info.displayName ?? name}</span>
                        {name === llm.defaultProvider && <span className="text-[10px] bg-brand-900/50 text-brand-400 px-1.5 py-0.5 rounded">default</span>}
                        {info.configured && !info.enabled && <span className="text-[10px] bg-yellow-900/50 text-yellow-400 px-1.5 py-0.5 rounded">disabled</span>}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">{info.model || 'Not configured'}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    {info.configured && (
                      <button
                        onClick={e => { e.stopPropagation(); void toggleProvider(name, !info.enabled); }}
                        disabled={togglingProvider === name}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${info.enabled ? 'bg-green-500' : 'bg-gray-600'} ${togglingProvider === name ? 'opacity-50' : ''}`}
                        title={info.enabled ? 'Click to disable' : 'Click to enable'}
                      >
                        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${info.enabled ? 'translate-x-4' : 'translate-x-1'}`} />
                      </button>
                    )}
                    {info.contextWindow && <span className="text-[10px] text-gray-500">{(info.contextWindow / 1000).toFixed(0)}K ctx</span>}
                    {info.cost && <span className="text-[10px] text-gray-500">${info.cost.input}/{info.cost.output} per 1M</span>}
                    <span className="text-gray-600 text-xs">{expandedProvider === name ? '▲' : '▼'}</span>
                  </div>
                </div>

                {expandedProvider === name && (
                  <div className="px-5 pb-4 border-t border-border-default pt-4 space-y-4">
                    {info.configured && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <MiniStat label="Model" value={info.model} />
                        <MiniStat label="Context Window" value={info.contextWindow ? `${(info.contextWindow / 1000).toFixed(0)}K tokens` : 'N/A'} />
                        <MiniStat label="Max Output" value={info.maxOutputTokens ? `${(info.maxOutputTokens / 1000).toFixed(0)}K tokens` : 'N/A'} />
                        <MiniStat label="Base URL" value={info.baseUrl ?? 'Default'} />
                      </div>
                    )}

                    {info.cost && (
                      <div className="bg-surface-elevated/40 rounded-lg p-3">
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Pricing (per 1M tokens)</div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <MiniStat label="Input" value={`$${info.cost.input}`} />
                          <MiniStat label="Output" value={`$${info.cost.output}`} />
                          {info.cost.cacheRead != null && <MiniStat label="Cache Read" value={`$${info.cost.cacheRead}`} />}
                          {info.cost.cacheWrite != null && <MiniStat label="Cache Write" value={`$${info.cost.cacheWrite}`} />}
                        </div>
                      </div>
                    )}

                    {info.models && info.models.length > 0 && (
                      <div>
                        <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Available Models</div>
                        <div className="space-y-1.5">
                          {info.models.map(m => (
                            <div key={m.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-surface-elevated/30 text-xs">
                              <div className="flex items-center gap-2">
                                <span className="text-gray-300">{m.name}</span>
                                {m.reasoning && <span className="text-[9px] bg-amber-900/40 text-amber-400 px-1 py-0.5 rounded">reasoning</span>}
                                {m.inputTypes?.includes('image') && <span className="text-[9px] bg-blue-900/40 text-blue-400 px-1 py-0.5 rounded">vision</span>}
                              </div>
                              <div className="flex items-center gap-3 text-gray-500">
                                <span>{(m.contextWindow / 1000).toFixed(0)}K ctx</span>
                                <span>${m.cost.input}/${m.cost.output}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {!info.configured && (
                      <div className="text-xs text-gray-500">
                        Configure the API key in <code className="text-gray-400">~/.markus/markus.json</code> or environment variables to enable this provider.
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="text-xs text-gray-600 px-1 mt-3">
            Configure API keys in <code className="text-gray-500">~/.markus/markus.json</code> or environment variables
          </div>
        </Section>

        <div className="border-t border-border-default" />

        {/* ───── Environment Variable Config ───── */}
        <Section title="Environment Variable Configuration">
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
            <div className="text-sm text-gray-400">Detect model API keys from environment variables and write them to the config file.</div>
            <button onClick={() => void detectEnvModels()} disabled={envLoading}
              className="px-4 py-2 bg-surface-overlay hover:bg-gray-600 disabled:opacity-40 text-white text-sm rounded-lg transition-colors flex items-center gap-2">
              <svg className={`w-4 h-4 ${envLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              {envLoading ? 'Detecting...' : 'Refresh Environment Variables'}
            </button>

            {envModels && envModels.detected.length > 0 && (
              <div className="border-t border-border-default pt-4 space-y-3">
                <div className="text-xs text-gray-500 uppercase tracking-wider">Detected Providers — select to apply:</div>
                {envModels.detected.map(d => (
                  <label key={d.provider} className="flex items-center justify-between bg-surface-elevated/30 rounded-lg px-4 py-3 cursor-pointer hover:bg-surface-elevated/50 transition-colors">
                    <div className="flex items-center gap-3">
                      <input type="checkbox" checked={envSelected[d.provider] ?? false}
                        onChange={e => setEnvSelected({ ...envSelected, [d.provider]: e.target.checked })}
                        className="w-4 h-4 rounded bg-surface-overlay border-gray-600 text-brand-500 focus:ring-brand-500" />
                      <div>
                        <div className="text-sm text-gray-200 font-medium">{d.displayName}</div>
                        <div className="text-xs text-gray-500 mt-0.5">
                          Key: <code className="text-gray-400">{d.apiKeyPreview}</code>
                          {' / '}Model: <code className="text-gray-400">{d.model}</code>
                          {d.baseUrl && <>{' / '}URL: <code className="text-gray-400">{d.baseUrl}</code></>}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-gray-600">
                      {Object.keys(d.envVars).map(k => <div key={k}><code>{k}</code></div>)}
                    </div>
                  </label>
                ))}
                {envModels.timeoutMs && (
                  <div className="text-xs text-gray-500">
                    LLM Timeout: <code className="text-gray-400">{envModels.timeoutMs}ms</code> (from <code>LLM_TIMEOUT_MS</code>)
                  </div>
                )}
                <button onClick={() => void applyEnvModels()} disabled={envApplying || Object.values(envSelected).filter(Boolean).length === 0}
                  className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                  {envApplying ? 'Applying...' : `Apply ${Object.values(envSelected).filter(Boolean).length} Provider(s) to Config`}
                </button>
              </div>
            )}
            {envMsg && <Msg type={envMsg.type} text={envMsg.text} />}
          </div>
        </Section>

        {/* ───── Import from OpenClaw ───── */}
        <Section title="Import from OpenClaw">
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
            <div className="text-sm text-gray-400">Detect and import LLM configurations from an existing OpenClaw installation.</div>
            <div className="flex gap-3">
              <button onClick={() => void detectOpenclaw()} disabled={openclawLoading}
                className="px-4 py-2 bg-surface-overlay hover:bg-gray-600 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                {openclawLoading ? 'Detecting...' : 'Detect OpenClaw Config'}
              </button>
            </div>

            {openclawPreview && openclawPreview.found && (
              <div className="border-t border-border-default pt-4 space-y-3">
                <div className="text-xs text-green-400">Found OpenClaw config at: <code className="text-gray-400">{openclawPreview.summary.configPath}</code></div>
                {openclawPreview.summary.models && (
                  <div className="bg-surface-elevated/30 rounded-lg p-3">
                    <div className="text-xs text-gray-500 mb-2">{openclawPreview.summary.models.providerCount} model providers found:</div>
                    <div className="space-y-1">
                      {openclawPreview.summary.models.providers.map(p => (
                        <div key={p.name} className="flex items-center justify-between text-xs">
                          <span className="text-gray-300">{p.name}</span>
                          <span className="text-gray-500">{p.modelCount} models {p.baseUrl ? `(${p.baseUrl})` : ''}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {openclawPreview.summary.channels && openclawPreview.summary.channels.length > 0 && (
                  <div className="bg-surface-elevated/30 rounded-lg p-3">
                    <div className="text-xs text-gray-500 mb-1">Channels: {openclawPreview.summary.channels.join(', ')}</div>
                  </div>
                )}
                <button onClick={() => void importOpenclaw()} disabled={openclawLoading}
                  className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                  {openclawLoading ? 'Importing...' : 'Import Model Configs'}
                </button>
              </div>
            )}
            {openclawMsg && <Msg type={openclawMsg.type} text={openclawMsg.text} />}
          </div>
        </Section>

        <div className="h-8" />
      </div>
    </div>
  );
}

/* ─── Shared components ─── */

function SetupCard({ step, title, description, active, children }: {
  step: string;
  title: string;
  description: React.ReactNode;
  active?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={`rounded-xl border p-4 space-y-3 transition-colors ${active ? 'border-brand-500/60 bg-brand-900/20' : 'border-border-default bg-surface-secondary/60'}`}>
      <div className="flex items-start gap-3">
        <span className="flex-none w-6 h-6 rounded-full bg-surface-overlay flex items-center justify-center text-xs font-bold text-gray-400">{step}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-200">{title}</div>
          <div className="text-xs text-gray-500 mt-0.5">{description}</div>
        </div>
      </div>
      {children && <div className="pl-9">{children}</div>}
    </div>
  );
}

function Msg({ type, text }: { type: 'ok' | 'err'; text: string }) {
  return (
    <div className={`text-xs px-3 py-2 rounded-lg ${type === 'ok' ? 'bg-green-900/30 text-green-400 border border-green-800/40' : 'bg-red-900/20 text-red-400 border border-red-800/40'}`}>
      {text}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-4">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function InfoCard({ label, value, color }: { label: string; value: string; color: string }) {
  const bg = color === 'green' ? 'bg-green-500/10 text-green-400' : color === 'indigo' ? 'bg-brand-500/10 text-brand-400' : 'bg-purple-500/10 text-purple-400';
  return (
    <div className={`rounded-xl px-5 py-4 ${bg}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs mt-1 opacity-70">{label}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 uppercase">{label}</div>
      <div className="text-xs text-gray-300 mt-0.5 truncate">{value}</div>
    </div>
  );
}
