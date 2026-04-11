import { useEffect, useState, useCallback, useRef } from 'react';
import { api, type StorageInfo, type OrphanInfo } from '../api.ts';
import type { ThemeMode } from '../hooks/useTheme.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';

interface ModelCost { input: number; output: number; cacheRead?: number; cacheWrite?: number }
interface ModelDef { id: string; name: string; provider: string; contextWindow: number; maxOutputTokens: number; cost: ModelCost; reasoning?: boolean; inputTypes?: string[] }
interface ProviderInfo {
  name: string; displayName?: string; model: string; baseUrl?: string; configured: boolean; enabled: boolean;
  contextWindow?: number; maxOutputTokens?: number; cost?: ModelCost; models?: ModelDef[];
  authType?: string; oauthConnected?: boolean; oauthAccountId?: string;
}
interface LLMSettings { defaultProvider: string; providers: Record<string, ProviderInfo> }
interface OAuthProvider { name: string; displayName: string }
interface AuthProfileSafe {
  id: string; provider: string; authType: string; label?: string;
  createdAt: number; updatedAt: number;
  hasApiKey: boolean; hasOAuth: boolean; oauthExpired?: boolean; accountId?: string;
}
interface OpenClawPreview { found: boolean; summary: { configPath: string; models?: { providerCount: number; providers: Array<{ name: string; modelCount: number; baseUrl?: string }> }; channels?: string[] } }
interface EnvModelDetected {
  provider: string; displayName: string; apiKeySet: boolean; apiKeyPreview: string;
  model: string; baseUrl?: string; envVars: Record<string, string>;
}
interface EnvModelsResponse { detected: EnvModelDetected[]; timeoutMs?: number }

export function Settings({ theme, onThemeChange }: { theme?: ThemeMode; onThemeChange?: (m: ThemeMode) => void } = {}) {
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

  // OAuth state
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfileSafe[]>([]);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [oauthMsg, setOauthMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [manualCallbackUrl, setManualCallbackUrl] = useState('');
  const [pendingOAuthProvider, setPendingOAuthProvider] = useState<string | null>(null);
  const oauthPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track whether we already triggered auto-detect for first-run
  const autoDetectDone = useRef(false);
  // Track if user dismissed the setup guide
  const [setupDismissed, setSetupDismissed] = useState(false);

  // Agent settings
  const [agentMaxIter, setAgentMaxIter] = useState(200);
  const [agentSaving, setAgentSaving] = useState(false);
  const [agentMsg, setAgentMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Storage transparency
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());
  const [orphanInfo, setOrphanInfo] = useState<OrphanInfo | null>(null);
  const [orphanLoading, setOrphanLoading] = useState(false);

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

  const loadOAuthProviders = useCallback(() => {
    fetch('/api/settings/oauth/providers')
      .then(r => r.ok ? r.json() as Promise<{ providers: OAuthProvider[] }> : Promise.reject(r.status))
      .then(d => setOauthProviders(d.providers ?? []))
      .catch(() => {});
  }, []);

  const loadAuthProfiles = useCallback(() => {
    fetch('/api/settings/oauth/profiles', { headers: authHeaders() })
      .then(r => r.ok ? r.json() as Promise<{ profiles: AuthProfileSafe[] }> : Promise.reject(r.status))
      .then(d => setAuthProfiles(d.profiles ?? []))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAgentSettings = useCallback(() => {
    api.settings.getAgent()
      .then(d => { if (d && typeof d.maxToolIterations === 'number') setAgentMaxIter(d.maxToolIterations); })
      .catch(() => {});
  }, []);

  const loadStorage = useCallback(() => {
    setStorageLoading(true);
    api.system.storage().then(setStorageInfo).catch(() => {}).finally(() => setStorageLoading(false));
    api.system.orphans().then(setOrphanInfo).catch(() => {});
  }, []);

  useEffect(() => { loadSettings(); loadOAuthProviders(); loadAuthProfiles(); loadAgentSettings(); loadStorage(); }, [loadSettings, loadOAuthProviders, loadAuthProfiles, loadAgentSettings, loadStorage]);

  useEffect(() => {
    const handler = () => loadStorage();
    window.addEventListener('markus:data-changed', handler);
    return () => window.removeEventListener('markus:data-changed', handler);
  }, [loadStorage]);

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

  const startOAuthLogin = async (provider: string) => {
    setOauthLoading(provider); setOauthMsg(null);
    try {
      const res = await fetch('/api/settings/oauth/login', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ provider }),
      });
      const data = await res.json() as { authorizeUrl?: string; error?: string };
      if (!res.ok || data.error) {
        setOauthMsg({ type: 'err', text: data.error ?? 'Login failed' });
        return;
      }
      if (data.authorizeUrl) {
        window.open(data.authorizeUrl, '_blank', 'noopener');
        setPendingOAuthProvider(provider);
        setOauthMsg({ type: 'ok', text: 'Browser opened for authorization. Complete the login in the browser window...' });
        // Start polling for completion
        if (oauthPollRef.current) clearInterval(oauthPollRef.current);
        oauthPollRef.current = setInterval(async () => {
          try {
            const statusRes = await fetch(`/api/settings/oauth/status?provider=${provider}`, { headers: authHeaders() });
            const statusData = await statusRes.json() as { pending: boolean; profiles: AuthProfileSafe[] };
            if (!statusData.pending && statusData.profiles.some(p => p.provider === provider && p.hasOAuth)) {
              if (oauthPollRef.current) clearInterval(oauthPollRef.current);
              oauthPollRef.current = null;
              setPendingOAuthProvider(null);
              setAuthProfiles(statusData.profiles);
              setOauthMsg({ type: 'ok', text: `Connected to ${provider} via OAuth` });
              loadSettings();
            }
          } catch { /* continue polling */ }
        }, 2000);
      }
    } catch { setOauthMsg({ type: 'err', text: 'Network error during OAuth login' }); }
    finally { setOauthLoading(null); }
  };

  const handleManualCallback = async () => {
    if (!manualCallbackUrl.trim()) return;
    setOauthLoading('manual'); setOauthMsg(null);
    try {
      const res = await fetch('/api/settings/oauth/callback', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ callbackUrl: manualCallbackUrl }),
      });
      const data = await res.json() as { profile?: { id: string; provider: string }; error?: string };
      if (!res.ok || data.error) {
        setOauthMsg({ type: 'err', text: data.error ?? 'Callback failed' });
        return;
      }
      setOauthMsg({ type: 'ok', text: `Connected to ${data.profile?.provider ?? 'provider'} via OAuth` });
      setManualCallbackUrl('');
      setPendingOAuthProvider(null);
      if (oauthPollRef.current) { clearInterval(oauthPollRef.current); oauthPollRef.current = null; }
      loadAuthProfiles(); loadSettings();
    } catch { setOauthMsg({ type: 'err', text: 'Network error' }); }
    finally { setOauthLoading(null); }
  };

  const deleteAuthProfile = async (profileId: string) => {
    try {
      const res = await fetch(`/api/settings/oauth/profiles/${encodeURIComponent(profileId)}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      if (res.ok) {
        loadAuthProfiles(); loadSettings();
        setOauthMsg({ type: 'ok', text: 'Auth profile deleted' });
      }
    } catch { /* ignore */ }
  };

  // Cleanup polling on unmount
  useEffect(() => () => {
    if (oauthPollRef.current) clearInterval(oauthPollRef.current);
  }, []);

  // Add/Edit/Delete provider state
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [addProviderForm, setAddProviderForm] = useState({ name: '', apiKey: '', baseUrl: '', model: '', contextWindow: 128000, maxOutputTokens: 16384, costInput: 1, costOutput: 5 });
  const [addProviderSaving, setAddProviderSaving] = useState(false);
  const [addProviderMsg, setAddProviderMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editProviderForm, setEditProviderForm] = useState({ apiKey: '', baseUrl: '', model: '', contextWindow: 0, maxOutputTokens: 0, costInput: 0, costOutput: 0 });
  const [editProviderSaving, setEditProviderSaving] = useState(false);
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null);

  // Add custom model state
  const [addingModelProvider, setAddingModelProvider] = useState<string | null>(null);
  const [addModelForm, setAddModelForm] = useState({ id: '', name: '', contextWindow: 128000, maxOutputTokens: 16384, costInput: 1, costOutput: 5, reasoning: false, vision: false });
  const [addModelSaving, setAddModelSaving] = useState(false);

  const addProvider = async () => {
    if (!addProviderForm.name || !addProviderForm.model) return;
    setAddProviderSaving(true); setAddProviderMsg(null);
    try {
      const res = await fetch('/api/settings/llm/providers', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          name: addProviderForm.name,
          apiKey: addProviderForm.apiKey || undefined,
          baseUrl: addProviderForm.baseUrl || undefined,
          model: addProviderForm.model,
          contextWindow: addProviderForm.contextWindow || undefined,
          maxOutputTokens: addProviderForm.maxOutputTokens || undefined,
          cost: (addProviderForm.costInput || addProviderForm.costOutput)
            ? { input: addProviderForm.costInput, output: addProviderForm.costOutput }
            : undefined,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setLlm(data as LLMSettings);
        setShowAddProvider(false);
        setAddProviderForm({ name: '', apiKey: '', baseUrl: '', model: '', contextWindow: 128000, maxOutputTokens: 16384, costInput: 1, costOutput: 5 });
        setAddProviderMsg({ type: 'ok', text: `Provider ${addProviderForm.name} added` });
      } else {
        setAddProviderMsg({ type: 'err', text: (data as { error: string }).error ?? 'Failed to add' });
      }
    } catch { setAddProviderMsg({ type: 'err', text: 'Network error' }); }
    finally { setAddProviderSaving(false); }
  };

  const startEditProvider = (name: string, info: ProviderInfo) => {
    setEditingProvider(name);
    setEditProviderForm({
      apiKey: '', baseUrl: info.baseUrl ?? '', model: info.model,
      contextWindow: info.contextWindow ?? 0,
      maxOutputTokens: info.maxOutputTokens ?? 0,
      costInput: info.cost?.input ?? 0,
      costOutput: info.cost?.output ?? 0,
    });
  };

  const saveEditProvider = async (name: string) => {
    setEditProviderSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (editProviderForm.apiKey) body.apiKey = editProviderForm.apiKey;
      if (editProviderForm.baseUrl !== undefined) body.baseUrl = editProviderForm.baseUrl;
      if (editProviderForm.model) body.model = editProviderForm.model;
      if (editProviderForm.contextWindow) body.contextWindow = editProviderForm.contextWindow;
      if (editProviderForm.maxOutputTokens) body.maxOutputTokens = editProviderForm.maxOutputTokens;
      if (editProviderForm.costInput || editProviderForm.costOutput) {
        body.cost = { input: editProviderForm.costInput, output: editProviderForm.costOutput };
      }
      const res = await fetch(`/api/settings/llm/providers/${name}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json() as LLMSettings;
        setLlm(data);
        setEditingProvider(null);
      }
    } catch { /* ignore */ }
    finally { setEditProviderSaving(false); }
  };

  const deleteProvider = async (name: string) => {
    setDeletingProvider(name);
    try {
      const res = await fetch(`/api/settings/llm/providers/${name}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json() as LLMSettings;
        setLlm(data);
        setSelectedProvider(data.defaultProvider);
      }
    } catch { /* ignore */ }
    finally { setDeletingProvider(null); }
  };

  const addCustomModel = async (providerName: string) => {
    if (!addModelForm.id || !addModelForm.name) return;
    setAddModelSaving(true);
    try {
      const res = await fetch(`/api/settings/llm/providers/${providerName}/models`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          id: addModelForm.id,
          name: addModelForm.name,
          contextWindow: addModelForm.contextWindow,
          maxOutputTokens: addModelForm.maxOutputTokens,
          cost: { input: addModelForm.costInput, output: addModelForm.costOutput },
          reasoning: addModelForm.reasoning || undefined,
          inputTypes: addModelForm.vision ? ['text', 'image'] : ['text'],
        }),
      });
      if (res.ok) {
        const data = await res.json() as LLMSettings;
        setLlm(data);
        setAddingModelProvider(null);
        setAddModelForm({ id: '', name: '', contextWindow: 128000, maxOutputTokens: 16384, costInput: 1, costOutput: 5, reasoning: false, vision: false });
      }
    } catch { /* ignore */ }
    finally { setAddModelSaving(false); }
  };

  const deleteCustomModel = async (providerName: string, modelId: string) => {
    try {
      const res = await fetch(`/api/settings/llm/providers/${providerName}/models/${encodeURIComponent(modelId)}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json() as LLMSettings;
        setLlm(data);
      }
    } catch { /* ignore */ }
  };

  const BUILTIN_MODEL_IDS = new Set([
    'claude-opus-4-6', 'claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022',
    'gpt-5.4', 'gpt-4o', 'o4-mini',
    'gemini-3-1-pro', 'gemini-2.5-flash',
    'MiniMax-M2.7', 'MiniMax-M2.5',
    'xiaomi/mimo-v2-pro', 'anthropic/claude-opus-4-6', 'openai/gpt-5.4', 'google/gemini-3-1-pro',
  ]);

  const [switchingModel, setSwitchingModel] = useState<string | null>(null);

  const switchProviderModel = async (providerName: string, modelId: string) => {
    setSwitchingModel(`${providerName}:${modelId}`);
    try {
      const res = await fetch(`/api/settings/llm/providers/${providerName}/model`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ model: modelId }),
      });
      if (res.ok) {
        const data = await res.json() as LLMSettings;
        setLlm(data);
      }
    } catch { /* ignore */ }
    finally { setSwitchingModel(null); }
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

        {/* ───── Appearance ───── */}
        <Section title="Appearance">
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Theme</div>
                <div className="text-xs text-fg-tertiary mt-0.5">Choose light, dark, or follow your system preference</div>
              </div>
              <div className="flex gap-1 bg-surface-elevated rounded-lg p-0.5">
                {([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as const).map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => onThemeChange?.(val)}
                    className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                      theme === val ? 'bg-brand-600 text-white' : 'text-fg-secondary hover:text-fg-primary'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Section>

        {/* ───── First-Run Setup Guide ───── */}
        {showSetupGuide && (
          <div className="relative bg-gradient-to-br from-brand-500/10 to-surface-secondary border border-brand-500/20 rounded-2xl p-6 space-y-5">
            <button onClick={() => setSetupDismissed(true)}
              className="absolute top-4 right-4 text-fg-tertiary hover:text-fg-secondary text-xs">Skip</button>
            <div>
              <h3 className="text-base font-semibold text-fg-primary">Welcome — Configure Your LLM</h3>
              <p className="text-sm text-fg-secondary mt-1">Markus needs at least one LLM provider to work. Choose a way to get started:</p>
            </div>

            {/* Option 1: Environment variables (auto-detected) */}
            <SetupCard
              step="1"
              title="From Environment Variables"
              description="Automatically detected API keys from .env or system environment."
              active={!!(envModels && envModels.detected.length > 0)}
            >
              {envLoading && <div className="text-xs text-fg-tertiary">Detecting...</div>}
              {envModels && envModels.detected.length > 0 && (
                <div className="space-y-2">
                  {envModels.detected.map(d => (
                    <label key={d.provider} className="flex items-center gap-3 bg-surface-elevated/30 rounded-lg px-3 py-2 cursor-pointer hover:bg-surface-elevated/50 transition-colors">
                      <input type="checkbox" checked={envSelected[d.provider] ?? false}
                        onChange={e => setEnvSelected({ ...envSelected, [d.provider]: e.target.checked })}
                        className="w-4 h-4 rounded bg-surface-overlay border-gray-600 text-brand-500 focus:ring-brand-500" />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-fg-primary">{d.displayName}</span>
                        <span className="text-xs text-fg-tertiary ml-2">{d.model}</span>
                      </div>
                      <code className="text-[10px] text-fg-tertiary">{d.apiKeyPreview}</code>
                    </label>
                  ))}
                  <button onClick={() => void applyEnvModels()} disabled={envApplying || Object.values(envSelected).filter(Boolean).length === 0}
                    className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                    {envApplying ? 'Applying...' : `Apply ${Object.values(envSelected).filter(Boolean).length} Provider(s)`}
                  </button>
                </div>
              )}
              {envModels && envModels.detected.length === 0 && (
                <div className="text-xs text-fg-tertiary">No API keys found. Set environment variables like <code className="text-fg-secondary">ANTHROPIC_API_KEY</code> or <code className="text-fg-secondary">OPENAI_API_KEY</code> and restart the server.</div>
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
                  className="px-4 py-2 border border-border-default hover:bg-surface-elevated disabled:opacity-40 text-fg-secondary text-sm rounded-lg transition-colors">
                  {openclawLoading ? 'Detecting...' : 'Detect OpenClaw'}
                </button>
              ) : openclawPreview.found ? (
                <div className="space-y-2">
                  <div className="text-xs text-green-600">Found: <code className="text-fg-secondary">{openclawPreview.summary.configPath}</code></div>
                  {openclawPreview.summary.models && (
                    <div className="text-xs text-fg-secondary">{openclawPreview.summary.models.providerCount} providers, {openclawPreview.summary.models.providers.reduce((s, p) => s + p.modelCount, 0)} models</div>
                  )}
                  <button onClick={() => void importOpenclaw()} disabled={openclawLoading}
                    className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                    {openclawLoading ? 'Importing...' : 'Import Model Configs'}
                  </button>
                </div>
              ) : (
                <div className="text-xs text-fg-tertiary">No OpenClaw config found.</div>
              )}
              {openclawMsg && <Msg type={openclawMsg.type} text={openclawMsg.text} />}
            </SetupCard>

            {/* Option 3: Manual hint */}
            <SetupCard
              step="3"
              title="Manual Configuration"
              description={<>Edit <code className="text-fg-secondary">~/.markus/markus.json</code> directly, then restart the server.</>}
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
          ) : <div className="text-sm text-fg-tertiary">Loading...</div>}
        </Section>

        {/* ───── Default Provider ───── */}
        <Section title="Default LLM Provider">
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Primary Provider</div>
                <div className="text-xs text-fg-tertiary mt-0.5">Used for all agent interactions unless overridden</div>
              </div>
              <div className="flex items-center gap-3">
                {llm ? (
                  <select value={selectedProvider} onChange={e => { setSelectedProvider(e.target.value); setSaveMsg(null); }}
                    className="px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm w-48 focus:border-brand-500 outline-none">
                    {enabledProviders.length > 0 ? enabledProviders.map(p => <option key={p} value={p}>{llm.providers[p]?.displayName ?? p}</option>) : <option value="">No providers configured</option>}
                  </select>
                ) : <div className="text-xs text-fg-tertiary">Loading...</div>}
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

        {/* ───── OAuth Login ───── */}
        {oauthProviders.length > 0 && (
          <Section title="OAuth Authentication">
            <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-5">
              <div className="text-sm text-fg-secondary">
                Connect to LLM providers using your existing subscription via OAuth. No API key required.
              </div>

              {/* OAuth provider buttons */}
              <div className="space-y-3">
                {oauthProviders.map(op => {
                  const profile = authProfiles.find(p => p.provider === op.name && p.hasOAuth);
                  const isPending = pendingOAuthProvider === op.name;
                  return (
                    <div key={op.name} className="flex items-center justify-between bg-surface-elevated/30 rounded-lg px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className={`w-2 h-2 rounded-full ${profile ? 'bg-green-400' : 'bg-gray-600'}`} />
                        <div>
                          <div className="text-sm font-medium text-fg-primary">{op.displayName}</div>
                          {profile && (
                            <div className="text-xs text-fg-tertiary mt-0.5">
                              {profile.accountId && <span>Account: {profile.accountId}</span>}
                              {profile.oauthExpired && <span className="text-amber-500 ml-2">Token expired</span>}
                              {!profile.oauthExpired && <span className="text-green-600 ml-2">Connected</span>}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {profile && (
                          <button
                            onClick={() => void deleteAuthProfile(profile.id)}
                            className="px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors"
                            title="Disconnect"
                          >
                            Disconnect
                          </button>
                        )}
                        <button
                          onClick={() => void startOAuthLogin(op.name)}
                          disabled={oauthLoading === op.name || isPending}
                          className={`px-4 py-1.5 text-xs rounded-lg transition-colors ${
                            profile
                              ? 'border border-border-default text-fg-secondary hover:bg-surface-elevated'
                              : 'bg-brand-600 hover:bg-brand-500 text-white'
                          } disabled:opacity-40`}
                        >
                          {oauthLoading === op.name ? 'Starting...' : isPending ? 'Waiting...' : profile ? 'Reconnect' : 'Connect'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Pending OAuth — manual callback input */}
              {pendingOAuthProvider && (
                <div className="border-t border-border-default pt-4 space-y-3">
                  <div className="text-xs text-fg-tertiary">
                    If the browser didn't open or you're on a remote machine, paste the redirect URL here:
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={manualCallbackUrl}
                      onChange={e => setManualCallbackUrl(e.target.value)}
                      placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                      className="flex-1 px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-xs text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none"
                    />
                    <button
                      onClick={() => void handleManualCallback()}
                      disabled={!manualCallbackUrl.trim() || oauthLoading === 'manual'}
                      className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-xs rounded-lg transition-colors"
                    >
                      {oauthLoading === 'manual' ? 'Processing...' : 'Submit'}
                    </button>
                  </div>
                </div>
              )}

              {/* Existing auth profiles */}
              {authProfiles.length > 0 && (
                <div className="border-t border-border-default pt-4 space-y-2">
                  <div className="text-[10px] text-fg-tertiary uppercase tracking-wider">Auth Profiles</div>
                  {authProfiles.map(p => (
                    <div key={p.id} className="flex items-center justify-between text-xs px-3 py-2 bg-surface-elevated/20 rounded-lg">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${p.hasOAuth && !p.oauthExpired ? 'bg-green-400' : p.oauthExpired ? 'bg-amber-400' : 'bg-gray-500'}`} />
                        <span className="text-fg-secondary">{p.label ?? p.id}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-overlay text-fg-tertiary">{p.authType}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {p.accountId && <span className="text-fg-tertiary">{p.accountId}</span>}
                        <span className="text-fg-tertiary">{new Date(p.updatedAt).toLocaleDateString()}</span>
                        <button onClick={() => void deleteAuthProfile(p.id)} className="text-red-400 hover:text-red-300 transition-colors" title="Delete">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {oauthMsg && <Msg type={oauthMsg.type} text={oauthMsg.text} />}
            </div>
          </Section>
        )}

        {/* ───── Model Providers ───── */}
        <Section title="Model Providers & Pricing">
          <div className="space-y-3">
            {llm && Object.entries(llm.providers).map(([name, info]) => (
              <div key={name} className={`bg-surface-secondary border rounded-xl overflow-hidden transition-colors ${info.configured ? 'border-border-default hover:border-gray-600' : 'border-border-default/50 opacity-60'}`}>
                <div className="flex items-center justify-between px-5 py-4 cursor-pointer" onClick={() => setExpandedProvider(expandedProvider === name ? null : name)}>
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${info.configured && info.enabled ? 'bg-green-400' : info.configured ? 'bg-amber-400' : 'bg-gray-600'}`} />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{info.displayName ?? name}</span>
                        {name === llm.defaultProvider && <span className="text-[10px] bg-brand-500/15 text-brand-500 px-1.5 py-0.5 rounded">default</span>}
                        {info.configured && !info.enabled && <span className="text-[10px] bg-amber-500/15 text-amber-600 px-1.5 py-0.5 rounded">disabled</span>}
                        {info.oauthConnected && <span className="text-[10px] bg-green-500/15 text-green-600 px-1.5 py-0.5 rounded">OAuth</span>}
                      </div>
                      <div className="text-xs text-fg-tertiary mt-0.5">{info.model || 'Not configured'}</div>
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
                    {info.contextWindow && <span className="text-[10px] text-fg-tertiary">{(info.contextWindow / 1000).toFixed(0)}K ctx</span>}
                    {info.cost && <span className="text-[10px] text-fg-tertiary">${info.cost.input}/{info.cost.output} per 1M</span>}
                    <span className="text-fg-tertiary text-xs">{expandedProvider === name ? '▲' : '▼'}</span>
                  </div>
                </div>

                {expandedProvider === name && (
                  <div className="px-5 pb-4 border-t border-border-default pt-4 space-y-4">
                    {info.configured && (
                      <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <MiniStat label="Model" value={info.model} />
                          <MiniStat label="Context Window" value={info.contextWindow ? `${(info.contextWindow / 1000).toFixed(0)}K tokens` : 'N/A'} />
                          <MiniStat label="Max Output" value={info.maxOutputTokens ? `${(info.maxOutputTokens / 1000).toFixed(0)}K tokens` : 'N/A'} />
                          <MiniStat label="Base URL" value={info.baseUrl ?? 'Default'} />
                        </div>

                        {/* Edit / Delete provider actions */}
                        {editingProvider === name ? (
                          <div className="bg-surface-elevated/40 rounded-lg p-4 space-y-3">
                            <div className="text-[10px] text-fg-tertiary uppercase tracking-wider">Edit Provider</div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">API Key</label>
                                <input type="password" value={editProviderForm.apiKey}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, apiKey: e.target.value })}
                                  placeholder="Leave blank to keep current"
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">Base URL</label>
                                <input type="text" value={editProviderForm.baseUrl}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, baseUrl: e.target.value })}
                                  placeholder="Default"
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">Model</label>
                                <input type="text" value={editProviderForm.model}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, model: e.target.value })}
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary focus:border-brand-500 outline-none" />
                              </div>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">Context Window</label>
                                <input type="number" value={editProviderForm.contextWindow || ''}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, contextWindow: Number(e.target.value) })}
                                  placeholder="e.g. 128000"
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">Max Output Tokens</label>
                                <input type="number" value={editProviderForm.maxOutputTokens || ''}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, maxOutputTokens: Number(e.target.value) })}
                                  placeholder="e.g. 16384"
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">$/1M Input</label>
                                <input type="number" step="0.01" value={editProviderForm.costInput || ''}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, costInput: Number(e.target.value) })}
                                  placeholder="e.g. 1"
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">$/1M Output</label>
                                <input type="number" step="0.01" value={editProviderForm.costOutput || ''}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, costOutput: Number(e.target.value) })}
                                  placeholder="e.g. 5"
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={() => void saveEditProvider(name)} disabled={editProviderSaving}
                                className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white rounded-lg transition-colors">
                                {editProviderSaving ? 'Saving...' : 'Save'}
                              </button>
                              <button onClick={() => setEditingProvider(null)}
                                className="px-3 py-1.5 text-xs border border-border-default text-fg-secondary hover:bg-surface-elevated rounded-lg transition-colors">
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <button onClick={e => { e.stopPropagation(); startEditProvider(name, info); }}
                              className="px-3 py-1.5 text-xs border border-border-default text-fg-secondary hover:bg-surface-elevated rounded-lg transition-colors">
                              Edit
                            </button>
                            <button onClick={e => { e.stopPropagation(); if (confirm(`Delete provider "${info.displayName ?? name}"?`)) void deleteProvider(name); }}
                              disabled={deletingProvider === name}
                              className="px-3 py-1.5 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-40">
                              {deletingProvider === name ? 'Deleting...' : 'Delete'}
                            </button>
                          </div>
                        )}
                      </>
                    )}

                    {info.cost && (
                      <div className="bg-surface-elevated/40 rounded-lg p-3">
                        <div className="text-[10px] text-fg-tertiary uppercase tracking-wider mb-2">Pricing (per 1M tokens)</div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <MiniStat label="Input" value={`$${info.cost.input}`} />
                          <MiniStat label="Output" value={`$${info.cost.output}`} />
                          {info.cost.cacheRead != null && <MiniStat label="Cache Read" value={`$${info.cost.cacheRead}`} />}
                          {info.cost.cacheWrite != null && <MiniStat label="Cache Write" value={`$${info.cost.cacheWrite}`} />}
                        </div>
                      </div>
                    )}

                    {/* Available Models */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[10px] text-fg-tertiary uppercase tracking-wider">Available Models</div>
                        {info.configured && addingModelProvider !== name && (
                          <button onClick={() => { setAddingModelProvider(name); setAddModelForm({ id: '', name: '', contextWindow: 128000, maxOutputTokens: 16384, costInput: 1, costOutput: 5, reasoning: false, vision: false }); }}
                            className="text-[10px] text-brand-500 hover:text-brand-400 transition-colors">
                            + Add Model
                          </button>
                        )}
                      </div>

                      {/* Add model form */}
                      {addingModelProvider === name && (
                        <div className="bg-surface-elevated/40 rounded-lg p-3 mb-2 space-y-2">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                            <input type="text" placeholder="Model ID" value={addModelForm.id}
                              onChange={e => setAddModelForm({ ...addModelForm, id: e.target.value })}
                              className="px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                            <input type="text" placeholder="Display Name" value={addModelForm.name}
                              onChange={e => setAddModelForm({ ...addModelForm, name: e.target.value })}
                              className="px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                            <input type="number" placeholder="Context (tokens)" value={addModelForm.contextWindow}
                              onChange={e => setAddModelForm({ ...addModelForm, contextWindow: Number(e.target.value) })}
                              className="px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary focus:border-brand-500 outline-none" />
                            <input type="number" placeholder="Max Output" value={addModelForm.maxOutputTokens}
                              onChange={e => setAddModelForm({ ...addModelForm, maxOutputTokens: Number(e.target.value) })}
                              className="px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary focus:border-brand-500 outline-none" />
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-fg-tertiary">$/1M in:</span>
                              <input type="number" step="0.01" value={addModelForm.costInput}
                                onChange={e => setAddModelForm({ ...addModelForm, costInput: Number(e.target.value) })}
                                className="w-16 px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary focus:border-brand-500 outline-none" />
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-fg-tertiary">out:</span>
                              <input type="number" step="0.01" value={addModelForm.costOutput}
                                onChange={e => setAddModelForm({ ...addModelForm, costOutput: Number(e.target.value) })}
                                className="w-16 px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary focus:border-brand-500 outline-none" />
                            </div>
                            <label className="flex items-center gap-1 text-[10px] text-fg-tertiary cursor-pointer">
                              <input type="checkbox" checked={addModelForm.reasoning}
                                onChange={e => setAddModelForm({ ...addModelForm, reasoning: e.target.checked })} className="rounded" />
                              reasoning
                            </label>
                            <label className="flex items-center gap-1 text-[10px] text-fg-tertiary cursor-pointer">
                              <input type="checkbox" checked={addModelForm.vision}
                                onChange={e => setAddModelForm({ ...addModelForm, vision: e.target.checked })} className="rounded" />
                              vision
                            </label>
                            <div className="flex-1" />
                            <button onClick={() => void addCustomModel(name)} disabled={addModelSaving || !addModelForm.id || !addModelForm.name}
                              className="px-2 py-1 text-[10px] bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white rounded transition-colors">
                              {addModelSaving ? 'Adding...' : 'Add'}
                            </button>
                            <button onClick={() => setAddingModelProvider(null)}
                              className="px-2 py-1 text-[10px] border border-border-default text-fg-secondary hover:bg-surface-elevated rounded transition-colors">
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}

                      {info.models && info.models.length > 0 && (
                        <div className="space-y-1.5">
                          {info.models.map(m => {
                            const isActive = m.id === info.model;
                            const isSwitching = switchingModel === `${name}:${m.id}`;
                            const isCustom = !BUILTIN_MODEL_IDS.has(m.id);
                            return (
                              <div
                                key={m.id}
                                className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs transition-colors ${
                                  isActive
                                    ? 'bg-brand-500/15 border border-brand-500/30'
                                    : info.configured
                                      ? 'bg-surface-elevated/30 hover:bg-surface-elevated/60 cursor-pointer'
                                      : 'bg-surface-elevated/30'
                                }`}
                                onClick={() => {
                                  if (!isActive && info.configured && !isSwitching) {
                                    void switchProviderModel(name, m.id);
                                  }
                                }}
                              >
                                <div className="flex items-center gap-2">
                                  {isActive && <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0" />}
                                  <span className={isActive ? 'text-brand-500 font-medium' : 'text-fg-secondary'}>{m.name}</span>
                                  {m.reasoning && <span className="text-[9px] bg-amber-500/15 text-amber-600 px-1 py-0.5 rounded">reasoning</span>}
                                  {m.inputTypes?.includes('image') && <span className="text-[9px] bg-blue-500/15 text-blue-600 px-1 py-0.5 rounded">vision</span>}
                                  {isCustom && <span className="text-[9px] bg-purple-500/15 text-purple-400 px-1 py-0.5 rounded">custom</span>}
                                </div>
                                <div className="flex items-center gap-3 text-fg-tertiary">
                                  <span>{(m.contextWindow / 1000).toFixed(0)}K ctx</span>
                                  <span>${m.cost.input}/${m.cost.output}</span>
                                  {info.configured && !isActive && (
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                                      isSwitching
                                        ? 'bg-brand-500/30 text-brand-400'
                                        : 'bg-surface-overlay text-fg-tertiary hover:bg-brand-500/20 hover:text-brand-500'
                                    }`}>
                                      {isSwitching ? 'Switching...' : 'Use'}
                                    </span>
                                  )}
                                  {isActive && (
                                    <span className="text-[9px] bg-brand-500/15 text-brand-500 px-1.5 py-0.5 rounded">active</span>
                                  )}
                                  {isCustom && !isActive && (
                                    <button onClick={e => { e.stopPropagation(); void deleteCustomModel(name, m.id); }}
                                      className="text-red-400 hover:text-red-300 transition-colors" title="Delete custom model">
                                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {!info.configured && (
                      <div className="text-xs text-fg-tertiary">
                        Not configured. Use the "Add Provider" button below, or set API keys in environment variables.
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Add Provider */}
          {!showAddProvider ? (
            <button onClick={() => setShowAddProvider(true)}
              className="w-full mt-3 px-4 py-3 border border-dashed border-border-default hover:border-brand-500/50 hover:bg-brand-500/5 rounded-xl text-sm text-fg-tertiary hover:text-brand-500 transition-colors">
              + Add Provider
            </button>
          ) : (
            <div className="mt-3 bg-surface-secondary border border-brand-500/30 rounded-xl p-5 space-y-4">
              <div className="text-sm font-medium text-fg-primary">Add New Provider</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">Provider Name</label>
                  <input type="text" value={addProviderForm.name}
                    onChange={e => setAddProviderForm({ ...addProviderForm, name: e.target.value })}
                    placeholder="e.g. deepseek, openrouter, my-provider"
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                  <div className="text-[10px] text-fg-tertiary mt-1">Use anthropic, openai, google, ollama for first-party; any other name uses OpenAI-compatible API</div>
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">API Key</label>
                  <input type="password" value={addProviderForm.apiKey}
                    onChange={e => setAddProviderForm({ ...addProviderForm, apiKey: e.target.value })}
                    placeholder="sk-..."
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">Base URL (optional)</label>
                  <input type="text" value={addProviderForm.baseUrl}
                    onChange={e => setAddProviderForm({ ...addProviderForm, baseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">Default Model</label>
                  <input type="text" value={addProviderForm.model}
                    onChange={e => setAddProviderForm({ ...addProviderForm, model: e.target.value })}
                    placeholder="e.g. deepseek-chat, gpt-4o"
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">Context Window</label>
                  <input type="number" value={addProviderForm.contextWindow}
                    onChange={e => setAddProviderForm({ ...addProviderForm, contextWindow: Number(e.target.value) })}
                    placeholder="128000"
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">Max Output Tokens</label>
                  <input type="number" value={addProviderForm.maxOutputTokens}
                    onChange={e => setAddProviderForm({ ...addProviderForm, maxOutputTokens: Number(e.target.value) })}
                    placeholder="16384"
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">$/1M Input</label>
                  <input type="number" step="0.01" value={addProviderForm.costInput}
                    onChange={e => setAddProviderForm({ ...addProviderForm, costInput: Number(e.target.value) })}
                    placeholder="1"
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">$/1M Output</label>
                  <input type="number" step="0.01" value={addProviderForm.costOutput}
                    onChange={e => setAddProviderForm({ ...addProviderForm, costOutput: Number(e.target.value) })}
                    placeholder="5"
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => void addProvider()} disabled={addProviderSaving || !addProviderForm.name || !addProviderForm.model}
                  className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white rounded-lg transition-colors">
                  {addProviderSaving ? 'Adding...' : 'Add Provider'}
                </button>
                <button onClick={() => { setShowAddProvider(false); setAddProviderMsg(null); }}
                  className="px-4 py-2 text-sm border border-border-default text-fg-secondary hover:bg-surface-elevated rounded-lg transition-colors">
                  Cancel
                </button>
              </div>
              {addProviderMsg && <Msg type={addProviderMsg.type} text={addProviderMsg.text} />}
            </div>
          )}
        </Section>

        <div className="border-t border-border-default" />

        {/* ───── Environment Variable Config ───── */}
        <Section title="Environment Variable Configuration">
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
            <div className="text-sm text-fg-secondary">Detect model API keys from environment variables and write them to the config file.</div>
            <button onClick={() => void detectEnvModels()} disabled={envLoading}
              className="px-4 py-2 border border-border-default hover:bg-surface-elevated disabled:opacity-40 text-fg-secondary text-sm rounded-lg transition-colors flex items-center gap-2">
              <svg className={`w-4 h-4 ${envLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              {envLoading ? 'Detecting...' : 'Refresh Environment Variables'}
            </button>

            {envModels && envModels.detected.length > 0 && (
              <div className="border-t border-border-default pt-4 space-y-3">
                <div className="text-xs text-fg-tertiary uppercase tracking-wider">Detected Providers — select to apply:</div>
                {envModels.detected.map(d => (
                  <label key={d.provider} className="flex items-center justify-between bg-surface-elevated/30 rounded-lg px-4 py-3 cursor-pointer hover:bg-surface-elevated/50 transition-colors">
                    <div className="flex items-center gap-3">
                      <input type="checkbox" checked={envSelected[d.provider] ?? false}
                        onChange={e => setEnvSelected({ ...envSelected, [d.provider]: e.target.checked })}
                        className="w-4 h-4 rounded bg-surface-overlay border-gray-600 text-brand-500 focus:ring-brand-500" />
                      <div>
                        <div className="text-sm text-fg-primary font-medium">{d.displayName}</div>
                        <div className="text-xs text-fg-tertiary mt-0.5">
                          Key: <code className="text-fg-secondary">{d.apiKeyPreview}</code>
                          {' / '}Model: <code className="text-fg-secondary">{d.model}</code>
                          {d.baseUrl && <>{' / '}URL: <code className="text-fg-secondary">{d.baseUrl}</code></>}
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-fg-tertiary">
                      {Object.keys(d.envVars).map(k => <div key={k}><code>{k}</code></div>)}
                    </div>
                  </label>
                ))}
                {envModels.timeoutMs && (
                  <div className="text-xs text-fg-tertiary">
                    LLM Timeout: <code className="text-fg-secondary">{envModels.timeoutMs}ms</code> (from <code>LLM_TIMEOUT_MS</code>)
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
            <div className="text-sm text-fg-secondary">Detect and import LLM configurations from an existing OpenClaw installation.</div>
            <div className="flex gap-3">
              <button onClick={() => void detectOpenclaw()} disabled={openclawLoading}
                className="px-4 py-2 border border-border-default hover:bg-surface-elevated disabled:opacity-40 text-fg-secondary text-sm rounded-lg transition-colors">
                {openclawLoading ? 'Detecting...' : 'Detect OpenClaw Config'}
              </button>
            </div>

            {openclawPreview && openclawPreview.found && (
              <div className="border-t border-border-default pt-4 space-y-3">
                <div className="text-xs text-green-600">Found OpenClaw config at: <code className="text-fg-secondary">{openclawPreview.summary.configPath}</code></div>
                {openclawPreview.summary.models && (
                  <div className="bg-surface-elevated/30 rounded-lg p-3">
                    <div className="text-xs text-fg-tertiary mb-2">{openclawPreview.summary.models.providerCount} model providers found:</div>
                    <div className="space-y-1">
                      {openclawPreview.summary.models.providers.map(p => (
                        <div key={p.name} className="flex items-center justify-between text-xs">
                          <span className="text-fg-secondary">{p.name}</span>
                          <span className="text-fg-tertiary">{p.modelCount} models {p.baseUrl ? `(${p.baseUrl})` : ''}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {openclawPreview.summary.channels && openclawPreview.summary.channels.length > 0 && (
                  <div className="bg-surface-elevated/30 rounded-lg p-3">
                    <div className="text-xs text-fg-tertiary mb-1">Channels: {openclawPreview.summary.channels.join(', ')}</div>
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

        <Section title="Agent Execution">
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-fg-primary">Max Tool Iterations</div>
                <div className="text-xs text-fg-tertiary mt-0.5">Safety cap on tool call loops per agent turn (0 = unlimited, applies to all agents and subagents)</div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  value={agentMaxIter}
                  onChange={e => { setAgentMaxIter(Number(e.target.value)); setAgentMsg(null); }}
                  className="w-24 px-3 py-1.5 text-sm border border-border-default rounded-lg bg-surface-primary text-fg-primary text-right"
                />
                <button
                  disabled={agentSaving}
                  onClick={async () => {
                    setAgentSaving(true); setAgentMsg(null);
                    try {
                      const d = await api.settings.updateAgent({ maxToolIterations: agentMaxIter });
                      setAgentMaxIter(d.maxToolIterations);
                      setAgentMsg({ type: 'ok', text: 'Saved' });
                    } catch { setAgentMsg({ type: 'err', text: 'Failed to save' }); }
                    setAgentSaving(false);
                  }}
                  className="px-3 py-1.5 text-xs bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-40"
                >
                  {agentSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
            {agentMsg && <Msg type={agentMsg.type} text={agentMsg.text} />}
          </div>
        </Section>

        <Section title="Data & Storage">
          <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-5">
            {storageLoading && !storageInfo && <div className="text-sm text-fg-tertiary">Scanning storage...</div>}
            {storageInfo && (
              <>
                {/* Summary bar */}
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-lg font-semibold text-fg-primary">{formatBytes(storageInfo.totalSize)}</div>
                    <div className="text-xs text-fg-tertiary font-mono mt-0.5">{storageInfo.dataDir}</div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => loadStorage()} disabled={storageLoading}
                      className="px-3 py-1.5 text-xs border border-border-default hover:bg-surface-elevated rounded-lg text-fg-secondary transition-colors disabled:opacity-40">
                      {storageLoading ? 'Scanning...' : 'Refresh'}
                    </button>
                    <button onClick={() => void api.system.openPath(storageInfo.dataDir)}
                      className="px-3 py-1.5 text-xs border border-border-default hover:bg-surface-elevated rounded-lg text-fg-secondary transition-colors">
                      Open in Finder
                    </button>
                  </div>
                </div>

                {/* Breakdown table */}
                <div className="border-t border-border-default pt-4">
                  <h4 className="text-xs font-semibold text-fg-secondary mb-3">Storage Breakdown</h4>
                  <div className="space-y-1.5">
                    {storageInfo.breakdown.filter(b => b.size > 0).map(item => (
                      <div key={item.name} className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-surface-elevated/40">
                        <div className="min-w-0">
                          <span className="text-sm text-fg-primary">{item.name}</span>
                          <span className="text-xs text-fg-tertiary ml-2">{item.description}</span>
                        </div>
                        <span className="text-sm font-medium text-fg-secondary tabular-nums shrink-0 ml-3">{formatBytes(item.size)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Per-agent storage */}
                {storageInfo.agents.length > 0 && (
                  <div className="border-t border-border-default pt-4">
                    <h4 className="text-xs font-semibold text-fg-secondary mb-3">Agent Storage ({storageInfo.agents.length})</h4>
                    <div className="space-y-1">
                      {storageInfo.agents.map(ag => {
                        const expanded = expandedAgents.has(ag.id);
                        return (
                          <div key={ag.id} className="rounded-lg bg-surface-elevated/40 overflow-hidden">
                            <div className="flex items-center justify-between py-2 px-3 cursor-pointer hover:bg-surface-elevated/70"
                              onClick={() => setExpandedAgents(prev => { const n = new Set(prev); if (n.has(ag.id)) n.delete(ag.id); else n.add(ag.id); return n; })}>
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-[10px] text-fg-tertiary">{expanded ? '▼' : '▶'}</span>
                                <button onClick={e => { e.stopPropagation(); navBus.navigate(PAGE.TEAM, { agentId: ag.id }); }}
                                  className="text-sm text-brand-500 hover:text-brand-400 truncate">
                                  {ag.name}
                                </button>
                                <span className="text-[10px] text-fg-tertiary font-mono truncate">{ag.id}</span>
                              </div>
                              <span className="text-xs font-medium text-fg-secondary tabular-nums shrink-0 ml-3">{formatBytes(ag.size)}</span>
                            </div>
                            {expanded && (
                              <div className="px-3 pb-2 pt-0.5 space-y-0.5">
                                {ag.subItems.filter(s => s.size > 0).map(sub => (
                                  <div key={sub.name} className="flex items-center justify-between text-xs py-0.5 pl-5">
                                    <span className="text-fg-tertiary">{sub.name}</span>
                                    <span className="text-fg-secondary tabular-nums">{formatBytes(sub.size)}</span>
                                  </div>
                                ))}
                                <div className="pl-5 pt-1">
                                  <button onClick={() => void api.system.openPath(storageInfo.dataDir + '/agents/' + ag.id)}
                                    className="text-[10px] text-fg-tertiary hover:text-fg-secondary underline">Open folder</button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Orphan cleanup */}
                {orphanInfo && (orphanInfo.orphanAgents.length > 0 || orphanInfo.orphanTeams.length > 0) && (
                  <OrphanSection orphanInfo={orphanInfo} dataDir={storageInfo.dataDir} onPurged={loadStorage} />
                )}
              </>
            )}
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
    <div className={`rounded-xl border p-4 space-y-3 transition-colors ${active ? 'border-brand-500/60 bg-brand-500/10' : 'border-border-default bg-surface-secondary/60'}`}>
      <div className="flex items-start gap-3">
        <span className="flex-none w-6 h-6 rounded-full bg-surface-overlay flex items-center justify-center text-xs font-bold text-fg-secondary">{step}</span>
        <div className="min-w-0">
          <div className="text-sm font-medium text-fg-primary">{title}</div>
          <div className="text-xs text-fg-tertiary mt-0.5">{description}</div>
        </div>
      </div>
      {children && <div className="pl-9">{children}</div>}
    </div>
  );
}

function Msg({ type, text }: { type: 'ok' | 'err'; text: string }) {
  return (
    <div className={`text-xs px-3 py-2 rounded-lg ${type === 'ok' ? 'bg-green-500/10 text-green-600 border border-green-500/30' : 'bg-red-500/10 text-red-500 border border-red-500/30'}`}>
      {text}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-fg-secondary uppercase tracking-wider mb-4">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function InfoCard({ label, value, color }: { label: string; value: string; color: string }) {
  const bg = color === 'green' ? 'bg-green-500/10 text-green-600' : color === 'indigo' ? 'bg-brand-500/10 text-brand-500' : 'bg-brand-500/10 text-brand-500';
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
      <div className="text-[10px] text-fg-tertiary uppercase">{label}</div>
      <div className="text-xs text-fg-secondary mt-0.5 truncate">{value}</div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function OrphanSection({ orphanInfo, dataDir, onPurged }: { orphanInfo: OrphanInfo; dataDir: string; onPurged: () => void }) {
  const allItems = [
    ...orphanInfo.orphanAgents.map(o => ({ ...o, kind: 'agent' as const })),
    ...orphanInfo.orphanTeams.map(o => ({ ...o, kind: 'team' as const })),
  ];
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [purging, setPurging] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const toggle = (id: string) => setSelected(prev => {
    const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n;
  });
  const allSelected = selected.size === allItems.length && allItems.length > 0;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allItems.map(o => o.id)));

  const selectedSize = allItems.filter(o => selected.has(o.id)).reduce((s, o) => s + o.size, 0);

  const doPurge = async (ids?: string[]) => {
    setPurging(true); setResult(null);
    try {
      const r = await api.system.purgeOrphans(ids);
      const count = r.purgedAgents.length + r.purgedTeams.length;
      setResult(`Cleaned ${count} dir${count !== 1 ? 's' : ''}, freed ${formatBytes(r.freedBytes)}${r.failures.length ? ` (${r.failures.length} failed)` : ''}`);
      setSelected(new Set());
      onPurged();
    } catch { setResult('Cleanup failed'); }
    finally { setPurging(false); }
  };

  return (
    <div className="border-t border-border-default pt-4">
      <h4 className="text-xs font-semibold text-amber-500 mb-2">Orphaned Directories</h4>
      <p className="text-xs text-fg-tertiary mb-3">
        These directories have no matching database record and were likely left behind when agents or teams were deleted.
        Total: {formatBytes(orphanInfo.totalOrphanSize)} across {allItems.length} director{allItems.length === 1 ? 'y' : 'ies'}.
      </p>

      {/* Select all */}
      <div className="flex items-center gap-2 mb-2 px-1">
        <label className="flex items-center gap-1.5 text-[10px] text-fg-tertiary cursor-pointer select-none">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded" />
          Select all
        </label>
        {selected.size > 0 && (
          <span className="text-[10px] text-fg-secondary">{selected.size} selected ({formatBytes(selectedSize)})</span>
        )}
      </div>

      {/* List */}
      <div className="space-y-0.5 mb-3 max-h-52 overflow-y-auto">
        {allItems.map(o => (
          <div key={o.id} className={`flex items-center gap-2 text-xs py-1.5 px-2 rounded transition-colors ${selected.has(o.id) ? 'bg-amber-500/10' : 'bg-surface-elevated/30 hover:bg-surface-elevated/50'}`}>
            <input type="checkbox" checked={selected.has(o.id)} onChange={() => toggle(o.id)} className="rounded shrink-0" />
            {o.kind === 'team' && <span className="text-[10px] text-fg-tertiary shrink-0">team</span>}
            <span className="text-fg-tertiary font-mono truncate min-w-0 flex-1">{o.id}</span>
            <span className="text-fg-secondary tabular-nums shrink-0">{formatBytes(o.size)}</span>
            <button onClick={() => void api.system.openPath(o.path)}
              className="text-[10px] text-fg-tertiary hover:text-fg-secondary shrink-0 underline">
              Open
            </button>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 items-center flex-wrap">
        {selected.size > 0 && (
          <button disabled={purging} onClick={() => void doPurge([...selected])}
            className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-50">
            {purging ? 'Cleaning...' : `Clean Selected (${formatBytes(selectedSize)})`}
          </button>
        )}
        <button disabled={purging} onClick={() => void doPurge()}
          className="px-3 py-1.5 text-xs border border-amber-600/50 hover:bg-amber-600/10 text-amber-500 rounded-lg transition-colors disabled:opacity-50">
          {purging ? 'Cleaning...' : `Clean All (${formatBytes(orphanInfo.totalOrphanSize)})`}
        </button>
      </div>
      {result && <div className="text-xs text-fg-tertiary mt-2">{result}</div>}
    </div>
  );
}
