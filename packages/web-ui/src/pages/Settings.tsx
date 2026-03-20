import { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api.ts';

interface ModelCost { input: number; output: number; cacheRead?: number; cacheWrite?: number }
interface ModelDef { id: string; name: string; provider: string; contextWindow: number; maxOutputTokens: number; cost: ModelCost; reasoning?: boolean; inputTypes?: string[] }
interface ProviderInfo {
  name: string; displayName?: string; model: string; baseUrl?: string; configured: boolean;
  contextWindow?: number; maxOutputTokens?: number; cost?: ModelCost; models?: ModelDef[];
}
interface LLMSettings { defaultProvider: string; providers: Record<string, ProviderInfo> }
interface ExportPreview { available: string[]; summary: Record<string, { count: number; items: string[] }> }
interface OpenClawPreview { found: boolean; summary: { configPath: string; models?: { providerCount: number; providers: Array<{ name: string; modelCount: number; baseUrl?: string }> }; channels?: string[] } }

export function Settings() {
  const [health, setHealth] = useState<{ status: string; version: string; agents: number } | null>(null);
  const [llm, setLlm] = useState<LLMSettings | null>(null);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  // Export/Import state
  const [exportSections, setExportSections] = useState<Record<string, boolean>>({ llm: true, teams: true, agents: true });
  const [exportMsg, setExportMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [importPreview, setImportPreview] = useState<ExportPreview | null>(null);
  const [importData, setImportData] = useState<Record<string, unknown> | null>(null);
  const [importSections, setImportSections] = useState<Record<string, boolean>>({});
  const [importMsg, setImportMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const importFileRef = useRef<HTMLInputElement>(null);

  // OpenClaw import state
  const [openclawPreview, setOpenclawPreview] = useState<OpenClawPreview | null>(null);
  const [openclawLoading, setOpenclawLoading] = useState(false);
  const [openclawMsg, setOpenclawMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

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

  const saveLLM = async () => {
    if (!selectedProvider || selectedProvider === llm?.defaultProvider) return;
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}` },
        body: JSON.stringify({ defaultProvider: selectedProvider }),
      });
      const data = await res.json() as LLMSettings;
      if (res.ok) { setLlm(data); setSaveMsg({ type: 'ok', text: `Default provider updated to ${data.defaultProvider}` }); }
      else { setSaveMsg({ type: 'err', text: ((data as unknown as { error: string }).error ?? 'Save failed') }); }
    } catch { setSaveMsg({ type: 'err', text: 'Network error' }); }
    finally { setSaving(false); }
  };

  const doExport = async () => {
    const sections = Object.entries(exportSections).filter(([, v]) => v).map(([k]) => k);
    if (sections.length === 0) {
      setExportMsg({ type: 'err', text: 'Select at least one section to export' });
      return;
    }
    setExportMsg(null);
    try {
      const res = await fetch('/api/settings/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}` },
        body: JSON.stringify({ sections }),
      });
      if (!res.ok) {
        setExportMsg({ type: 'err', text: `Export failed (HTTP ${res.status})` });
        return;
      }
      const data = await res.json();
      if (!data || typeof data !== 'object') {
        setExportMsg({ type: 'err', text: 'Invalid export response' });
        return;
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `markus-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(url);
      setExportMsg({ type: 'ok', text: `Exported ${sections.length} section(s) successfully` });
    } catch {
      setExportMsg({ type: 'err', text: 'Network error during export' });
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportMsg(null);
    setImportPreview(null);
    setImportData(null);
    const text = await file.text();
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      if (!data.version || !data.sections) {
        setImportMsg({ type: 'err', text: 'Invalid config file: missing version or sections field' });
        return;
      }
      setImportData(data);
      const res = await fetch('/api/settings/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}` },
        body: JSON.stringify({ data, preview: true }),
      });
      if (!res.ok) {
        setImportMsg({ type: 'err', text: `Preview failed (HTTP ${res.status})` });
        return;
      }
      const preview = await res.json() as ExportPreview;
      if (!preview.available || preview.available.length === 0) {
        setImportMsg({ type: 'err', text: 'No importable sections found in this file' });
        return;
      }
      setImportPreview(preview);
      const sections: Record<string, boolean> = {};
      for (const k of preview.available) sections[k] = true;
      setImportSections(sections);
    } catch { setImportMsg({ type: 'err', text: 'Invalid JSON file' }); }
  };

  const doImport = async () => {
    if (!importData) return;
    const selectedCount = Object.values(importSections).filter(Boolean).length;
    if (selectedCount === 0) {
      setImportMsg({ type: 'err', text: 'Select at least one section to import' });
      return;
    }
    setImportMsg(null);
    try {
      const filteredSections: Record<string, unknown> = {};
      const allSections = (importData.sections ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(importSections)) {
        if (v && allSections[k]) filteredSections[k] = allSections[k];
      }
      const res = await fetch('/api/settings/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}` },
        body: JSON.stringify({ data: { ...importData, sections: filteredSections } }),
      });
      if (!res.ok) {
        setImportMsg({ type: 'err', text: `Import failed (HTTP ${res.status})` });
        return;
      }
      const result = await res.json() as { applied: string[]; message: string };
      setImportMsg({ type: 'ok', text: result.message });
      setImportPreview(null); setImportData(null);
      if (importFileRef.current) importFileRef.current.value = '';
      loadSettings();
    } catch { setImportMsg({ type: 'err', text: 'Import failed' }); }
  };

  const detectOpenclaw = async () => {
    setOpenclawLoading(true); setOpenclawMsg(null);
    try {
      const res = await fetch('/api/settings/import/openclaw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}` },
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}` },
        body: JSON.stringify({ preview: false }),
      });
      const data = await res.json() as { applied: boolean; appliedModels: number } | { error: string };
      if ('error' in data) { setOpenclawMsg({ type: 'err', text: data.error }); }
      else { setOpenclawMsg({ type: 'ok', text: `Imported ${data.appliedModels} model configs from OpenClaw` }); loadSettings(); }
    } catch { setOpenclawMsg({ type: 'err', text: 'Import failed' }); }
    finally { setOpenclawLoading(false); }
  };

  const configuredProviders = llm?.providers
    ? Object.entries(llm.providers).filter(([, v]) => v.configured).map(([k]) => k) : [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 h-14 flex items-center border-b border-border-default bg-surface-secondary">
        <h2 className="text-lg font-semibold">Settings</h2>
      </div>

      <div className="p-7 space-y-10 max-w-4xl">
        {/* System Status */}
        <Section title="System Status">
          {health ? (
            <div className="grid grid-cols-3 gap-4">
              <InfoCard label="Status" value={health.status === 'ok' ? 'Healthy' : health.status} color="green" />
              <InfoCard label="Version" value={health.version} color="indigo" />
              <InfoCard label="Active Agents" value={String(health.agents)} color="purple" />
            </div>
          ) : <div className="text-sm text-gray-500">Loading...</div>}
        </Section>

        {/* Default Provider */}
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
                    {configuredProviders.length > 0 ? configuredProviders.map(p => <option key={p} value={p}>{llm.providers[p]?.displayName ?? p}</option>) : <option value="">No providers configured</option>}
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

        {/* Model Providers */}
        <Section title="Model Providers & Pricing">
          <div className="space-y-3">
            {llm && Object.entries(llm.providers).map(([name, info]) => (
              <div key={name} className={`bg-surface-secondary border rounded-xl overflow-hidden transition-colors ${info.configured ? 'border-border-default hover:border-gray-600' : 'border-border-default/50 opacity-60'}`}>
                <div className="flex items-center justify-between px-5 py-4 cursor-pointer" onClick={() => setExpandedProvider(expandedProvider === name ? null : name)}>
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${info.configured ? 'bg-green-400' : 'bg-gray-600'}`} />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{info.displayName ?? name}</span>
                        {name === llm.defaultProvider && <span className="text-[10px] bg-brand-900/50 text-brand-400 px-1.5 py-0.5 rounded">default</span>}
                      </div>
                      <div className="text-xs text-gray-500 mt-0.5">{info.model || 'Not configured'}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
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
                        Configure the API key in <code className="text-gray-400">~/.markus/markus.json</code> or <code className="text-gray-400">.env</code> to enable this provider.
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="text-xs text-gray-600 px-1 mt-3">
            Configure API keys in <code className="text-gray-500">~/.markus/markus.json</code> or <code className="text-gray-500">.env</code>
          </div>
        </Section>

        <div className="border-t border-border-default" />

        {/* Export */}
        <Section title="Export Configuration">
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
            <div className="text-sm text-gray-400">Select sections to export:</div>
            <div className="flex gap-4 flex-wrap">
              {['llm', 'teams', 'agents'].map(s => (
                <label key={s} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={exportSections[s] ?? false} onChange={e => setExportSections({ ...exportSections, [s]: e.target.checked })}
                    className="w-4 h-4 rounded bg-surface-overlay border-gray-600 text-brand-500 focus:ring-brand-500" />
                  <span className="text-sm text-gray-300 capitalize">{s === 'llm' ? 'LLM Config' : s}</span>
                </label>
              ))}
            </div>
            <button onClick={() => void doExport()} className="px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white text-sm rounded-lg transition-colors">
              Export as JSON
            </button>
            {exportMsg && <Msg type={exportMsg.type} text={exportMsg.text} />}
          </div>
        </Section>

        {/* Import from file */}
        <Section title="Import Configuration">
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
            <div className="text-sm text-gray-400">Import from a previously exported Markus config file:</div>
            <input ref={importFileRef} type="file" accept=".json" onChange={e => void handleImportFile(e)}
              className="text-sm text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:bg-surface-overlay file:text-gray-300 hover:file:bg-gray-600" />

            {importPreview && (
              <div className="space-y-3 border-t border-border-default pt-4">
                <div className="text-xs text-gray-500 uppercase tracking-wider">Preview — select sections to import:</div>
                {importPreview.available.map(s => (
                  <label key={s} className="flex items-center justify-between bg-surface-elevated/30 rounded-lg px-4 py-3 cursor-pointer">
                    <div className="flex items-center gap-3">
                      <input type="checkbox" checked={importSections[s] ?? false} onChange={e => setImportSections({ ...importSections, [s]: e.target.checked })}
                        className="w-4 h-4 rounded bg-surface-overlay border-gray-600 text-brand-500 focus:ring-brand-500" />
                      <span className="text-sm text-gray-300 capitalize">{s === 'llm' ? 'LLM Config' : s}</span>
                    </div>
                    {importPreview.summary[s] && (
                      <span className="text-xs text-gray-500">{importPreview.summary[s]!.count} items: {importPreview.summary[s]!.items.slice(0, 3).join(', ')}{importPreview.summary[s]!.items.length > 3 ? '...' : ''}</span>
                    )}
                  </label>
                ))}
                <button onClick={() => void doImport()} className="px-4 py-2 bg-brand-600 hover:bg-brand-500 text-white text-sm rounded-lg transition-colors">Apply Import</button>
              </div>
            )}
            {importMsg && <Msg type={importMsg.type} text={importMsg.text} />}
          </div>
        </Section>

        {/* Import from OpenClaw */}
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
