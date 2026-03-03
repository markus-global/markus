import { useEffect, useState, useCallback } from 'react';
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
  const [activeTab, setActiveTab] = useState<'llm' | 'integrations' | 'export'>('llm');
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  // Export/Import state
  const [exportSections, setExportSections] = useState<Record<string, boolean>>({ llm: true, teams: true, agents: true });
  const [importPreview, setImportPreview] = useState<ExportPreview | null>(null);
  const [importData, setImportData] = useState<Record<string, unknown> | null>(null);
  const [importSections, setImportSections] = useState<Record<string, boolean>>({});
  const [importMsg, setImportMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

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
    try {
      const res = await fetch('/api/settings/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}` },
        body: JSON.stringify({ sections }),
      });
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `markus-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      setImportData(data);
      const res = await fetch('/api/settings/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}` },
        body: JSON.stringify({ data, preview: true }),
      });
      const preview = await res.json() as ExportPreview;
      setImportPreview(preview);
      const sections: Record<string, boolean> = {};
      for (const k of preview.available) sections[k] = true;
      setImportSections(sections);
    } catch { setImportMsg({ type: 'err', text: 'Invalid config file' }); }
  };

  const doImport = async () => {
    if (!importData) return;
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
      const result = await res.json() as { applied: string[]; message: string };
      setImportMsg({ type: 'ok', text: result.message });
      setImportPreview(null); setImportData(null);
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

  const tabs = [
    { id: 'llm' as const, label: 'LLM Models' },
    { id: 'integrations' as const, label: 'Integrations' },
    { id: 'export' as const, label: 'Import / Export' },
  ];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-7 h-15 flex items-center justify-between border-b border-gray-800 bg-gray-900">
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="flex gap-1 bg-gray-800 rounded-lg p-0.5">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${activeTab === t.id ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
            >{t.label}</button>
          ))}
        </div>
      </div>

      <div className="p-7 space-y-8 max-w-4xl">
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

        {activeTab === 'llm' && (
          <>
            {/* Default Provider */}
            <Section title="Default LLM Provider">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">Primary Provider</div>
                    <div className="text-xs text-gray-500 mt-0.5">Used for all agent interactions unless overridden</div>
                  </div>
                  <div className="flex items-center gap-3">
                    {llm ? (
                      <select value={selectedProvider} onChange={e => { setSelectedProvider(e.target.value); setSaveMsg(null); }}
                        className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-48 focus:border-indigo-500 outline-none">
                        {configuredProviders.length > 0 ? configuredProviders.map(p => <option key={p} value={p}>{llm.providers[p]?.displayName ?? p}</option>) : <option value="">No providers configured</option>}
                      </select>
                    ) : <div className="text-xs text-gray-500">Loading...</div>}
                    {selectedProvider !== llm?.defaultProvider && (
                      <button onClick={() => void saveLLM()} disabled={saving}
                        className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg transition-colors">
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                    )}
                  </div>
                </div>
                {saveMsg && <Msg type={saveMsg.type} text={saveMsg.text} />}
              </div>
            </Section>

            {/* Model Catalog */}
            <Section title="Model Providers & Pricing">
              <div className="space-y-3">
                {llm && Object.entries(llm.providers).map(([name, info]) => (
                  <div key={name} className={`bg-gray-900 border rounded-xl overflow-hidden transition-colors ${info.configured ? 'border-gray-800 hover:border-gray-700' : 'border-gray-800/50 opacity-60'}`}>
                    <div className="flex items-center justify-between px-5 py-4 cursor-pointer" onClick={() => setExpandedProvider(expandedProvider === name ? null : name)}>
                      <div className="flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full ${info.configured ? 'bg-green-400' : 'bg-gray-600'}`} />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{info.displayName ?? name}</span>
                            {name === llm.defaultProvider && <span className="text-[10px] bg-indigo-900/50 text-indigo-400 px-1.5 py-0.5 rounded">default</span>}
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
                      <div className="px-5 pb-4 border-t border-gray-800 pt-4 space-y-4">
                        {/* Current Config */}
                        {info.configured && (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <MiniStat label="Model" value={info.model} />
                            <MiniStat label="Context Window" value={info.contextWindow ? `${(info.contextWindow / 1000).toFixed(0)}K tokens` : 'N/A'} />
                            <MiniStat label="Max Output" value={info.maxOutputTokens ? `${(info.maxOutputTokens / 1000).toFixed(0)}K tokens` : 'N/A'} />
                            <MiniStat label="Base URL" value={info.baseUrl ?? 'Default'} />
                          </div>
                        )}

                        {/* Pricing */}
                        {info.cost && (
                          <div className="bg-gray-800/40 rounded-lg p-3">
                            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Pricing (per 1M tokens)</div>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                              <MiniStat label="Input" value={`$${info.cost.input}`} />
                              <MiniStat label="Output" value={`$${info.cost.output}`} />
                              {info.cost.cacheRead != null && <MiniStat label="Cache Read" value={`$${info.cost.cacheRead}`} />}
                              {info.cost.cacheWrite != null && <MiniStat label="Cache Write" value={`$${info.cost.cacheWrite}`} />}
                            </div>
                          </div>
                        )}

                        {/* Available models */}
                        {info.models && info.models.length > 0 && (
                          <div>
                            <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-2">Available Models</div>
                            <div className="space-y-1.5">
                              {info.models.map(m => (
                                <div key={m.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-800/30 text-xs">
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
                            Set the corresponding API key in your <code className="text-gray-400">.env</code> file to enable this provider.
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="text-xs text-gray-600 px-1 mt-3">
                Configure API keys in <code className="text-gray-500">.env</code>: <code className="text-gray-500">ANTHROPIC_API_KEY</code>, <code className="text-gray-500">OPENAI_API_KEY</code>, <code className="text-gray-500">DEEPSEEK_API_KEY</code>, <code className="text-gray-500">GOOGLE_API_KEY</code>, <code className="text-gray-500">SILICONFLOW_API_KEY</code>, <code className="text-gray-500">OPENROUTER_API_KEY</code>
              </div>
            </Section>
          </>
        )}

        {activeTab === 'integrations' && (
          <>
            <Section title="Integrations">
              <SettingRow label="Feishu / Lark" description="Connect for messaging and document access">
                <button className="px-4 py-1.5 text-sm border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors">Configure</button>
              </SettingRow>
              <SettingRow label="GitHub" description="Connect for code operations">
                <button className="px-4 py-1.5 text-sm border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors">Configure</button>
              </SettingRow>
            </Section>

            <Section title="Security">
              <SettingRow label="Shell Command Policy" description="Control which shell commands agents can execute">
                <select className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40 focus:border-indigo-500 outline-none">
                  <option>Default (Safe)</option><option>Restricted</option><option>Permissive</option>
                </select>
              </SettingRow>
              <SettingRow label="File Access Policy" description="Control which paths agents can read/write">
                <select className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40 focus:border-indigo-500 outline-none">
                  <option>Default (Safe)</option><option>Restricted</option><option>Permissive</option>
                </select>
              </SettingRow>
            </Section>
          </>
        )}

        {activeTab === 'export' && (
          <>
            {/* Export */}
            <Section title="Export Configuration">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
                <div className="text-sm text-gray-400 mb-2">Select sections to export:</div>
                <div className="flex gap-4 flex-wrap">
                  {['llm', 'teams', 'agents'].map(s => (
                    <label key={s} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={exportSections[s] ?? false} onChange={e => setExportSections({ ...exportSections, [s]: e.target.checked })}
                        className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-indigo-500 focus:ring-indigo-500" />
                      <span className="text-sm text-gray-300 capitalize">{s === 'llm' ? 'LLM Config' : s}</span>
                    </label>
                  ))}
                </div>
                <button onClick={() => void doExport()} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors">
                  Export as JSON
                </button>
              </div>
            </Section>

            {/* Import from file */}
            <Section title="Import Configuration">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
                <div className="text-sm text-gray-400">Import from a previously exported Markus config file:</div>
                <input type="file" accept=".json" onChange={e => void handleImportFile(e)}
                  className="text-sm text-gray-400 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:bg-gray-700 file:text-gray-300 hover:file:bg-gray-600" />

                {importPreview && (
                  <div className="space-y-3 border-t border-gray-800 pt-4">
                    <div className="text-xs text-gray-500 uppercase tracking-wider">Preview — select sections to import:</div>
                    {importPreview.available.map(s => (
                      <label key={s} className="flex items-center justify-between bg-gray-800/30 rounded-lg px-4 py-3 cursor-pointer">
                        <div className="flex items-center gap-3">
                          <input type="checkbox" checked={importSections[s] ?? false} onChange={e => setImportSections({ ...importSections, [s]: e.target.checked })}
                            className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-indigo-500 focus:ring-indigo-500" />
                          <span className="text-sm text-gray-300 capitalize">{s === 'llm' ? 'LLM Config' : s}</span>
                        </div>
                        {importPreview.summary[s] && (
                          <span className="text-xs text-gray-500">{importPreview.summary[s]!.count} items: {importPreview.summary[s]!.items.slice(0, 3).join(', ')}{importPreview.summary[s]!.items.length > 3 ? '...' : ''}</span>
                        )}
                      </label>
                    ))}
                    <button onClick={() => void doImport()} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm rounded-lg transition-colors">Apply Import</button>
                  </div>
                )}
                {importMsg && <Msg type={importMsg.type} text={importMsg.text} />}
              </div>
            </Section>

            {/* Import from OpenClaw */}
            <Section title="Import from OpenClaw">
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
                <div className="text-sm text-gray-400">Detect and import LLM configurations from an existing OpenClaw installation.</div>
                <div className="flex gap-3">
                  <button onClick={() => void detectOpenclaw()} disabled={openclawLoading}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                    {openclawLoading ? 'Detecting...' : 'Detect OpenClaw Config'}
                  </button>
                </div>

                {openclawPreview && openclawPreview.found && (
                  <div className="border-t border-gray-800 pt-4 space-y-3">
                    <div className="text-xs text-green-400">Found OpenClaw config at: <code className="text-gray-400">{openclawPreview.summary.configPath}</code></div>
                    {openclawPreview.summary.models && (
                      <div className="bg-gray-800/30 rounded-lg p-3">
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
                      <div className="bg-gray-800/30 rounded-lg p-3">
                        <div className="text-xs text-gray-500 mb-1">Channels: {openclawPreview.summary.channels.join(', ')}</div>
                      </div>
                    )}
                    <button onClick={() => void importOpenclaw()} disabled={openclawLoading}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                      {openclawLoading ? 'Importing...' : 'Import Model Configs'}
                    </button>
                  </div>
                )}
                {openclawMsg && <Msg type={openclawMsg.type} text={openclawMsg.text} />}
              </div>
            </Section>
          </>
        )}
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

function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl px-5 py-4">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-gray-500 mt-0.5">{description}</div>
      </div>
      {children}
    </div>
  );
}

function InfoCard({ label, value, color }: { label: string; value: string; color: string }) {
  const bg = color === 'green' ? 'bg-green-500/10 text-green-400' : color === 'indigo' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-purple-500/10 text-purple-400';
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
