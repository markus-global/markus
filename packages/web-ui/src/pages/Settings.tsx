import { useEffect, useState } from 'react';
import { api } from '../api.ts';

interface LLMSettings {
  defaultProvider: string;
  providers: Record<string, { model: string; configured: boolean }>;
}

export function Settings() {
  const [health, setHealth] = useState<{ status: string; version: string; agents: number } | null>(null);
  const [llm, setLlm] = useState<LLMSettings | null>(null);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
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

  const saveLLM = async () => {
    if (!selectedProvider || selectedProvider === llm?.defaultProvider) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}` },
        body: JSON.stringify({ defaultProvider: selectedProvider }),
      });
      const data = await res.json() as LLMSettings;
      if (res.ok) {
        setLlm(data);
        setSaveMsg({ type: 'ok', text: `Default provider updated to ${data.defaultProvider}` });
      } else {
        setSaveMsg({ type: 'err', text: (data as unknown as { error: string }).error ?? 'Save failed' });
      }
    } catch {
      setSaveMsg({ type: 'err', text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  const configuredProviders = llm?.providers
    ? Object.entries(llm.providers).filter(([, v]) => v.configured).map(([k]) => k)
    : [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-7 h-15 flex items-center border-b border-gray-800 bg-gray-900">
        <h2 className="text-lg font-semibold">Settings</h2>
      </div>
      <div className="p-7 space-y-8 max-w-3xl">
        {/* System Status */}
        <Section title="System Status">
          {health ? (
            <div className="grid grid-cols-3 gap-4">
              <InfoCard label="Status" value={health.status === 'ok' ? 'Healthy' : health.status} color="green" />
              <InfoCard label="Version" value={health.version} color="indigo" />
              <InfoCard label="Active Agents" value={String(health.agents)} color="purple" />
            </div>
          ) : (
            <div className="text-sm text-gray-500">Loading...</div>
          )}
        </Section>

        {/* LLM Providers */}
        <Section title="LLM Providers">
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Default Provider</div>
                <div className="text-xs text-gray-500 mt-0.5">Primary LLM provider for all agents</div>
              </div>
              <div className="flex items-center gap-3">
                {llm ? (
                  <select
                    value={selectedProvider}
                    onChange={e => { setSelectedProvider(e.target.value); setSaveMsg(null); }}
                    className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40 focus:border-indigo-500 outline-none"
                  >
                    {configuredProviders.length > 0
                      ? configuredProviders.map(p => <option key={p} value={p}>{p}</option>)
                      : <option value="">No providers configured</option>
                    }
                  </select>
                ) : (
                  <div className="text-xs text-gray-500">Loading...</div>
                )}
                {selectedProvider !== llm?.defaultProvider && (
                  <button
                    onClick={() => void saveLLM()}
                    disabled={saving}
                    className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg transition-colors"
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                )}
              </div>
            </div>

            {saveMsg && (
              <div className={`text-xs px-3 py-2 rounded-lg ${saveMsg.type === 'ok' ? 'bg-green-900/30 text-green-400 border border-green-800/40' : 'bg-red-900/20 text-red-400 border border-red-800/40'}`}>
                {saveMsg.text}
              </div>
            )}

            {/* Provider status table */}
            {llm?.providers && Object.entries(llm.providers).length > 0 && (
              <div className="border-t border-gray-800 pt-4 space-y-2">
                <div className="text-xs text-gray-500 mb-2">Configured providers (set via .env or markus.config.yaml)</div>
                {Object.entries(llm.providers).map(([name, info]) => (
                  <div key={name} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${info.configured ? 'bg-green-400' : 'bg-gray-600'}`} />
                      <span className={info.configured ? 'text-gray-300' : 'text-gray-600'}>{name}</span>
                      {name === llm.defaultProvider && (
                        <span className="text-[10px] bg-indigo-900/50 text-indigo-400 px-1.5 py-0.5 rounded">default</span>
                      )}
                    </div>
                    <span className="text-xs text-gray-500">{info.configured ? (info.model || 'configured') : 'not configured'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="text-xs text-gray-600 px-1">
            To configure API keys, edit your <code className="text-gray-500">.env</code> file (OPENAI_API_KEY, DEEPSEEK_API_KEY, ANTHROPIC_API_KEY) and restart the server.
          </div>
        </Section>

        {/* Integrations */}
        <Section title="Integrations">
          <SettingRow label="Feishu / Lark" description="Connect to Feishu for messaging and document access">
            <button className="px-4 py-1.5 text-sm border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors">Configure</button>
          </SettingRow>
          <SettingRow label="GitHub" description="Connect to GitHub for code operations">
            <button className="px-4 py-1.5 text-sm border border-gray-700 rounded-lg hover:border-indigo-500 transition-colors">Configure</button>
          </SettingRow>
        </Section>

        {/* Security */}
        <Section title="Security">
          <SettingRow label="Shell Command Policy" description="Control which shell commands agents can execute">
            <select className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40 focus:border-indigo-500 outline-none">
              <option>Default (Safe)</option>
              <option>Restricted</option>
              <option>Permissive</option>
            </select>
          </SettingRow>
          <SettingRow label="File Access Policy" description="Control which paths agents can read/write">
            <select className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm w-40 focus:border-indigo-500 outline-none">
              <option>Default (Safe)</option>
              <option>Restricted</option>
              <option>Permissive</option>
            </select>
          </SettingRow>
        </Section>
      </div>
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
