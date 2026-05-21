import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { api, type StorageInfo, type OrphanInfo, type AuthUser, type HumanUserInfo, type RemoteStatus, hubApi, getHubUser, ensureHubAuth, wsClient } from '../api.ts';
import { THEME_OPTIONS, type ThemeMode } from '../hooks/useTheme.ts';
import { SUPPORTED_LANGUAGES } from '../i18n/index.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import { Avatar, AvatarUpload } from '../components/Avatar.tsx';
import { useIsMobile } from '../hooks/useIsMobile.ts';
import { BrowserTestPanel } from '../components/BrowserTestPanel.tsx';

interface ModelCost { input: number; output: number; cacheRead?: number; cacheWrite?: number }
interface ModelDef { id: string; name: string; provider: string; contextWindow: number; maxOutputTokens: number; cost: ModelCost; reasoning?: boolean; inputTypes?: string[] }
interface ProviderInfo {
  name: string; displayName?: string; model: string; baseUrl?: string; configured: boolean; enabled: boolean;
  apiKeyPreview?: string; apiKeySource?: 'config' | 'env' | 'oauth';
  contextWindow?: number; maxOutputTokens?: number; cost?: ModelCost; models?: ModelDef[];
  authType?: string; oauthConnected?: boolean; oauthAccountId?: string;
}
interface LLMSettings { defaultProvider: string; autoFallback?: boolean; providers: Record<string, ProviderInfo> }
interface OAuthProvider { name: string; displayName: string }
interface AuthProfileSafe {
  id: string; provider: string; authType: string; label?: string;
  createdAt: number; updatedAt: number;
  hasApiKey: boolean; hasOAuth: boolean; oauthExpired?: boolean; accountId?: string;
}
interface OpenClawPreview { found: boolean; summary: { configPath: string; models?: { providerCount: number; providers: Array<{ name: string; modelCount: number; baseUrl?: string }> }; channels?: string[] } }
interface OllamaModelInfo { name: string; size?: number; parameterSize?: string; family?: string }
interface EnvModelDetected {
  provider: string; displayName: string; apiKeySet: boolean; apiKeyPreview: string;
  model: string; baseUrl?: string; envVars: Record<string, string>;
  ollamaModels?: OllamaModelInfo[];
}
interface EnvModelsResponse { detected: EnvModelDetected[]; timeoutMs?: number }
interface OllamaDetectResult {
  found: boolean; baseUrl?: string; error?: string;
  models?: Array<{ name: string; fullName: string; size?: number; modifiedAt?: string; parameterSize?: string; family?: string; quantization?: string }>;
}

type SettingsTab = 'appearance' | 'providers' | 'execution' | 'browser' | 'search' | 'storage' | 'users' | 'remote';

const SETTINGS_TABS: Array<{ id: SettingsTab; labelKey: string; adminOnly?: boolean }> = [
  { id: 'appearance', labelKey: 'nav.appearance' },
  { id: 'providers', labelKey: 'nav.providers', adminOnly: true },
  { id: 'execution', labelKey: 'nav.execution', adminOnly: true },
  { id: 'browser', labelKey: 'nav.browser', adminOnly: true },
  { id: 'search', labelKey: 'nav.search', adminOnly: true },
  { id: 'storage', labelKey: 'nav.storage', adminOnly: true },
  { id: 'users', labelKey: 'nav.users', adminOnly: true },
  { id: 'remote', labelKey: 'nav.remote', adminOnly: true },
];

function getSettingsTab(): SettingsTab | null {
  const hash = window.location.hash.slice(1);
  const parts = hash.split('/');
  if (parts[0] === 'settings' && parts[1]) {
    const tab = parts[1] as SettingsTab;
    if (SETTINGS_TABS.some(t => t.id === tab)) return tab;
  }
  return null;
}

export function Settings({ theme, onThemeChange, authUser, onLogout, onUserUpdated }: { theme?: ThemeMode; onThemeChange?: (m: ThemeMode) => void; authUser?: AuthUser; onLogout?: () => void; onUserUpdated?: (u: AuthUser) => void } = {}) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const isMobile = useIsMobile();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showEditProfile, setShowEditProfile] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab | null>(getSettingsTab);

  useEffect(() => {
    const onHashChange = () => setActiveTab(getSettingsTab());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigateTab = useCallback((tab: SettingsTab) => {
    setActiveTab(tab);
    history.pushState(null, '', `#settings/${tab}`);
  }, []);

  const navigateBackToList = useCallback(() => {
    setActiveTab(null);
    history.pushState(null, '', '#settings');
  }, []);

  // On desktop, always show a tab (default to appearance). On mobile, null means show the list.
  const resolvedTab: SettingsTab | null = activeTab ?? (isMobile ? null : 'appearance');

  useEffect(() => {
    const handler = () => setShowEditProfile(true);
    window.addEventListener('markus:open-edit-profile', handler);
    return () => window.removeEventListener('markus:open-edit-profile', handler);
  }, []);

  useEffect(() => {
    if (!userMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [userMenuOpen]);

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

  // Ollama auto-detect state
  const [ollamaDetect, setOllamaDetect] = useState<OllamaDetectResult | null>(null);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [ollamaSelectedModel, setOllamaSelectedModel] = useState('');
  const [ollamaApplying, setOllamaApplying] = useState(false);
  const [ollamaMsg, setOllamaMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

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
  // Cognitive Preparation Pipeline settings
  const [cppEnabled, setCppEnabled] = useState(false);
  const [cppMaxDepth, setCppMaxDepth] = useState(1);
  const [cppSaving, setCppSaving] = useState(false);
  const [cppMsg, setCppMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Browser automation settings
  const [browserBringToFront, setBrowserBringToFront] = useState(false);
  const [browserRemotePort, setBrowserRemotePort] = useState(0);
  const [browserAutoClose, setBrowserAutoClose] = useState(true);
  const [browserAutoClickAllow, setBrowserAutoClickAllow] = useState(false);
  const [browserExtensionConnected, setBrowserExtensionConnected] = useState(false);
  const [browserExtensionPort, setBrowserExtensionPort] = useState(9333);
  const [browserSaving, setBrowserSaving] = useState(false);
  const [browserMsg, setBrowserMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Search API key settings
  const [searchKeys, setSearchKeys] = useState<{ serper: { configured: boolean; preview: string }; tavily: { configured: boolean; preview: string }; bing: { configured: boolean; preview: string }; google: { configured: boolean; preview: string }; serpapi: { configured: boolean; preview: string }; brave: { configured: boolean; preview: string }; exa: { configured: boolean; preview: string }; bocha: { configured: boolean; preview: string } } | null>(null);
  const [searchForm, setSearchForm] = useState({ serperApiKey: '', tavilyApiKey: '', bingApiKey: '', googleSearchApiKey: '', googleSearchCx: '', serpApiKey: '', braveApiKey: '', exaApiKey: '', bochaApiKey: '' });
  const [searchSaving, setSearchSaving] = useState(false);
  const [searchMsg, setSearchMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

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
      .then(d => {
        if (d && typeof d.maxToolIterations === 'number') setAgentMaxIter(d.maxToolIterations);
        if (d?.cognitive) {
          setCppEnabled(d.cognitive.enabled ?? false);
          setCppMaxDepth(d.cognitive.maxDepth ?? 1);
        }
      })
      .catch(() => {});
  }, []);

  const loadBrowserSettings = useCallback(() => {
    api.settings.getBrowser()
      .then(d => {
        if (d) {
          setBrowserBringToFront(d.bringToFront ?? false);
          setBrowserRemotePort(d.remoteDebuggingPort ?? 0);
          setBrowserAutoClose(d.autoCloseTabs ?? true);
          setBrowserAutoClickAllow(d.autoClickAllowDialog ?? false);
          setBrowserExtensionConnected(d.extensionConnected ?? false);
          setBrowserExtensionPort(d.extensionBridgePort ?? 9333);
        }
      })
      .catch(() => {});
  }, []);

  const loadSearchSettings = useCallback(() => {
    api.settings.getSearch()
      .then(d => { if (d) setSearchKeys(d); })
      .catch(() => {});
  }, []);

  const loadStorage = useCallback(() => {
    setStorageLoading(true);
    api.system.storage().then(setStorageInfo).catch(() => {}).finally(() => setStorageLoading(false));
    api.system.orphans().then(setOrphanInfo).catch(() => {});
  }, []);

  useEffect(() => { loadSettings(); loadOAuthProviders(); loadAuthProfiles(); loadAgentSettings(); loadBrowserSettings(); loadSearchSettings(); loadStorage(); }, [loadSettings, loadOAuthProviders, loadAuthProfiles, loadAgentSettings, loadBrowserSettings, loadSearchSettings, loadStorage]);

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
        setEnvMsg({ type: 'err', text: t('envConfig.detectionFailedHttp', { status: res.status }) });
        return;
      }
      const data = await res.json() as EnvModelsResponse;
      setEnvModels(data);
      if (data.detected.length === 0) {
        setEnvMsg({ type: 'err', text: t('envConfig.noKeysFound') });
      } else {
        const sel: Record<string, boolean> = {};
        for (const d of data.detected) sel[d.provider] = true;
        setEnvSelected(sel);
      }
    } catch { setEnvMsg({ type: 'err', text: t('envConfig.failedToDetect') }); }
    finally { setEnvLoading(false); }
  }, [t]);

  const detectOllama = useCallback(async () => {
    setOllamaLoading(true); setOllamaMsg(null); setOllamaDetect(null);
    try {
      const res = await fetch('/api/settings/detect-ollama', { headers: authHeaders() });
      if (!res.ok) {
        setOllamaMsg({ type: 'err', text: t('ollama.detectFailed') });
        return;
      }
      const data = await res.json() as OllamaDetectResult;
      setOllamaDetect(data);
      if (data.found && data.models && data.models.length > 0) {
        setOllamaSelectedModel(data.models[0]!.name);
      } else if (!data.found) {
        setOllamaMsg({ type: 'err', text: data.error || t('ollama.notRunning') });
      }
    } catch { setOllamaMsg({ type: 'err', text: t('ollama.detectFailed') }); }
    finally { setOllamaLoading(false); }
  }, [t]);

  // Auto-detect env vars + local Ollama on first load when no providers are configured
  const hasConfiguredProviders = llm
    ? Object.values(llm.providers).some(p => p.configured)
    : false;

  useEffect(() => {
    if (llm && !hasConfiguredProviders && !autoDetectDone.current) {
      autoDetectDone.current = true;
      void detectEnvModels();
      void detectOllama();
    }
  }, [llm, hasConfiguredProviders, detectEnvModels, detectOllama]);

  const saveLLM = async () => {
    if (!selectedProvider || selectedProvider === llm?.defaultProvider) return;
    setSaving(true); setSaveMsg(null);
    try {
      const res = await fetch('/api/settings/llm', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ defaultProvider: selectedProvider }),
      });
      const data = await res.json() as LLMSettings;
      if (res.ok) { setLlm(data); setSaveMsg({ type: 'ok', text: t('defaultProvider.updated', { name: data.defaultProvider }) }); }
      else { setSaveMsg({ type: 'err', text: ((data as unknown as { error: string }).error ?? t('modelProviders.saveFailed')) }); }
    } catch { setSaveMsg({ type: 'err', text: t('common:networkError') }); }
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
    } catch { setOpenclawMsg({ type: 'err', text: t('openClaw.detectFailed') }); }
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
      else { setOpenclawMsg({ type: 'ok', text: t('openClaw.importedFrom', { count: data.appliedModels }) }); loadSettings(); }
    } catch { setOpenclawMsg({ type: 'err', text: t('openClaw.importFailed') }); }
    finally { setOpenclawLoading(false); }
  };

  const applyEnvModels = async () => {
    if (!envModels) return;
    const selected = envModels.detected.filter(d => envSelected[d.provider]);
    if (selected.length === 0) {
      setEnvMsg({ type: 'err', text: t('envConfig.selectAtLeastOne') });
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
        setEnvMsg({ type: 'err', text: t('envConfig.applyFailed', { status: res.status }) });
        return;
      }
      const data = await res.json() as { applied: string[]; message: string };
      setEnvMsg({ type: 'ok', text: data.message });
      setEnvModels(null); setEnvSelected({});
      loadSettings();
    } catch { setEnvMsg({ type: 'err', text: t('envConfig.failedToApply') }); }
    finally { setEnvApplying(false); }
  };

  const applyOllama = async () => {
    if (!ollamaDetect?.found || !ollamaSelectedModel) return;
    setOllamaApplying(true); setOllamaMsg(null);
    try {
      const res = await fetch('/api/settings/llm/providers', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          name: 'ollama',
          model: ollamaSelectedModel,
          baseUrl: ollamaDetect.baseUrl || 'http://localhost:11434',
        }),
      });
      if (res.ok) {
        const data = await res.json() as LLMSettings;
        setLlm(data);
        setOllamaMsg({ type: 'ok', text: t('ollama.configured', { model: ollamaSelectedModel }) });
        setOllamaDetect(null);
      } else {
        const err = await res.json() as { error?: string };
        setOllamaMsg({ type: 'err', text: err.error || t('ollama.applyFailed') });
      }
    } catch { setOllamaMsg({ type: 'err', text: t('ollama.applyFailed') }); }
    finally { setOllamaApplying(false); }
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
        setOauthMsg({ type: 'err', text: data.error ?? t('oauth.loginFailed') });
        return;
      }
      if (data.authorizeUrl) {
        window.open(data.authorizeUrl, '_blank', 'noopener');
        setPendingOAuthProvider(provider);
        setOauthMsg({ type: 'ok', text: t('browserOpened') });
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
              setOauthMsg({ type: 'ok', text: t('oauthConnected', { provider }) });
              loadSettings();
            }
          } catch { /* continue polling */ }
        }, 2000);
      }
    } catch { setOauthMsg({ type: 'err', text: t('oauth.networkErrorDuringLogin') }); }
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
        setOauthMsg({ type: 'err', text: data.error ?? t('oauth.callbackFailed') });
        return;
      }
      setOauthMsg({ type: 'ok', text: t('oauthConnected', { provider: data.profile?.provider ?? t('common:unknown') }) });
      setManualCallbackUrl('');
      setPendingOAuthProvider(null);
      if (oauthPollRef.current) { clearInterval(oauthPollRef.current); oauthPollRef.current = null; }
      loadAuthProfiles(); loadSettings();
    } catch { setOauthMsg({ type: 'err', text: t('common:networkError') }); }
    finally { setOauthLoading(null); }
  };

  const deleteAuthProfile = async (profileId: string) => {
    try {
      const res = await fetch(`/api/settings/oauth/profiles/${encodeURIComponent(profileId)}`, {
        method: 'DELETE', headers: authHeaders(),
      });
      if (res.ok) {
        loadAuthProfiles(); loadSettings();
        setOauthMsg({ type: 'ok', text: t('authProfileDeleted') });
      }
    } catch { /* ignore */ }
  };

  // Cleanup polling on unmount
  useEffect(() => () => {
    if (oauthPollRef.current) clearInterval(oauthPollRef.current);
  }, []);

  // Poll extension connection status when browser tab is active and not yet connected
  useEffect(() => {
    if (resolvedTab !== 'browser' || browserExtensionConnected) return;
    const poll = setInterval(async () => {
      try {
        const d = await api.settings.getBrowser();
        if (d.extensionConnected) {
          setBrowserExtensionConnected(true);
          clearInterval(poll);
        }
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(poll);
  }, [resolvedTab, browserExtensionConnected]);

  // Add/Edit/Delete provider state
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [addProviderForm, setAddProviderForm] = useState({ name: '', apiKey: '', baseUrl: '', model: '', contextWindow: 128000, maxOutputTokens: 16384, costInput: 1, costOutput: 5 });
  const [addProviderSaving, setAddProviderSaving] = useState(false);
  const [addProviderMsg, setAddProviderMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editProviderForm, setEditProviderForm] = useState({ apiKey: '', baseUrl: '', model: '', contextWindow: 0, maxOutputTokens: 0, costInput: 0, costOutput: 0 });
  const [editProviderSaving, setEditProviderSaving] = useState(false);
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null);

  // Quick setup state (for unconfigured known providers — just enter API key)
  const [quickSetupKey, setQuickSetupKey] = useState('');
  const [quickSetupSaving, setQuickSetupSaving] = useState(false);
  const [quickSetupMsg, setQuickSetupMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

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
        setAddProviderMsg({ type: 'ok', text: t('modelProviders.providerAdded', { name: addProviderForm.name }) });
      } else {
        setAddProviderMsg({ type: 'err', text: (data as { error: string }).error ?? t('modelProviders.failedToAdd') });
      }
    } catch { setAddProviderMsg({ type: 'err', text: t('common:networkError') }); }
    finally { setAddProviderSaving(false); }
  };

  const quickSetupProvider = async (providerName: string, info: ProviderInfo) => {
    if (!quickSetupKey.trim()) return;
    setQuickSetupSaving(true); setQuickSetupMsg(null);
    const defaultModel = info.models?.[0]?.id ?? providerName;
    try {
      const res = await fetch('/api/settings/llm/providers', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ name: providerName, apiKey: quickSetupKey.trim(), model: defaultModel }),
      });
      const data = await res.json();
      if (res.ok) {
        setLlm(data as LLMSettings);
        setQuickSetupKey('');
        setQuickSetupMsg({ type: 'ok', text: t('modelProviders.quickSetupSuccess', { name: info.displayName ?? providerName }) });
      } else {
        setQuickSetupMsg({ type: 'err', text: (data as { error: string }).error ?? t('modelProviders.failedToAdd') });
      }
    } catch { setQuickSetupMsg({ type: 'err', text: t('common:networkError') }); }
    finally { setQuickSetupSaving(false); }
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
    'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner',
  ]);

  const [switchingModel, setSwitchingModel] = useState<string | null>(null);

  // Provider connectivity test state
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; error?: string; errorCode?: number; durationMs?: number; reply?: string }>>({});

  const testProvider = async (providerName: string) => {
    setTestingProvider(providerName);
    setTestResults(prev => { const n = { ...prev }; delete n[providerName]; return n; });
    try {
      const res = await fetch(`/api/settings/llm/providers/${providerName}/test`, {
        method: 'POST', headers: authHeaders(),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({})) as { error?: string };
        setTestResults(prev => ({ ...prev, [providerName]: { ok: false, error: errData.error ?? `HTTP ${res.status}`, errorCode: res.status } }));
        return;
      }
      const data = await res.json() as { ok: boolean; error?: string; errorCode?: number; durationMs?: number; reply?: string };
      setTestResults(prev => ({ ...prev, [providerName]: data }));
    } catch {
      setTestResults(prev => ({ ...prev, [providerName]: { ok: false, error: t('common:networkError') } }));
    } finally {
      setTestingProvider(null);
    }
  };

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

  const saveSearchKeys = async () => {
    const hasAny = searchForm.serperApiKey || searchForm.tavilyApiKey || searchForm.bingApiKey || searchForm.googleSearchApiKey || searchForm.googleSearchCx || searchForm.serpApiKey || searchForm.braveApiKey || searchForm.exaApiKey || searchForm.bochaApiKey;
    if (!hasAny) return;
    setSearchSaving(true); setSearchMsg(null);
    try {
      const updates: Record<string, string> = {};
      if (searchForm.serperApiKey) updates.serperApiKey = searchForm.serperApiKey;
      if (searchForm.tavilyApiKey) updates.tavilyApiKey = searchForm.tavilyApiKey;
      if (searchForm.bingApiKey) updates.bingApiKey = searchForm.bingApiKey;
      if (searchForm.googleSearchApiKey) updates.googleSearchApiKey = searchForm.googleSearchApiKey;
      if (searchForm.googleSearchCx) updates.googleSearchCx = searchForm.googleSearchCx;
      if (searchForm.serpApiKey) updates.serpApiKey = searchForm.serpApiKey;
      if (searchForm.braveApiKey) updates.braveApiKey = searchForm.braveApiKey;
      if (searchForm.exaApiKey) updates.exaApiKey = searchForm.exaApiKey;
      if (searchForm.bochaApiKey) updates.bochaApiKey = searchForm.bochaApiKey;
      const d = await api.settings.updateSearch(updates);
      setSearchKeys(d);
      setSearchForm({ serperApiKey: '', tavilyApiKey: '', bingApiKey: '', googleSearchApiKey: '', googleSearchCx: '', serpApiKey: '', braveApiKey: '', exaApiKey: '', bochaApiKey: '' });
      setSearchMsg({ type: 'ok', text: t('searchApi.saved') });
    } catch { setSearchMsg({ type: 'err', text: t('searchApi.failedToSave') }); }
    finally { setSearchSaving(false); }
  };

  const enabledProviders = llm?.providers
    ? Object.entries(llm.providers).filter(([, v]) => v.configured && v.enabled).map(([k]) => k) : [];

  const showSetupGuide = llm && !hasConfiguredProviders && !setupDismissed;
  const canManageOrgSettings = authUser?.role === 'owner' || authUser?.role === 'admin';

  const visibleTabs = SETTINGS_TABS.filter(tab => !tab.adminOnly || canManageOrgSettings);

  return (
    <div className="flex-1 flex overflow-hidden">
      {showEditProfile && authUser && (
        <EditProfileModal
          authUser={authUser}
          onClose={() => setShowEditProfile(false)}
          onSaved={u => { setShowEditProfile(false); onUserUpdated?.(u); }}
        />
      )}

      {/* Settings Sidebar */}
      <aside className="hidden md:flex flex-col w-56 shrink-0 border-r border-border-default bg-surface-secondary overflow-y-auto">
        <div className="px-3 pt-4 pb-2">
          <button
            onClick={() => { navBus.navigate(PAGE.HOME); }}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm text-fg-secondary hover:text-fg-primary hover:bg-surface-overlay transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><polyline points="12 19 5 12 12 5" /></svg>
            {t('common:back', { defaultValue: 'Back' })}
          </button>
        </div>
        <div className="px-5 pb-4">
          <h2 className="text-base font-semibold text-fg-primary">{t('title')}</h2>
        </div>
        <nav className="flex-1 px-3 pb-4 space-y-0.5">
          {visibleTabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => navigateTab(tab.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                resolvedTab === tab.id
                  ? 'bg-brand-600/10 text-brand-600 dark:text-brand-400 font-medium'
                  : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-overlay'
              }`}
            >
              {t(`settings:${tab.labelKey}`)}
            </button>
          ))}
        </nav>
        {authUser && (
          <div className="px-3 pb-4 border-t border-border-default pt-3">
            <div ref={userMenuRef} className="relative">
              <button
                onClick={() => setUserMenuOpen(!userMenuOpen)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-overlay transition-colors"
              >
                <Avatar name={authUser.name || t('common:userPlaceholder')} avatarUrl={authUser.avatarUrl} size={24} />
                <span className="text-sm text-fg-secondary truncate flex-1 text-left">{authUser.name || t('common:userPlaceholder')}</span>
              </button>
              {userMenuOpen && (
                <div className="absolute left-0 bottom-full mb-1 bg-surface-secondary border border-border-default rounded-xl shadow-xl z-50 overflow-hidden" style={{ minWidth: 200 }}>
                  <div className="px-4 py-3 border-b border-border-default">
                    <div className="text-sm font-medium text-fg-primary">{authUser.name || t('common:userPlaceholder')}</div>
                    <div className="text-xs text-fg-tertiary mt-0.5">{authUser.email || authUser.role}</div>
                  </div>
                  <div className="py-1">
                    <button
                      onClick={() => { setUserMenuOpen(false); setShowEditProfile(true); }}
                      className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-fg-secondary hover:bg-surface-overlay transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
                      {t('common:profile.editProfile')}
                    </button>
                    {onLogout && (
                      <button
                        onClick={() => { setUserMenuOpen(false); onLogout(); }}
                        className="w-full flex items-center gap-2.5 px-4 py-2 text-sm text-red-500 hover:bg-red-500/10 transition-colors"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>
                        {t('common:signOut', { defaultValue: 'Sign Out' })}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </aside>

      {/* Content Panel */}
      <div className="flex-1 overflow-y-auto">
      {/* Mobile: settings list (when no sub-tab selected) */}
      {isMobile && resolvedTab === null && (
        <div className="flex flex-col h-full">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border-default bg-surface-secondary">
            <button
              onClick={() => navBus.navigate(PAGE.HOME)}
              className="p-1.5 rounded-lg hover:bg-surface-overlay transition-colors"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><polyline points="12 19 5 12 12 5" /></svg>
            </button>
            <h1 className="text-base font-semibold text-fg-primary">{t('title')}</h1>
          </div>
          <nav className="flex-1 overflow-y-auto py-2 px-3">
            {visibleTabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => navigateTab(tab.id)}
                className="w-full flex items-center justify-between px-4 py-3 rounded-lg text-sm text-fg-primary hover:bg-surface-overlay transition-colors"
              >
                <span>{t(`settings:${tab.labelKey}`)}</span>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-fg-tertiary"><polyline points="9 18 15 12 9 6" /></svg>
              </button>
            ))}
          </nav>
        </div>
      )}
      {/* Mobile: sub-page header with back button */}
      {isMobile && resolvedTab !== null && (
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border-default bg-surface-secondary sticky top-0 z-10">
          <button
            onClick={navigateBackToList}
            className="p-1.5 rounded-lg hover:bg-surface-overlay transition-colors"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><polyline points="12 19 5 12 12 5" /></svg>
          </button>
          <h1 className="text-base font-semibold text-fg-primary">{t(`settings:${visibleTabs.find(tb => tb.id === resolvedTab)?.labelKey || 'title'}`)}</h1>
        </div>
      )}
      {resolvedTab !== null && <div className="p-7 space-y-10 max-w-4xl mx-auto w-full">

        {/* ───── Appearance ───── */}
        {resolvedTab === 'appearance' && <Section title={t('appearance.title')}>
          <div className="bg-surface-elevated rounded-xl p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="text-sm font-medium">{t('appearance.theme')}</div>
                <div className="text-xs text-fg-tertiary mt-0.5">{t('appearance.themeDesc')}</div>
              </div>
              <div className="flex flex-wrap gap-1 bg-surface-elevated rounded-lg p-0.5">
                {THEME_OPTIONS.map(({ value }) => (
                  <button
                    key={value}
                    onClick={() => onThemeChange?.(value)}
                    className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                      theme === value ? 'bg-brand-600 text-white' : 'text-fg-secondary hover:text-fg-primary'
                    }`}
                  >
                    {t(`appearance.modes.${value}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mt-5 pt-5 border-t border-border-default/50">
              <div>
                <div className="text-sm font-medium">{t('appearance.language')}</div>
                <div className="text-xs text-fg-tertiary mt-0.5">{t('appearance.languageDesc')}</div>
              </div>
              <div className="flex flex-wrap gap-1 bg-surface-elevated rounded-lg p-0.5">
                {SUPPORTED_LANGUAGES.map(({ code, label }) => (
                  <button
                    key={code}
                    onClick={() => { i18n.changeLanguage(code); }}
                    className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                      i18n.language === code || (code === 'en' && !SUPPORTED_LANGUAGES.some(l => l.code === i18n.language))
                        ? 'bg-brand-600 text-white' : 'text-fg-secondary hover:text-fg-primary'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Section>}

        {canManageOrgSettings && (
        <>
        {/* ───── First-Run Setup Guide (shown in providers tab) ───── */}
        {resolvedTab === 'providers' && <>
        {showSetupGuide && (
          <div className="relative bg-gradient-to-br from-brand-500/10 to-surface-secondary border border-brand-500/20 rounded-2xl p-6 space-y-5">
            <button onClick={() => setSetupDismissed(true)}
              className="absolute top-4 right-4 text-fg-tertiary hover:text-fg-secondary text-xs">{t('setupGuide.skip')}</button>
            <div>
              <h3 className="text-base font-semibold text-fg-primary">{t('setupGuide.title')}</h3>
              <p className="text-sm text-fg-secondary mt-1">{t('setupGuide.subtitle')}</p>
            </div>

            {/* Option 1: Environment variables (auto-detected) */}
            <SetupCard
              step={t('setupGuide.fromEnv.step')}
              title={t('setupGuide.fromEnv.title')}
              description={t('setupGuide.fromEnv.description')}
              active={!!(envModels && envModels.detected.length > 0)}
            >
              {envLoading && <div className="text-xs text-fg-tertiary">{t('common:detecting')}</div>}
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
                    {envApplying ? t('common:applying') : t('setupGuide.applyProviders', { count: Object.values(envSelected).filter(Boolean).length })}
                  </button>
                </div>
              )}
              {envModels && envModels.detected.length === 0 && (
                <div className="text-xs text-fg-tertiary">
                  <Trans i18nKey="settings:setupGuide.fromEnv.noKeysHint" components={{ code: <code className="text-fg-secondary" /> }} />
                </div>
              )}
              {envMsg && <Msg type={envMsg.type} text={envMsg.text} />}
            </SetupCard>

            {/* Option 2: Local Ollama */}
            <SetupCard
              step={t('setupGuide.fromOllama.step')}
              title={t('setupGuide.fromOllama.title')}
              description={t('setupGuide.fromOllama.description')}
              active={!!(ollamaDetect?.found)}
            >
              {ollamaLoading && <div className="text-xs text-fg-tertiary">{t('common:detecting')}</div>}
              {ollamaDetect?.found && ollamaDetect.models && ollamaDetect.models.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs text-green-600">{t('ollama.foundModels', { count: ollamaDetect.models.length, url: ollamaDetect.baseUrl })}</div>
                  <select
                    value={ollamaSelectedModel}
                    onChange={e => setOllamaSelectedModel(e.target.value)}
                    className="w-full px-3 py-2 bg-surface-overlay border border-border-default rounded-lg text-sm text-fg-primary focus:outline-none focus:ring-2 focus:ring-brand-500"
                  >
                    {ollamaDetect.models.map(m => (
                      <option key={m.name} value={m.name}>
                        {m.name}{m.parameterSize ? ` (${m.parameterSize})` : ''}{m.family ? ` — ${m.family}` : ''}
                      </option>
                    ))}
                  </select>
                  <button onClick={() => void applyOllama()} disabled={ollamaApplying || !ollamaSelectedModel}
                    className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                    {ollamaApplying ? t('common:applying') : t('ollama.useModel', { model: ollamaSelectedModel })}
                  </button>
                </div>
              )}
              {!ollamaLoading && !ollamaDetect && (
                <button onClick={() => void detectOllama()} className="px-4 py-2 border border-border-default hover:bg-surface-elevated text-fg-secondary text-sm rounded-lg transition-colors">
                  {t('ollama.detect')}
                </button>
              )}
              {ollamaDetect && !ollamaDetect.found && (
                <div className="text-xs text-fg-tertiary">{t('ollama.notRunning')}</div>
              )}
              {ollamaMsg && <Msg type={ollamaMsg.type} text={ollamaMsg.text} />}
            </SetupCard>

            {/* Option 3: OpenClaw */}
            <SetupCard
              step={t('setupGuide.fromOpenClaw.step')}
              title={t('setupGuide.fromOpenClaw.title')}
              description={t('setupGuide.fromOpenClaw.description')}
            >
              {!openclawPreview ? (
                <button onClick={() => void detectOpenclaw()} disabled={openclawLoading}
                  className="px-4 py-2 border border-border-default hover:bg-surface-elevated disabled:opacity-40 text-fg-secondary text-sm rounded-lg transition-colors">
                  {openclawLoading ? t('common:detecting') : t('openClaw.detectShort')}
                </button>
              ) : openclawPreview.found ? (
                <div className="space-y-2">
                  <div className="text-xs text-green-600">{t('setupGuide.foundPrefix')} <code className="text-fg-secondary">{openclawPreview.summary.configPath}</code></div>
                  {openclawPreview.summary.models && (
                    <div className="text-xs text-fg-secondary">{t('openClaw.providersModels', { providers: openclawPreview.summary.models.providerCount, models: openclawPreview.summary.models.providers.reduce((s, p) => s + p.modelCount, 0) })}</div>
                  )}
                  <button onClick={() => void importOpenclaw()} disabled={openclawLoading}
                    className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                    {openclawLoading ? t('common:importing') : t('openClaw.importConfigs')}
                  </button>
                </div>
              ) : (
                <div className="text-xs text-fg-tertiary">{t('openClaw.notFound')}</div>
              )}
              {openclawMsg && <Msg type={openclawMsg.type} text={openclawMsg.text} />}
            </SetupCard>

            {/* Option 4: Manual hint */}
            <SetupCard
              step={t('setupGuide.manual.step')}
              title={t('setupGuide.manual.title')}
              description={<Trans i18nKey="settings:setupGuide.manual.description" components={{ code: <code className="text-fg-secondary" /> }} />}
            />

            {/* Option 5: Chrome Extension (only shown in Chrome) */}
            {/Chrome\/\d/.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent) && (
              <SetupCard
                step={t('setupGuide.browserExtension.step')}
                title={t('setupGuide.browserExtension.title')}
                description={t('setupGuide.browserExtension.description')}
                active={browserExtensionConnected}
              >
                {browserExtensionConnected ? (
                  <div className="flex items-center gap-1.5 text-xs text-green-400">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    {t('setupGuide.browserExtension.alreadyConnected')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <button
                        disabled={browserSaving}
                        onClick={async () => {
                          setBrowserSaving(true);
                          try { await api.settings.downloadExtensionZip(); } catch { /* ignore */ }
                          setBrowserSaving(false);
                        }}
                        className="px-3 py-1.5 text-xs bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-40 inline-flex items-center gap-1.5"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                        {t('setupGuide.browserExtension.downloadBtn')}
                      </button>
                      <button
                        disabled={browserSaving}
                        onClick={async () => {
                          try { await api.settings.openExtensionsPage(); } catch { /* ignore */ }
                        }}
                        className="px-3 py-1.5 text-xs border border-border-default text-fg-primary rounded-lg hover:bg-surface-elevated transition-colors disabled:opacity-40 inline-flex items-center gap-1.5"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                        {t('setupGuide.browserExtension.openChromeBtn')}
                      </button>
                    </div>
                    <div className="text-xs text-fg-tertiary">{t('setupGuide.browserExtension.loadHint')}</div>
                  </div>
                )}
              </SetupCard>
            )}
          </div>
        )}

        {/* ───── System Status ───── */}
        <Section title={t('systemStatus.title')}>
          {health ? (
            <div className="grid grid-cols-3 gap-4">
              <InfoCard label={t('systemStatus.status')} value={health.status === 'ok' ? t('systemStatus.healthy') : health.status} color="green" />
              <InfoCard label={t('systemStatus.version')} value={health.version} color="indigo" />
              <InfoCard label={t('systemStatus.activeAgents')} value={String(health.agents)} color="purple" />
            </div>
          ) : <div className="text-sm text-fg-tertiary">{t('common:loading')}</div>}
        </Section>

        {/* ───── Default Provider ───── */}
        
        <Section title={t('defaultProvider.title')}>
          <div className="bg-surface-elevated rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{t('defaultProvider.primaryProvider')}</div>
                <div className="text-xs text-fg-tertiary mt-0.5">{t('defaultProvider.primaryProviderDesc')}</div>
              </div>
              <div className="flex items-center gap-3">
                {llm ? (
                  <select value={selectedProvider} onChange={e => { setSelectedProvider(e.target.value); setSaveMsg(null); }}
                    className="px-3 py-1.5 bg-surface-elevated border border-border-default rounded-lg text-sm w-48 focus:border-brand-500 outline-none">
                    {enabledProviders.length > 0 ? enabledProviders.map(p => <option key={p} value={p}>{llm.providers[p]?.displayName ?? p}</option>) : <option value="">{t('defaultProvider.noProviders')}</option>}
                  </select>
                ) : <div className="text-xs text-fg-tertiary">{t('common:loading')}</div>}
                {selectedProvider !== llm?.defaultProvider && (
                  <button onClick={() => void saveLLM()} disabled={saving}
                    className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white rounded-lg transition-colors">
                    {saving ? t('common:saving') : t('common:save')}
                  </button>
                )}
              </div>
            </div>
            {saveMsg && <Msg type={saveMsg.type} text={saveMsg.text} />}

            <div className="flex items-center justify-between border-t border-border-default pt-4">
              <div>
                <div className="text-sm font-medium text-fg-primary">{t('defaultProvider.autoFallback')}</div>
                <div className="text-xs text-fg-tertiary mt-0.5">{t('defaultProvider.autoFallbackDesc')}</div>
              </div>
              <button
                onClick={async () => {
                  const newVal = !(llm?.autoFallback ?? true);
                  try {
                    const res = await fetch('/api/settings/llm', {
                      method: 'POST', headers: authHeaders(),
                      body: JSON.stringify({ autoFallback: newVal }),
                    });
                    if (res.ok) {
                      const data = await res.json() as LLMSettings;
                      setLlm(data);
                    }
                  } catch { /* ignore */ }
                }}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${(llm?.autoFallback ?? true) ? 'bg-green-500' : 'bg-gray-600'}`}
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${(llm?.autoFallback ?? true) ? 'translate-x-4' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>
        </Section>

        {/* OAuth Authentication section removed */}

        {/* ───── Model Providers ───── */}
        <Section title={t('modelProviders.title')}>
          <div className="space-y-3">
            {llm && Object.entries(llm.providers).map(([name, info]) => (
              <div key={name} className={`bg-surface-secondary border rounded-xl overflow-hidden transition-colors ${info.configured ? 'border-border-default hover:border-gray-600' : 'border-border-default/50 hover:border-brand-500/30'}`}>
                <div className="flex items-center justify-between px-5 py-4 cursor-pointer" onClick={() => { setExpandedProvider(expandedProvider === name ? null : name); setQuickSetupKey(''); setQuickSetupMsg(null); }}>
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${info.configured && info.enabled ? 'bg-green-400' : info.configured ? 'bg-amber-400' : 'bg-gray-600'}`} />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{info.displayName ?? name}</span>
                        {name === llm.defaultProvider && <span className="text-[10px] bg-brand-500/15 text-brand-500 px-1.5 py-0.5 rounded">{t('modelProviders.badgeDefault')}</span>}
                        {info.configured && !info.enabled && <span className="text-[10px] bg-amber-500/15 text-amber-600 px-1.5 py-0.5 rounded">{t('modelProviders.disabled')}</span>}
                        {info.oauthConnected && <span className="text-[10px] bg-green-500/15 text-green-600 px-1.5 py-0.5 rounded">{t('modelProviders.badgeOAuth')}</span>}
                        {testResults[name]?.ok === true && <span className="text-[10px] bg-green-500/15 text-green-600 px-1.5 py-0.5 rounded">{t('modelProviders.testOk', { ms: testResults[name].durationMs })}</span>}
                        {testResults[name]?.ok === false && (
                          <span className="text-[10px] bg-red-500/15 text-red-500 px-1.5 py-0.5 rounded" title={testResults[name].error}>
                            {testResults[name].errorCode
                              ? t('modelProviders.testFailedCode', { code: testResults[name].errorCode })
                              : t('modelProviders.testFailed')}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-fg-tertiary mt-0.5">
                        {info.configured ? (
                          <>{info.model}{info.apiKeyPreview && <> · <code className="text-fg-secondary">{info.apiKeyPreview}</code></>}</>
                        ) : t('modelProviders.notConfigured')}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    {info.configured && (
                      <button
                        onClick={e => { e.stopPropagation(); void toggleProvider(name, !info.enabled); }}
                        disabled={togglingProvider === name}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${info.enabled ? 'bg-green-500' : 'bg-gray-600'} ${togglingProvider === name ? 'opacity-50' : ''}`}
                        title={info.enabled ? t('modelProviders.clickToDisable') : t('modelProviders.clickToEnable')}
                      >
                        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${info.enabled ? 'translate-x-4' : 'translate-x-1'}`} />
                      </button>
                    )}
                    {info.contextWindow && <span className="text-[10px] text-fg-tertiary">{t('modelProviders.ctxTokens', { size: (info.contextWindow / 1000).toFixed(0) })}</span>}
                    {info.cost && <span className="text-[10px] text-fg-tertiary">{t('modelProviders.costPerMillion', { input: info.cost.input, output: info.cost.output })}</span>}
                    <span className="text-fg-tertiary text-xs">{expandedProvider === name ? '▲' : '▼'}</span>
                  </div>
                </div>

                {expandedProvider === name && (
                  <div className="px-5 pb-4 border-t border-border-default pt-4 space-y-4">
                    {info.configured && (
                      <>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <MiniStat label={t('modelProviders.model')} value={info.model} />
                          <MiniStat label={t('modelProviders.contextWindow')} value={info.contextWindow ? t('modelProviders.kTokens', { k: (info.contextWindow / 1000).toFixed(0) }) : t('modelProviders.notApplicable')} />
                          <MiniStat label={t('modelProviders.maxOutput')} value={info.maxOutputTokens ? t('modelProviders.kTokens', { k: (info.maxOutputTokens / 1000).toFixed(0) }) : t('modelProviders.notApplicable')} />
                          <MiniStat label={t('modelProviders.baseUrlLabel')} value={info.baseUrl ?? t('modelProviders.baseUrlDisplayDefault')} />
                        </div>

                        {/* Edit / Delete provider actions */}
                        {editingProvider === name ? (
                          <div className="bg-surface-elevated/40 rounded-lg p-4 space-y-3">
                            <div className="text-[10px] text-fg-tertiary uppercase tracking-wider">{t('modelProviders.editProvider')}</div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.apiKey')}</label>
                                <input type="password" value={editProviderForm.apiKey}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, apiKey: e.target.value })}
                                  placeholder={t('modelProviders.apiKeyPlaceholder')}
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.baseUrl')}</label>
                                <input type="text" value={editProviderForm.baseUrl}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, baseUrl: e.target.value })}
                                  placeholder={t('modelProviders.baseUrlDisplayDefault')}
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.model')}</label>
                                <input type="text" value={editProviderForm.model}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, model: e.target.value })}
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary focus:border-brand-500 outline-none" />
                              </div>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.contextWindow')}</label>
                                <input type="number" value={editProviderForm.contextWindow || ''}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, contextWindow: Number(e.target.value) })}
                                  placeholder={t('modelProviders.placeholderContextExample')}
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.maxOutputTokens')}</label>
                                <input type="number" value={editProviderForm.maxOutputTokens || ''}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, maxOutputTokens: Number(e.target.value) })}
                                  placeholder={t('modelProviders.placeholderMaxOutputExample')}
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.inputCost')}</label>
                                <input type="number" step="0.01" value={editProviderForm.costInput || ''}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, costInput: Number(e.target.value) })}
                                  placeholder={t('modelProviders.placeholderCostInput')}
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                              <div>
                                <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.outputCost')}</label>
                                <input type="number" step="0.01" value={editProviderForm.costOutput || ''}
                                  onChange={e => setEditProviderForm({ ...editProviderForm, costOutput: Number(e.target.value) })}
                                  placeholder={t('modelProviders.placeholderCostOutput')}
                                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button onClick={() => void saveEditProvider(name)} disabled={editProviderSaving}
                                className="px-3 py-1.5 text-xs bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white rounded-lg transition-colors">
                                {editProviderSaving ? t('common:saving') : t('common:save')}
                              </button>
                              <button onClick={() => setEditingProvider(null)}
                                className="px-3 py-1.5 text-xs border border-border-default text-fg-secondary hover:bg-surface-elevated rounded-lg transition-colors">
                                {t('common:cancel')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex gap-2">
                            <button onClick={e => { e.stopPropagation(); void testProvider(name); }}
                              disabled={testingProvider === name}
                              className="px-3 py-1.5 text-xs border border-green-500/30 text-green-500 hover:bg-green-500/10 rounded-lg transition-colors disabled:opacity-40 flex items-center gap-1.5">
                              {testingProvider === name ? (
                                <><svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>{t('modelProviders.testing')}</>
                              ) : t('modelProviders.test')}
                            </button>
                            <button onClick={e => { e.stopPropagation(); startEditProvider(name, info); }}
                              className="px-3 py-1.5 text-xs border border-border-default text-fg-secondary hover:bg-surface-elevated rounded-lg transition-colors">
                              {t('common:edit')}
                            </button>
                            <button onClick={e => { e.stopPropagation(); if (confirm(t('modelProviders.deleteConfirm', { name: info.displayName ?? name }))) void deleteProvider(name); }}
                              disabled={deletingProvider === name}
                              className="px-3 py-1.5 text-xs border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-40">
                              {deletingProvider === name ? t('common:deleting') : t('common:delete')}
                            </button>
                          </div>
                        )}

                        {/* Test result detail */}
                        {testResults[name] && (
                          <div className={`text-xs px-3 py-2 rounded-lg ${testResults[name].ok
                            ? 'bg-green-500/10 text-green-600 border border-green-500/30'
                            : 'bg-red-500/10 text-red-500 border border-red-500/30'}`}>
                            {testResults[name].ok
                              ? t('modelProviders.testSuccess', { ms: testResults[name].durationMs, reply: testResults[name].reply })
                              : testResults[name].error}
                          </div>
                        )}
                      </>
                    )}

                    {info.cost && (
                      <div className="bg-surface-elevated/40 rounded-lg p-3">
                        <div className="text-[10px] text-fg-tertiary uppercase tracking-wider mb-2">{t('modelProviders.pricingTitle')}</div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <MiniStat label={t('modelProviders.input')} value={`$${info.cost.input}`} />
                          <MiniStat label={t('modelProviders.output')} value={`$${info.cost.output}`} />
                          {info.cost.cacheRead != null && <MiniStat label={t('modelProviders.cacheRead')} value={`$${info.cost.cacheRead}`} />}
                          {info.cost.cacheWrite != null && <MiniStat label={t('modelProviders.cacheWrite')} value={`$${info.cost.cacheWrite}`} />}
                        </div>
                      </div>
                    )}

                    {/* Available Models */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[10px] text-fg-tertiary uppercase tracking-wider">{t('modelProviders.availableModels')}</div>
                        {info.configured && addingModelProvider !== name && (
                          <button onClick={() => { setAddingModelProvider(name); setAddModelForm({ id: '', name: '', contextWindow: 128000, maxOutputTokens: 16384, costInput: 1, costOutput: 5, reasoning: false, vision: false }); }}
                            className="text-[10px] text-brand-500 hover:text-brand-400 transition-colors">
                            {t('modelProviders.addModel')}
                          </button>
                        )}
                      </div>

                      {/* Add model form */}
                      {addingModelProvider === name && (
                        <div className="bg-surface-elevated/40 rounded-lg p-3 mb-2 space-y-2">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                            <input type="text" placeholder={t('modelProviders.modelId')} value={addModelForm.id}
                              onChange={e => setAddModelForm({ ...addModelForm, id: e.target.value })}
                              className="px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                            <input type="text" placeholder={t('modelProviders.displayName')} value={addModelForm.name}
                              onChange={e => setAddModelForm({ ...addModelForm, name: e.target.value })}
                              className="px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                            <input type="number" placeholder={t('modelProviders.placeholderContextTokens')} value={addModelForm.contextWindow}
                              onChange={e => setAddModelForm({ ...addModelForm, contextWindow: Number(e.target.value) })}
                              className="px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary focus:border-brand-500 outline-none" />
                            <input type="number" placeholder={t('modelProviders.maxOutput')} value={addModelForm.maxOutputTokens}
                              onChange={e => setAddModelForm({ ...addModelForm, maxOutputTokens: Number(e.target.value) })}
                              className="px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary focus:border-brand-500 outline-none" />
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-fg-tertiary">{t('modelProviders.costPerMillionIn')}</span>
                              <input type="number" step="0.01" value={addModelForm.costInput}
                                onChange={e => setAddModelForm({ ...addModelForm, costInput: Number(e.target.value) })}
                                className="w-16 px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary focus:border-brand-500 outline-none" />
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="text-[10px] text-fg-tertiary">{t('modelProviders.costPerMillionOut')}</span>
                              <input type="number" step="0.01" value={addModelForm.costOutput}
                                onChange={e => setAddModelForm({ ...addModelForm, costOutput: Number(e.target.value) })}
                                className="w-16 px-2 py-1 text-xs bg-surface-primary border border-border-default rounded text-fg-primary focus:border-brand-500 outline-none" />
                            </div>
                            <label className="flex items-center gap-1 text-[10px] text-fg-tertiary cursor-pointer">
                              <input type="checkbox" checked={addModelForm.reasoning}
                                onChange={e => setAddModelForm({ ...addModelForm, reasoning: e.target.checked })} className="rounded" />
                              {t('modelProviders.reasoning')}
                            </label>
                            <label className="flex items-center gap-1 text-[10px] text-fg-tertiary cursor-pointer">
                              <input type="checkbox" checked={addModelForm.vision}
                                onChange={e => setAddModelForm({ ...addModelForm, vision: e.target.checked })} className="rounded" />
                              {t('modelProviders.vision')}
                            </label>
                            <div className="flex-1" />
                            <button onClick={() => void addCustomModel(name)} disabled={addModelSaving || !addModelForm.id || !addModelForm.name}
                              className="px-2 py-1 text-[10px] bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white rounded transition-colors">
                              {addModelSaving ? t('modelProviders.adding') : t('common:create')}
                            </button>
                            <button onClick={() => setAddingModelProvider(null)}
                              className="px-2 py-1 text-[10px] border border-border-default text-fg-secondary hover:bg-surface-elevated rounded transition-colors">
                              {t('common:cancel')}
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
                                  {m.reasoning && <span className="text-[9px] bg-amber-500/15 text-amber-600 px-1 py-0.5 rounded">{t('modelProviders.reasoning')}</span>}
                                  {m.inputTypes?.includes('image') && <span className="text-[9px] bg-blue-500/15 text-blue-600 px-1 py-0.5 rounded">{t('modelProviders.vision')}</span>}
                                  {isCustom && <span className="text-[9px] bg-purple-500/15 text-purple-400 px-1 py-0.5 rounded">{t('modelProviders.custom')}</span>}
                                </div>
                                <div className="flex items-center gap-3 text-fg-tertiary">
                                  <span>{t('modelProviders.ctxTokens', { size: (m.contextWindow / 1000).toFixed(0) })}</span>
                                  <span>{t('modelProviders.costPair', { input: m.cost.input, output: m.cost.output })}</span>
                                  {info.configured && !isActive && (
                                    <span className={`text-[9px] px-1.5 py-0.5 rounded transition-colors ${
                                      isSwitching
                                        ? 'bg-brand-500/30 text-brand-400'
                                        : 'bg-surface-overlay text-fg-tertiary hover:bg-brand-500/20 hover:text-brand-500'
                                    }`}>
                                      {isSwitching ? t('modelProviders.switching') : t('modelProviders.use')}
                                    </span>
                                  )}
                                  {isActive && (
                                    <span className="text-[9px] bg-brand-500/15 text-brand-500 px-1.5 py-0.5 rounded">{t('modelProviders.active')}</span>
                                  )}
                                  {isCustom && !isActive && (
                                    <button onClick={e => { e.stopPropagation(); void deleteCustomModel(name, m.id); }}
                                      className="text-red-400 hover:text-red-300 transition-colors" title={t('modelProviders.deleteCustomModelTitle')}>
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
                      <div className="space-y-3">
                        <div className="text-xs text-fg-secondary">{t('modelProviders.quickSetupHint')}</div>
                        <div className="flex items-center gap-2">
                          <input
                            type="password"
                            value={expandedProvider === name ? quickSetupKey : ''}
                            onChange={e => setQuickSetupKey(e.target.value)}
                            placeholder={t('modelProviders.quickSetupPlaceholder')}
                            className="flex-1 px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none"
                            onKeyDown={e => { if (e.key === 'Enter' && quickSetupKey.trim()) void quickSetupProvider(name, info); }}
                          />
                          <button
                            onClick={() => void quickSetupProvider(name, info)}
                            disabled={quickSetupSaving || !quickSetupKey.trim()}
                            className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white rounded-lg transition-colors whitespace-nowrap"
                          >
                            {quickSetupSaving ? t('modelProviders.quickSetupSaving') : t('modelProviders.quickSetupSubmit')}
                          </button>
                        </div>
                        {quickSetupMsg && expandedProvider === name && <Msg type={quickSetupMsg.type} text={quickSetupMsg.text} />}
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
              {t('modelProviders.addProvider')}
            </button>
          ) : (
            <div className="mt-3 bg-surface-secondary border border-brand-500/30 rounded-xl p-5 space-y-4">
              <div className="text-sm font-medium text-fg-primary">{t('modelProviders.addNewProvider')}</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.providerName')}</label>
                  <input type="text" value={addProviderForm.name}
                    onChange={e => setAddProviderForm({ ...addProviderForm, name: e.target.value })}
                    placeholder={t('modelProviders.placeholderProviderName')}
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                  <div className="text-[10px] text-fg-tertiary mt-1">{t('modelProviders.providerNameHint')}</div>
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.apiKey')}</label>
                  <input type="password" value={addProviderForm.apiKey}
                    onChange={e => setAddProviderForm({ ...addProviderForm, apiKey: e.target.value })}
                    placeholder={t('modelProviders.placeholderApiKeySk')}
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.baseUrl')}</label>
                  <input type="text" value={addProviderForm.baseUrl}
                    onChange={e => setAddProviderForm({ ...addProviderForm, baseUrl: e.target.value })}
                    placeholder={t('modelProviders.placeholderBaseUrl')}
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.defaultModel')}</label>
                  <input type="text" value={addProviderForm.model}
                    onChange={e => setAddProviderForm({ ...addProviderForm, model: e.target.value })}
                    placeholder={t('modelProviders.placeholderDefaultModel')}
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.contextWindow')}</label>
                  <input type="number" value={addProviderForm.contextWindow}
                    onChange={e => setAddProviderForm({ ...addProviderForm, contextWindow: Number(e.target.value) })}
                    placeholder="128000"
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.maxOutputTokens')}</label>
                  <input type="number" value={addProviderForm.maxOutputTokens}
                    onChange={e => setAddProviderForm({ ...addProviderForm, maxOutputTokens: Number(e.target.value) })}
                    placeholder="16384"
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.inputCost')}</label>
                  <input type="number" step="0.01" value={addProviderForm.costInput}
                    onChange={e => setAddProviderForm({ ...addProviderForm, costInput: Number(e.target.value) })}
                    placeholder="1"
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
                <div>
                  <label className="text-[10px] text-fg-tertiary uppercase block mb-1">{t('modelProviders.outputCost')}</label>
                  <input type="number" step="0.01" value={addProviderForm.costOutput}
                    onChange={e => setAddProviderForm({ ...addProviderForm, costOutput: Number(e.target.value) })}
                    placeholder="5"
                    className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none" />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => void addProvider()} disabled={addProviderSaving || !addProviderForm.name || !addProviderForm.model}
                  className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white rounded-lg transition-colors">
                  {addProviderSaving ? t('modelProviders.adding') : t('modelProviders.addProviderSubmit')}
                </button>
                <button onClick={() => { setShowAddProvider(false); setAddProviderMsg(null); }}
                  className="px-4 py-2 text-sm border border-border-default text-fg-secondary hover:bg-surface-elevated rounded-lg transition-colors">
                  {t('common:cancel')}
                </button>
              </div>
              {addProviderMsg && <Msg type={addProviderMsg.type} text={addProviderMsg.text} />}
            </div>
          )}
        </Section>

        <div className="border-t border-border-default" />

        {/* ───── Auto-detect & Import ───── */}
        <Section title={t('autoDetect.title')}>
          <div className="bg-surface-elevated rounded-xl p-5 space-y-5">
            <div className="text-sm text-fg-secondary">{t('autoDetect.description')}</div>

            {/* — Environment Variables — */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-semibold text-fg-secondary uppercase tracking-wider">{t('envConfig.title')}</h4>
                <button onClick={() => void detectEnvModels()} disabled={envLoading}
                  className="px-3 py-1 border border-border-default hover:bg-surface-elevated disabled:opacity-40 text-fg-tertiary text-xs rounded-md transition-colors flex items-center gap-1.5">
                  <svg className={`w-3.5 h-3.5 ${envLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                  {envLoading ? t('common:detecting') : t('envConfig.refreshEnv')}
                </button>
              </div>
              {envModels && envModels.detected.length > 0 && (
                <div className="space-y-2">
                  {envModels.detected.map(d => (
                    <label key={d.provider} className="flex items-center justify-between bg-surface-elevated/30 rounded-lg px-4 py-3 cursor-pointer hover:bg-surface-elevated/50 transition-colors">
                      <div className="flex items-center gap-3">
                        <input type="checkbox" checked={envSelected[d.provider] ?? false}
                          onChange={e => setEnvSelected({ ...envSelected, [d.provider]: e.target.checked })}
                          className="w-4 h-4 rounded bg-surface-overlay border-gray-600 text-brand-500 focus:ring-brand-500" />
                        <div>
                          <div className="text-sm text-fg-primary font-medium">{d.displayName}</div>
                          <div className="text-xs text-fg-tertiary mt-0.5">
                            {t('envConfig.keyLabel')} <code className="text-fg-secondary">{d.apiKeyPreview}</code>
                            {' / '}{t('envConfig.modelLabel')} <code className="text-fg-secondary">{d.model}</code>
                            {d.baseUrl && <>{' / '}{t('envConfig.urlLabel')} <code className="text-fg-secondary">{d.baseUrl}</code></>}
                          </div>
                        </div>
                      </div>
                      <div className="text-xs text-fg-tertiary">
                        {Object.keys(d.envVars).map(k => <div key={k}><code>{k}</code></div>)}
                      </div>
                    </label>
                  ))}
                  {envModels.timeoutMs && (
                    <div className="text-xs text-fg-tertiary">{t('envConfig.llmTimeout', { ms: envModels.timeoutMs })}</div>
                  )}
                  <button onClick={() => void applyEnvModels()} disabled={envApplying || Object.values(envSelected).filter(Boolean).length === 0}
                    className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                    {envApplying ? t('common:applying') : t('envConfig.applyToConfig', { count: Object.values(envSelected).filter(Boolean).length })}
                  </button>
                </div>
              )}
              {envMsg && <Msg type={envMsg.type} text={envMsg.text} />}
            </div>

            <div className="border-t border-border-default" />

            {/* — Local Ollama — */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-semibold text-fg-secondary uppercase tracking-wider">{t('ollama.title')}</h4>
                <button onClick={() => void detectOllama()} disabled={ollamaLoading}
                  className="px-3 py-1 border border-border-default hover:bg-surface-elevated disabled:opacity-40 text-fg-tertiary text-xs rounded-md transition-colors flex items-center gap-1.5">
                  <svg className={`w-3.5 h-3.5 ${ollamaLoading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                  {ollamaLoading ? t('common:detecting') : t('ollama.detect')}
                </button>
              </div>
              {ollamaDetect?.found && ollamaDetect.models && ollamaDetect.models.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs text-green-600">{t('ollama.foundModels', { count: ollamaDetect.models.length, url: ollamaDetect.baseUrl })}</div>
                  <div className="space-y-1">
                    {ollamaDetect.models.map(m => (
                      <label key={m.name} className={`flex items-center justify-between rounded-lg px-4 py-3 cursor-pointer transition-colors ${ollamaSelectedModel === m.name ? 'bg-brand-500/15 border border-brand-500/40' : 'bg-surface-elevated/30 hover:bg-surface-elevated/50'}`}>
                        <div className="flex items-center gap-3">
                          <input type="radio" name="ollama-model" value={m.name} checked={ollamaSelectedModel === m.name}
                            onChange={() => setOllamaSelectedModel(m.name)}
                            className="w-4 h-4 text-brand-500 focus:ring-brand-500" />
                          <div>
                            <div className="text-sm text-fg-primary font-medium">{m.name}</div>
                            <div className="text-xs text-fg-tertiary mt-0.5">
                              {m.parameterSize && <span>{m.parameterSize}</span>}
                              {m.family && <span className="ml-2">{m.family}</span>}
                              {m.quantization && <span className="ml-2">{m.quantization}</span>}
                              {m.size && <span className="ml-2">{formatBytes(m.size)}</span>}
                            </div>
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                  <button onClick={() => void applyOllama()} disabled={ollamaApplying || !ollamaSelectedModel}
                    className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                    {ollamaApplying ? t('common:applying') : t('ollama.useModel', { model: ollamaSelectedModel })}
                  </button>
                </div>
              )}
              {ollamaDetect && !ollamaDetect.found && (
                <div className="text-xs text-fg-tertiary">{ollamaDetect.error || t('ollama.notRunning')}</div>
              )}
              {ollamaMsg && <Msg type={ollamaMsg.type} text={ollamaMsg.text} />}
            </div>

            <div className="border-t border-border-default" />

            {/* — Import from OpenClaw — */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <h4 className="text-xs font-semibold text-fg-secondary uppercase tracking-wider">{t('openClaw.title')}</h4>
                <button onClick={() => void detectOpenclaw()} disabled={openclawLoading}
                  className="px-3 py-1 border border-border-default hover:bg-surface-elevated disabled:opacity-40 text-fg-tertiary text-xs rounded-md transition-colors flex items-center gap-1.5">
                  {openclawLoading ? t('common:detecting') : t('openClaw.detectShort')}
                </button>
              </div>
              {openclawPreview && openclawPreview.found && (
                <div className="space-y-2">
                  <div className="text-xs text-green-600">{t('openClaw.foundAt')} <code className="text-fg-secondary">{openclawPreview.summary.configPath}</code></div>
                  {openclawPreview.summary.models && (
                    <div className="bg-surface-elevated/30 rounded-lg p-3">
                      <div className="text-xs text-fg-tertiary mb-2">{t('openClaw.modelProvidersFound', { count: openclawPreview.summary.models.providerCount })}</div>
                      <div className="space-y-1">
                        {openclawPreview.summary.models.providers.map(p => (
                          <div key={p.name} className="flex items-center justify-between text-xs">
                            <span className="text-fg-secondary">{p.name}</span>
                            <span className="text-fg-tertiary">{t('openClaw.modelsCountSuffix', { count: p.modelCount })}{p.baseUrl ? t('openClaw.withBaseUrl', { url: p.baseUrl }) : ''}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {openclawPreview.summary.channels && openclawPreview.summary.channels.length > 0 && (
                    <div className="bg-surface-elevated/30 rounded-lg p-3">
                      <div className="text-xs text-fg-tertiary mb-1">{t('openClaw.channelsPrefix')} {openclawPreview.summary.channels.join(', ')}</div>
                    </div>
                  )}
                  <button onClick={() => void importOpenclaw()} disabled={openclawLoading}
                    className="px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                    {openclawLoading ? t('common:importing') : t('openClaw.importConfigs')}
                  </button>
                </div>
              )}
              {openclawMsg && <Msg type={openclawMsg.type} text={openclawMsg.text} />}
            </div>
          </div>
        </Section>
        </>}

        {resolvedTab === 'execution' && <>
        <Section title={t('agentExecution.title')}>
          <div className="bg-surface-elevated rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-fg-primary">{t('agentExecution.maxToolIterations')}</div>
                <div className="text-xs text-fg-tertiary mt-0.5">{t('agentExecution.maxToolIterationsDesc')}</div>
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
                      setAgentMsg({ type: 'ok', text: t('agentExecution.saved') });
                    } catch { setAgentMsg({ type: 'err', text: t('agentExecution.failedToSave') }); }
                    setAgentSaving(false);
                  }}
                  className="px-3 py-1.5 text-xs bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-40"
                >
                  {agentSaving ? t('common:saving') : t('common:save')}
                </button>
              </div>
            </div>
            {agentMsg && <Msg type={agentMsg.type} text={agentMsg.text} />}
          </div>
        </Section>

        <Section title={t('cognitive.title')}>
          <div className="bg-surface-elevated rounded-xl p-5 space-y-4">
            <div className="text-xs text-fg-tertiary">{t('cognitive.description')}</div>

            {/* Enable toggle */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-fg-primary">{t('cognitive.enabled')}</div>
                <div className="text-xs text-fg-tertiary mt-0.5">{t('cognitive.enabledDesc')}</div>
              </div>
              <button
                onClick={() => { setCppEnabled(!cppEnabled); setCppMsg(null); }}
                className={`relative w-10 h-5 rounded-full transition-colors ${cppEnabled ? 'bg-brand-500' : 'bg-fg-quaternary'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${cppEnabled ? 'translate-x-5' : ''}`} />
              </button>
            </div>

            {/* Max Depth */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-fg-primary">{t('cognitive.maxDepth')}</div>
                <div className="text-xs text-fg-tertiary mt-0.5">{t('cognitive.maxDepthDesc')}</div>
              </div>
              <select
                value={cppMaxDepth}
                onChange={e => { setCppMaxDepth(Number(e.target.value)); setCppMsg(null); }}
                className="px-3 py-1.5 text-sm border border-border-default rounded-lg bg-surface-primary text-fg-primary"
              >
                <option value={1}>D1 — {t('cognitive.depthD1')}</option>
                <option value={2}>D2 — {t('cognitive.depthD2')}</option>
                <option value={3}>D3 — {t('cognitive.depthD3')}</option>
              </select>
            </div>

            {/* Save */}
            <div className="flex items-center justify-end gap-2">
              <button
                disabled={cppSaving}
                onClick={async () => {
                  setCppSaving(true); setCppMsg(null);
                  try {
                    const d = await api.settings.updateAgent({
                      cognitive: { enabled: cppEnabled, maxDepth: cppMaxDepth },
                    });
                    setCppEnabled(d.cognitive.enabled);
                    setCppMaxDepth(d.cognitive.maxDepth ?? 1);
                    setCppMsg({ type: 'ok', text: t('cognitive.saved') });
                  } catch { setCppMsg({ type: 'err', text: t('cognitive.failedToSave') }); }
                  setCppSaving(false);
                }}
                className="px-3 py-1.5 text-xs bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-40"
              >
                {cppSaving ? t('common:saving') : t('common:save')}
              </button>
            </div>
            {cppMsg && <Msg type={cppMsg.type} text={cppMsg.text} />}
          </div>
        </Section>
        </>}

        {resolvedTab === 'browser' && <>
        <Section title={t('browserAutomation.title')}>
          {/* ── Active Mode Banner ── */}
          <div className={`rounded-xl p-4 mb-4 flex items-start gap-3 ${browserExtensionConnected ? 'bg-green-500/10 border border-green-500/20' : browserRemotePort > 0 ? 'bg-blue-500/10 border border-blue-500/20' : browserAutoClickAllow ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-surface-elevated border border-border-default'}`}>
            <div className={`mt-0.5 w-2.5 h-2.5 rounded-full shrink-0 ${browserExtensionConnected ? 'bg-green-400' : browserRemotePort > 0 ? 'bg-blue-400' : browserAutoClickAllow ? 'bg-amber-400' : 'bg-gray-400'}`} />
            <div className="flex-1 min-w-0">
              <div className={`text-sm font-semibold ${browserExtensionConnected ? 'text-green-400' : browserRemotePort > 0 ? 'text-blue-400' : browserAutoClickAllow ? 'text-amber-400' : 'text-fg-secondary'}`}>
                {browserExtensionConnected
                  ? t('browserAutomation.modeExtension')
                  : browserRemotePort > 0
                    ? t('browserAutomation.modeDebuggingPort', { port: browserRemotePort })
                    : browserAutoClickAllow
                      ? t('browserAutomation.modeAutoClick')
                      : t('browserAutomation.modeManual')}
              </div>
              <div className="text-xs text-fg-tertiary mt-0.5">
                {browserExtensionConnected
                  ? t('browserAutomation.modeExtensionDesc')
                  : browserRemotePort > 0
                    ? t('browserAutomation.modeDebuggingPortDesc')
                    : browserAutoClickAllow
                      ? t('browserAutomation.modeAutoClickDesc')
                      : t('browserAutomation.modeManualDesc')}
              </div>
            </div>
          </div>

          {/* ── General Settings (always visible) ── */}
          <div className="bg-surface-elevated rounded-xl p-5 space-y-4 mb-4">
            <div className="text-xs font-medium text-fg-secondary uppercase tracking-wider">{t('browserAutomation.generalSettings')}</div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-fg-primary">{t('browserAutomation.bringToFront')}</div>
                <div className="text-xs text-fg-tertiary mt-0.5">{t('browserAutomation.bringToFrontDesc')}</div>
              </div>
              <button
                onClick={async () => {
                  const newVal = !browserBringToFront;
                  setBrowserBringToFront(newVal);
                  setBrowserSaving(true); setBrowserMsg(null);
                  try {
                    const d = await api.settings.updateBrowser({ bringToFront: newVal });
                    setBrowserBringToFront(d.bringToFront);
                    setBrowserMsg({ type: 'ok', text: newVal ? t('browserAutomation.tabsForeground') : t('browserAutomation.tabsBackground') });
                  } catch { setBrowserMsg({ type: 'err', text: t('agentExecution.failedToSave') }); setBrowserBringToFront(!newVal); }
                  setBrowserSaving(false);
                }}
                disabled={browserSaving}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${browserBringToFront ? 'bg-green-500' : 'bg-gray-600'} ${browserSaving ? 'opacity-50' : ''}`}
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${browserBringToFront ? 'translate-x-4' : 'translate-x-1'}`} />
              </button>
            </div>
            <div className="flex items-center justify-between border-t border-border-default pt-4">
              <div>
                <div className="text-sm font-medium text-fg-primary">{t('browserAutomation.autoCloseTabs')}</div>
                <div className="text-xs text-fg-tertiary mt-0.5">{t('browserAutomation.autoCloseTabsDesc')}</div>
              </div>
              <button
                onClick={async () => {
                  const newVal = !browserAutoClose;
                  setBrowserAutoClose(newVal);
                  setBrowserSaving(true); setBrowserMsg(null);
                  try {
                    const d = await api.settings.updateBrowser({ autoCloseTabs: newVal });
                    setBrowserAutoClose(d.autoCloseTabs);
                    setBrowserMsg({ type: 'ok', text: t('agentExecution.saved') });
                  } catch { setBrowserMsg({ type: 'err', text: t('agentExecution.failedToSave') }); setBrowserAutoClose(!newVal); }
                  setBrowserSaving(false);
                }}
                disabled={browserSaving}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${browserAutoClose ? 'bg-green-500' : 'bg-gray-600'} ${browserSaving ? 'opacity-50' : ''}`}
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${browserAutoClose ? 'translate-x-4' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>

          {/* ── Connection Mode: Chrome Extension ── */}
          <div className={`rounded-xl p-5 mb-4 transition-colors ${browserExtensionConnected ? 'bg-green-500/5 border border-green-500/20' : 'bg-surface-elevated'}`}>
            {/* Header row: title + status badge */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium text-fg-primary">{t('browserAutomation.extensionStatus')}</div>
                <span className="text-xs text-fg-tertiary">({t('browserAutomation.modeRecommended')})</span>
              </div>
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${browserExtensionConnected ? 'bg-green-500/20 text-green-400' : 'bg-gray-600/20 text-gray-400'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${browserExtensionConnected ? 'bg-green-400' : 'bg-gray-400'}`} />
                {browserExtensionConnected ? t('browserAutomation.extensionConnected') : t('browserAutomation.extensionDisconnected')}
              </span>
            </div>
            <div className="text-xs text-fg-tertiary">{t('browserAutomation.extensionStatusDesc')}</div>

            {browserExtensionConnected ? (
              <div className="mt-3 flex items-center gap-1.5 text-xs text-green-400">
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                {t('browserAutomation.extensionActiveNote')}
              </div>
            ) : (
              /* Step-by-step install guide */
              <div className="mt-4 space-y-3">
                <div className="text-xs font-medium text-fg-secondary uppercase tracking-wider">{t('browserAutomation.extensionSetupTitle')}</div>

                {/* Step 1: Download */}
                <div className="flex items-start gap-3 p-3 rounded-lg bg-surface-primary/50">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-brand-500 text-white text-[10px] font-bold shrink-0 mt-0.5">1</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-fg-primary">{t('browserAutomation.extensionStep1')}</div>
                    <div className="text-xs text-fg-tertiary mt-0.5">{t('browserAutomation.extensionStep1Desc')}</div>
                    <button
                      disabled={browserSaving}
                      onClick={async () => {
                        setBrowserSaving(true); setBrowserMsg(null);
                        try {
                          await api.settings.downloadExtensionZip();
                        } catch { setBrowserMsg({ type: 'err', text: t('browserAutomation.extensionDownloadError') }); }
                        setBrowserSaving(false);
                      }}
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-40"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                      {browserSaving ? t('browserAutomation.extensionStep1Downloading') : t('browserAutomation.extensionStep1Btn')}
                    </button>
                  </div>
                </div>

                {/* Step 2: Open extensions page */}
                <div className="flex items-start gap-3 p-3 rounded-lg bg-surface-primary/50">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-brand-500 text-white text-[10px] font-bold shrink-0 mt-0.5">2</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-fg-primary">{t('browserAutomation.extensionStep2')}</div>
                    <div className="text-xs text-fg-tertiary mt-0.5">{t('browserAutomation.extensionStep2Desc')}</div>
                    <button
                      disabled={browserSaving}
                      onClick={async () => {
                        setBrowserSaving(true); setBrowserMsg(null);
                        try {
                          await api.settings.openExtensionsPage();
                        } catch { setBrowserMsg({ type: 'err', text: t('browserAutomation.extensionOpenError') }); }
                        setBrowserSaving(false);
                      }}
                      className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-surface-primary border border-border-default text-fg-primary rounded-lg hover:bg-surface-elevated transition-colors disabled:opacity-40"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                      {t('browserAutomation.extensionStep2Btn')}
                    </button>
                  </div>
                </div>

                {/* Step 3: Load unpacked */}
                <div className="flex items-start gap-3 p-3 rounded-lg bg-surface-primary/50">
                  <span className="flex items-center justify-center w-5 h-5 rounded-full bg-brand-500 text-white text-[10px] font-bold shrink-0 mt-0.5">3</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-fg-primary">{t('browserAutomation.extensionStep3')}</div>
                    <div className="text-xs text-fg-tertiary mt-0.5">{t('browserAutomation.extensionStep3Desc')}</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ── Fallback modes (collapsed when extension is connected) ── */}
          {!browserExtensionConnected && (
            <div className="bg-surface-elevated rounded-xl p-5 space-y-4">
              <div className="text-xs font-medium text-fg-secondary uppercase tracking-wider">{t('browserAutomation.fallbackModes')}</div>

              {/* Auto-click Chrome Allow Dialog toggle */}
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex-1 mr-4">
                    <div className="text-sm font-medium text-fg-primary">{t('browserAutomation.autoClickAllowDialog')}</div>
                    <div className="text-xs text-fg-tertiary mt-0.5">{t('browserAutomation.autoClickAllowDialogDesc')}</div>
                    <div className="text-xs text-fg-tertiary mt-2 space-y-0.5">
                      <div>{t('browserAutomation.autoClickAllowDialogMacNote')}</div>
                      <div>{t('browserAutomation.autoClickAllowDialogWinNote')}</div>
                      <div>{t('browserAutomation.autoClickAllowDialogLinuxNote')}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      disabled={browserSaving}
                      onClick={async () => {
                        setBrowserSaving(true); setBrowserMsg(null);
                        try {
                          const result = await api.settings.testAutoClick();
                          const msgMap: Record<string, { type: 'ok' | 'err'; text: string }> = {
                            success: { type: 'ok', text: t('browserAutomation.autoClickTestSuccess', { title: result.pageTitle || 'example.com' }) },
                            no_permission: { type: 'err', text: t('browserAutomation.autoClickTestNoPermission') },
                            chrome_not_running: { type: 'err', text: t('browserAutomation.autoClickTestChromeNotRunning') },
                            unsupported: { type: 'err', text: t('browserAutomation.autoClickTestUnsupported') },
                            error: { type: 'err', text: t('browserAutomation.autoClickTestError', { error: result.error || 'unknown' }) },
                          };
                          setBrowserMsg(msgMap[result.clickResult] ?? { type: 'err', text: result.clickResult });
                        } catch { setBrowserMsg({ type: 'err', text: t('browserAutomation.autoClickTestError', { error: 'request failed' }) }); }
                        setBrowserSaving(false);
                      }}
                      className="px-3 py-1.5 text-xs bg-surface-primary border border-border-default text-fg-primary rounded-lg hover:bg-surface-elevated transition-colors disabled:opacity-40"
                    >
                      {browserSaving ? t('browserAutomation.autoClickTesting') : t('browserAutomation.autoClickTest')}
                    </button>
                    <button
                      onClick={async () => {
                        const newVal = !browserAutoClickAllow;
                        setBrowserAutoClickAllow(newVal);
                        setBrowserSaving(true); setBrowserMsg(null);
                        try {
                          const d = await api.settings.updateBrowser({ autoClickAllowDialog: newVal });
                          setBrowserAutoClickAllow(d.autoClickAllowDialog);
                          setBrowserMsg({ type: 'ok', text: t('agentExecution.saved') });
                        } catch { setBrowserMsg({ type: 'err', text: t('agentExecution.failedToSave') }); setBrowserAutoClickAllow(!newVal); }
                        setBrowserSaving(false);
                      }}
                      disabled={browserSaving}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${browserAutoClickAllow ? 'bg-green-500' : 'bg-gray-600'} ${browserSaving ? 'opacity-50' : ''}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${browserAutoClickAllow ? 'translate-x-4' : 'translate-x-1'}`} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Remote Debugging Port */}
              <div className="border-t border-border-default pt-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-fg-primary">{t('browserAutomation.remoteDebuggingPort')}</div>
                    <div className="text-xs text-fg-tertiary mt-0.5">
                      {t('browserAutomation.remoteDebuggingPortDescLead')}{' '}
                      <code className="text-fg-secondary bg-surface-primary px-1 rounded">--remote-debugging-port=9222</code>{' '}
                      {t('browserAutomation.remoteDebuggingPortDescTail')}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={65535}
                      value={browserRemotePort}
                      onChange={e => { setBrowserRemotePort(Number(e.target.value)); setBrowserMsg(null); }}
                      className="w-24 px-3 py-1.5 text-sm border border-border-default rounded-lg bg-surface-primary text-fg-primary text-right"
                      placeholder="0"
                    />
                    <button
                      disabled={browserSaving}
                      onClick={async () => {
                        setBrowserSaving(true); setBrowserMsg(null);
                        try {
                          const d = await api.settings.updateBrowser({ remoteDebuggingPort: browserRemotePort });
                          setBrowserRemotePort(d.remoteDebuggingPort);
                          setBrowserMsg({
                            type: 'ok',
                            text: d.remoteDebuggingPort > 0
                              ? t('browserAutomation.usingPort', { port: d.remoteDebuggingPort })
                              : t('browserAutomation.usingAutoConnect'),
                          });
                        } catch { setBrowserMsg({ type: 'err', text: t('agentExecution.failedToSave') }); }
                        setBrowserSaving(false);
                      }}
                      className="px-3 py-1.5 text-xs bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-40"
                    >
                      {browserSaving ? t('common:saving') : t('common:save')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {browserMsg && <div className="mt-4"><Msg type={browserMsg.type} text={browserMsg.text} /></div>}
        </Section>

        {/* DEV-only: Browser Integration Test Suite */}
        {import.meta.env.DEV && <BrowserTestPanel extensionConnected={browserExtensionConnected} />}
        </>}

        {resolvedTab === 'search' && <>
        <Section title={t('searchApi.title')}>
          <div className="bg-surface-elevated rounded-xl p-5 space-y-5">
            <div className="text-xs text-fg-tertiary">{t('searchApi.description')}</div>

            {([
              { id: 'serper' as const, label: t('searchApi.serper'), hint: t('searchApi.serperHint'), field: 'serperApiKey' as const },
              { id: 'tavily' as const, label: t('searchApi.tavily'), hint: t('searchApi.tavilyHint'), field: 'tavilyApiKey' as const },
              { id: 'bing' as const, label: t('searchApi.bing'), hint: t('searchApi.bingHint'), field: 'bingApiKey' as const },
              { id: 'google' as const, label: t('searchApi.google'), hint: t('searchApi.googleHint'), field: 'googleSearchApiKey' as const, extraField: 'googleSearchCx' as const, extraPlaceholder: t('searchApi.googleCxPlaceholder') },
              { id: 'serpapi' as const, label: t('searchApi.serpapi'), hint: t('searchApi.serpapiHint'), field: 'serpApiKey' as const },
              { id: 'brave' as const, label: t('searchApi.brave'), hint: t('searchApi.braveHint'), field: 'braveApiKey' as const },
              { id: 'exa' as const, label: t('searchApi.exa'), hint: t('searchApi.exaHint'), field: 'exaApiKey' as const },
              { id: 'bocha' as const, label: t('searchApi.bocha'), hint: t('searchApi.bochaHint'), field: 'bochaApiKey' as const },
            ] as Array<{ id: 'serper' | 'tavily' | 'bing' | 'google' | 'serpapi' | 'brave' | 'exa' | 'bocha'; label: string; hint: string; field: keyof typeof searchForm; extraField?: keyof typeof searchForm; extraPlaceholder?: string }>).map((item, idx) => (
              <div key={item.id} className={idx > 0 ? 'border-t border-border-default pt-4' : ''}>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="text-sm font-medium text-fg-primary">{item.label}</div>
                    <div className="text-xs text-fg-tertiary mt-0.5">{item.hint}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    {searchKeys?.[item.id]?.configured && (
                      <>
                        <span className="w-2 h-2 rounded-full bg-green-400" />
                        <span className="text-xs text-green-600">{t('searchApi.configured')}</span>
                        <code className="text-[10px] text-fg-tertiary">{searchKeys[item.id].preview}</code>
                      </>
                    )}
                    {searchKeys && !searchKeys[item.id]?.configured && (
                      <>
                        <span className="w-2 h-2 rounded-full bg-gray-500" />
                        <span className="text-xs text-fg-tertiary">{t('searchApi.notConfigured')}</span>
                      </>
                    )}
                  </div>
                </div>
                <input
                  type="password"
                  value={searchForm[item.field]}
                  onChange={e => setSearchForm({ ...searchForm, [item.field]: e.target.value })}
                  placeholder={searchKeys?.[item.id]?.configured ? t('modelProviders.apiKeyPlaceholder') : t('searchApi.apiKeyPlaceholder')}
                  className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none"
                />
                {item.extraField && (
                  <input
                    type="text"
                    value={searchForm[item.extraField]}
                    onChange={e => setSearchForm({ ...searchForm, [item.extraField!]: e.target.value })}
                    placeholder={item.extraPlaceholder ?? ''}
                    className="w-full mt-2 px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none"
                  />
                )}
              </div>
            ))}

            <div className="text-xs text-fg-tertiary italic">{t('searchApi.freeBackend')}</div>

            <div className="flex items-center justify-between pt-2 border-t border-border-default">
              {searchMsg && <Msg type={searchMsg.type} text={searchMsg.text} />}
              {!searchMsg && <div />}
              <button
                disabled={searchSaving || (!searchForm.serperApiKey && !searchForm.tavilyApiKey && !searchForm.bingApiKey && !searchForm.googleSearchApiKey && !searchForm.googleSearchCx && !searchForm.serpApiKey && !searchForm.braveApiKey && !searchForm.exaApiKey && !searchForm.bochaApiKey)}
                onClick={() => void saveSearchKeys()}
                className="px-4 py-1.5 text-xs bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-40"
              >
                {searchSaving ? t('common:saving') : t('common:save')}
              </button>
            </div>
          </div>
        </Section>
        </>}

        {resolvedTab === 'storage' && <>
        <Section title={t('dataStorage.title')}>
          <div className="bg-surface-elevated rounded-xl p-5 space-y-5">
            {storageLoading && !storageInfo && <div className="text-sm text-fg-tertiary">{t('dataStorage.scanning')}</div>}
            {storageInfo && (
              <>
                {/* Summary bar */}
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-lg font-semibold text-fg-primary">{formatBytes(storageInfo.totalSize, t)}</div>
                    <div className="text-xs text-fg-tertiary font-mono mt-0.5">{storageInfo.dataDir}</div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => loadStorage()} disabled={storageLoading}
                      className="px-3 py-1.5 text-xs border border-border-default hover:bg-surface-elevated rounded-lg text-fg-secondary transition-colors disabled:opacity-40">
                      {storageLoading ? t('dataStorage.scanning') : t('common:refresh')}
                    </button>
                    <button onClick={() => void api.system.openPath(storageInfo.dataDir)}
                      className="px-3 py-1.5 text-xs border border-border-default hover:bg-surface-elevated rounded-lg text-fg-secondary transition-colors">
                      {t('dataStorage.openInFinder')}
                    </button>
                  </div>
                </div>

                {/* Breakdown table */}
                <div className="border-t border-border-default pt-4">
                  <h4 className="text-xs font-semibold text-fg-secondary mb-3">{t('dataStorage.storageBreakdown')}</h4>
                  <div className="space-y-1.5">
                    {storageInfo.breakdown.filter(b => b.size > 0).map(item => (
                      <div key={item.name} className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-surface-elevated/40">
                        <div className="min-w-0">
                          <span className="text-sm text-fg-primary">{item.name}</span>
                          <span className="text-xs text-fg-tertiary ml-2">{item.description}</span>
                        </div>
                        <span className="text-sm font-medium text-fg-secondary tabular-nums shrink-0 ml-3">{formatBytes(item.size, t)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Per-agent storage */}
                {storageInfo.agents.length > 0 && (
                  <div className="border-t border-border-default pt-4">
                    <h4 className="text-xs font-semibold text-fg-secondary mb-3">{t('dataStorage.agentStorage', { count: storageInfo.agents.length })}</h4>
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
                              <span className="text-xs font-medium text-fg-secondary tabular-nums shrink-0 ml-3">{formatBytes(ag.size, t)}</span>
                            </div>
                            {expanded && (
                              <div className="px-3 pb-2 pt-0.5 space-y-0.5">
                                {ag.subItems.filter(s => s.size > 0).map(sub => (
                                  <div key={sub.name} className="flex items-center justify-between text-xs py-0.5 pl-5">
                                    <span className="text-fg-tertiary">{sub.name}</span>
                                    <span className="text-fg-secondary tabular-nums">{formatBytes(sub.size, t)}</span>
                                  </div>
                                ))}
                                <div className="pl-5 pt-1">
                                  <button onClick={() => void api.system.openPath(storageInfo.dataDir + '/agents/' + ag.id)}
                                    className="text-[10px] text-fg-tertiary hover:text-fg-secondary underline">{t('dataStorage.openFolder')}</button>
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
                  <OrphanSection orphanInfo={orphanInfo} dataDir={storageInfo.dataDir} onPurged={loadStorage} formatBytes={(n) => formatBytes(n, t)} />
                )}
              </>
            )}
          </div>
        </Section>

        </>}

        {resolvedTab === 'users' && <UserManagementSection authUser={authUser} />}

        {resolvedTab === 'remote' && <RemoteAccessSection />}

        </>
        )}

        <div className="h-8" />
      </div>}
      </div>
    </div>
  );
}

/* ─── User Management ─── */

const ROLE_OPTIONS = ['owner', 'admin', 'member', 'guest'] as const;
const ROLE_COLORS: Record<string, string> = {
  owner: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  admin: 'bg-brand-500/10 text-brand-500 border-brand-500/30',
  member: 'bg-green-500/10 text-green-600 border-green-500/30',
  guest: 'bg-gray-500/10 text-gray-500 border-gray-500/30',
};

function UserManagementSection({ authUser }: { authUser?: AuthUser }) {
  const { t } = useTranslation(['settings', 'common']);
  const [users, setUsers] = useState<HumanUserInfo[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [resetPwdId, setResetPwdId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const loadUsers = useCallback(() => {
    api.users.list(authUser?.orgId).then(d => setUsers(d.users)).catch(() => {});
  }, [authUser?.orgId]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const startEdit = (u: HumanUserInfo) => {
    setEditingId(u.id);
    setEditName(u.name);
    setEditRole(u.role);
    setEditEmail(u.email ?? '');
    setMsg(null);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    try {
      await api.users.update(editingId, { name: editName, role: editRole, email: editEmail || undefined });
      setEditingId(null);
      setMsg({ type: 'ok', text: t('settings:userManagement.updateSuccess') });
      loadUsers();
    } catch (e) {
      setMsg({ type: 'err', text: `${t('settings:userManagement.error')}: ${String(e)}` });
    }
  };

  const resetPassword = async () => {
    if (!resetPwdId || !newPassword) return;
    try {
      await api.users.resetPassword(resetPwdId, newPassword);
      setResetPwdId(null);
      setNewPassword('');
      setMsg({ type: 'ok', text: t('settings:userManagement.resetSuccess') });
    } catch (e) {
      setMsg({ type: 'err', text: `${t('settings:userManagement.error')}: ${String(e)}` });
    }
  };

  const deleteUser = async (userId: string) => {
    if (userId === authUser?.id) {
      setMsg({ type: 'err', text: t('settings:userManagement.cannotDeleteSelf') });
      setConfirmDeleteId(null);
      return;
    }
    const targetUser = users.find(u => u.id === userId);
    if (targetUser?.role === 'owner') {
      setMsg({ type: 'err', text: t('settings:userManagement.cannotDeleteOwner') });
      setConfirmDeleteId(null);
      return;
    }
    try {
      await api.users.remove(userId);
      setConfirmDeleteId(null);
      setMsg({ type: 'ok', text: t('settings:userManagement.deleteSuccess') });
      loadUsers();
    } catch (e) {
      setMsg({ type: 'err', text: `${t('settings:userManagement.error')}: ${String(e)}` });
    }
  };

  return (
    <Section title={t('settings:userManagement.title')}>
      <div className="bg-surface-elevated rounded-xl overflow-hidden">
        {msg && (
          <div className={`px-4 py-2 text-xs border-b ${msg.type === 'ok' ? 'bg-green-500/10 text-green-600 border-green-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20'}`}>
            {msg.text}
          </div>
        )}
        {inviteLink && (
          <div className="px-4 py-3 bg-brand-500/5 border-b border-brand-500/20 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[11px] text-fg-tertiary mb-1">{t('settings:userManagement.copyInviteLink')}</div>
              <code className="text-[10px] text-brand-500 bg-surface-elevated px-2 py-1 rounded block truncate">{inviteLink}</code>
            </div>
            <button onClick={() => { navigator.clipboard.writeText(inviteLink); setMsg({ type: 'ok', text: t('settings:userManagement.linkCopied') }); }}
              className="shrink-0 px-3 py-1.5 text-[11px] bg-brand-600 hover:bg-brand-500 text-white rounded-lg font-medium">{t('settings:userManagement.copy')}</button>
            <button onClick={() => setInviteLink(null)} className="shrink-0 text-fg-tertiary hover:text-fg-secondary text-sm">×</button>
          </div>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-default/60 text-fg-tertiary text-[11px] uppercase tracking-wider">
              <th className="text-left px-4 py-2.5 font-medium">{t('settings:userManagement.name')}</th>
              <th className="text-left px-4 py-2.5 font-medium">{t('settings:userManagement.email')}</th>
              <th className="text-left px-4 py-2.5 font-medium">{t('settings:userManagement.role')}</th>
              <th className="text-right px-4 py-2.5 font-medium">{t('settings:userManagement.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-fg-tertiary text-xs">{t('settings:userManagement.noUsers')}</td></tr>
            )}
            {users.map(u => {
              const isEditing = editingId === u.id;
              const isResetPwd = resetPwdId === u.id;
              const isConfirmDel = confirmDeleteId === u.id;
              const isSelf = u.id === authUser?.id;
              const isPrimaryOwner = u.role === 'owner';
              return (
                <tr key={u.id} className="border-b border-border-default/40 last:border-b-0 hover:bg-surface-elevated/40 transition-colors">
                  <td className="px-4 py-2.5">
                    {isEditing ? (
                      <input value={editName} onChange={e => setEditName(e.target.value)}
                        className="w-full px-2 py-1 text-xs bg-surface-primary border border-border-default rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500/50" />
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-fg-primary font-medium text-xs">{u.name}</span>
                        {isSelf && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-brand-500/10 text-brand-500">you</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {isEditing ? (
                      <input value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder="email@example.com"
                        className="w-full px-2 py-1 text-xs bg-surface-primary border border-border-default rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500/50" />
                    ) : (
                      <span className="text-fg-secondary text-xs">{u.email || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {isEditing ? (
                      <select value={editRole} onChange={e => setEditRole(e.target.value)}
                        className="px-2 py-1 text-xs bg-surface-primary border border-border-default rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500/50">
                        {ROLE_OPTIONS.map(r => (
                          <option key={r} value={r}>{t(`settings:userManagement.roles.${r}`)}</option>
                        ))}
                      </select>
                    ) : (
                      <span className={`inline-block text-[10px] px-2 py-0.5 rounded-full border font-medium ${ROLE_COLORS[u.role] ?? ''}`}>
                        {t(`settings:userManagement.roles.${u.role}`)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {isEditing ? (
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => setEditingId(null)} className="text-[11px] text-fg-tertiary hover:text-fg-secondary">{t('settings:userManagement.cancel')}</button>
                        <button onClick={saveEdit} className="text-[11px] text-brand-500 hover:text-brand-400 font-medium">{t('settings:userManagement.save')}</button>
                      </div>
                    ) : isResetPwd ? (
                      <div className="flex items-center justify-end gap-2">
                        <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                          placeholder={t('settings:userManagement.newPassword')} autoFocus
                          className="w-32 px-2 py-1 text-xs bg-surface-primary border border-border-default rounded-md focus:outline-none focus:ring-1 focus:ring-brand-500/50" />
                        <button onClick={() => { setResetPwdId(null); setNewPassword(''); }} className="text-[11px] text-fg-tertiary hover:text-fg-secondary">{t('settings:userManagement.cancel')}</button>
                        <button onClick={resetPassword} disabled={newPassword.length < 6} className="text-[11px] text-brand-500 hover:text-brand-400 font-medium disabled:opacity-40">{t('settings:userManagement.confirmReset')}</button>
                      </div>
                    ) : isConfirmDel ? (
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-[10px] text-red-500">{t('settings:userManagement.confirmDelete')}</span>
                        <button onClick={() => setConfirmDeleteId(null)} className="text-[11px] text-fg-tertiary hover:text-fg-secondary">{t('settings:userManagement.cancel')}</button>
                        <button onClick={() => deleteUser(u.id)} className="text-[11px] text-red-500 hover:text-red-400 font-medium">{t('settings:userManagement.deleteUser')}</button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1.5">
                        <button onClick={() => startEdit(u)} className="text-[11px] text-fg-tertiary hover:text-fg-secondary px-1.5 py-0.5 rounded hover:bg-surface-elevated">{t('settings:userManagement.editUser')}</button>
                        {u.email && (
                          <button onClick={() => { setResetPwdId(u.id); setNewPassword(''); setMsg(null); }} className="text-[11px] text-fg-tertiary hover:text-fg-secondary px-1.5 py-0.5 rounded hover:bg-surface-elevated">{t('settings:userManagement.resetPassword')}</button>
                        )}
                        {u.email && !isPrimaryOwner && !u.hasJoined && (
                          <button onClick={async () => {
                            try {
                              const { inviteToken } = await api.users.reinvite(u.id);
                              const link = `${window.location.origin}/#invite?token=${inviteToken}`;
                              setInviteLink(link);
                              setMsg({ type: 'ok', text: t('settings:userManagement.inviteLinkGenerated') });
                            } catch (e) { setMsg({ type: 'err', text: String(e) }); }
                          }} className="text-[11px] text-brand-400 hover:text-brand-500 px-1.5 py-0.5 rounded hover:bg-brand-500/10">{t('settings:userManagement.inviteLink')}</button>
                        )}
                        {!isPrimaryOwner && !isSelf && (
                          <button onClick={() => { setConfirmDeleteId(u.id); setMsg(null); }} className="text-[11px] text-red-400 hover:text-red-500 px-1.5 py-0.5 rounded hover:bg-red-500/10">{t('settings:userManagement.deleteUser')}</button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
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
    <div className={`rounded-xl p-4 space-y-3 transition-colors ${active ? 'ring-1 ring-brand-500/60 bg-brand-500/10' : 'bg-surface-elevated'}`}>
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

function formatBytes(bytes: number, t?: (key: string) => string): string {
  if (bytes === 0) return t ? t('dataStorage.bytesZero') : '0 B';
  const units = t ? [t('dataStorage.unitB'), t('dataStorage.unitKB'), t('dataStorage.unitMB'), t('dataStorage.unitGB')] : ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function OrphanSection({ orphanInfo, dataDir, onPurged, formatBytes: formatBytesLocal }: { orphanInfo: OrphanInfo; dataDir: string; onPurged: () => void; formatBytes: (n: number) => string }) {
  const { t } = useTranslation(['settings', 'common']);
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
      const base = t('dataStorage.cleaned', { count, size: formatBytesLocal(r.freedBytes) });
      setResult(r.failures.length ? t('dataStorage.cleanedWithFailureNote', { base, count: r.failures.length }) : base);
      setSelected(new Set());
      onPurged();
    } catch { setResult(t('dataStorage.cleanupFailed')); }
    finally { setPurging(false); }
  };

  return (
    <div className="border-t border-border-default pt-4">
      <h4 className="text-xs font-semibold text-amber-500 mb-2">{t('dataStorage.orphanedDirectories')}</h4>
      <p className="text-xs text-fg-tertiary mb-3">
        {t('dataStorage.orphanedDesc')}{' '}
        {t('dataStorage.orphanedTotal', { size: formatBytesLocal(orphanInfo.totalOrphanSize), count: allItems.length })}
      </p>

      {/* Select all */}
      <div className="flex items-center gap-2 mb-2 px-1">
        <label className="flex items-center gap-1.5 text-[10px] text-fg-tertiary cursor-pointer select-none">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} className="rounded" />
          {t('common:selectAll')}
        </label>
        {selected.size > 0 && (
          <span className="text-[10px] text-fg-secondary">{t('dataStorage.selectedWithSize', { count: selected.size, size: formatBytesLocal(selectedSize) })}</span>
        )}
      </div>

      {/* List */}
      <div className="space-y-0.5 mb-3 max-h-52 overflow-y-auto">
        {allItems.map(o => (
          <div key={o.id} className={`flex items-center gap-2 text-xs py-1.5 px-2 rounded transition-colors ${selected.has(o.id) ? 'bg-amber-500/10' : 'bg-surface-elevated/30 hover:bg-surface-elevated/50'}`}>
            <input type="checkbox" checked={selected.has(o.id)} onChange={() => toggle(o.id)} className="rounded shrink-0" />
            {o.kind === 'team' && <span className="text-[10px] text-fg-tertiary shrink-0">{t('dataStorage.teamKind')}</span>}
            <span className="text-fg-tertiary font-mono truncate min-w-0 flex-1">{o.id}</span>
            <span className="text-fg-secondary tabular-nums shrink-0">{formatBytesLocal(o.size)}</span>
            <button onClick={() => void api.system.openPath(o.path)}
              className="text-[10px] text-fg-tertiary hover:text-fg-secondary shrink-0 underline">
              {t('common:open')}
            </button>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 items-center flex-wrap">
        {selected.size > 0 && (
          <button disabled={purging} onClick={() => void doPurge([...selected])}
            className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-50">
            {purging ? t('dataStorage.cleaning') : t('dataStorage.cleanSelected', { size: formatBytesLocal(selectedSize) })}
          </button>
        )}
        <button disabled={purging} onClick={() => void doPurge()}
          className="px-3 py-1.5 text-xs border border-amber-600/50 hover:bg-amber-600/10 text-amber-500 rounded-lg transition-colors disabled:opacity-50">
          {purging ? t('dataStorage.cleaning') : t('dataStorage.cleanAll', { size: formatBytesLocal(orphanInfo.totalOrphanSize) })}
        </button>
      </div>
      {result && <div className="text-xs text-fg-tertiary mt-2">{result}</div>}
    </div>
  );
}

function EditProfileModal({ authUser, onClose, onSaved }: { authUser: AuthUser; onClose: () => void; onSaved: (u: AuthUser) => void }) {
  const { t } = useTranslation('common');
  const [name, setName] = useState(authUser.name || '');
  const [email, setEmail] = useState(authUser.email || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(authUser.avatarUrl);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError(t('profile.nameRequired')); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(t('profile.invalidEmail')); return; }
    setSaving(true); setError('');
    try {
      const { user } = await api.auth.updateProfile(name.trim(), email.trim());
      onSaved({ ...user, avatarUrl: avatarUrl ?? user.avatarUrl });
    } catch { setError(t('profile.failedToSave')); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <form onSubmit={submit} className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[400px] shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-5">{t('profile.editProfile')}</h3>
        <div className="flex justify-center mb-5">
          <AvatarUpload
            currentUrl={avatarUrl}
            name={name}
            size={72}
            targetType="user"
            targetId={authUser.id}
            onUploaded={url => setAvatarUrl(url)}
          />
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-fg-tertiary font-medium mb-1">{t('profile.name')}</label>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none" />
          </div>
          <div>
            <label className="block text-xs text-fg-tertiary font-medium mb-1">{t('profile.email')}</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none" />
          </div>
          {error && <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
        </div>
        <div className="flex justify-end gap-3 mt-5">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">{t('cancel')}</button>
          <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white rounded-lg">{saving ? t('saving') : t('save')}</button>
        </div>
      </form>
    </div>
  );
}

/* ─── Remote Access ─── */

function RemoteAccessSection() {
  const { t } = useTranslation(['settings', 'common']);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const hubUser = getHubUser();

  const loadStatus = useCallback(async () => {
    try {
      const s = await api.settings.getRemote();
      setStatus(s);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  useEffect(() => {
    return wsClient.on('remote:status', (event) => {
      const payload = event.payload as unknown as RemoteStatus | undefined;
      if (payload) {
        setStatus(payload);
        setToggling(false);
      }
    });
  }, []);

  const handleToggle = async () => {
    setToggling(true);
    setError(null);
    try {
      if (status?.enabled) {
        await api.settings.disableRemote();
        await loadStatus();
        setToggling(false);
      } else {
        if (!hubApi.isAuthenticated()) {
          await ensureHubAuth();
        }
        await api.settings.enableRemote();
      }
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setToggling(false);
    }
  };

  const handleLogin = async () => {
    try {
      await ensureHubAuth();
      await loadStatus();
    } catch { /* user cancelled */ }
  };

  const handleCopy = () => {
    if (!status?.remoteUrl) return;
    navigator.clipboard.writeText(status.remoteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isConnecting = toggling || (status?.enabled && !status?.connected && status?.state !== 'idle');
  const qrUrl = status?.remoteUrl ?? null;

  return (
    <Section title={t('settings:remoteAccess.title')}>
      <div className="space-y-4">
        <p className="text-sm text-content-secondary">
          {t('settings:remoteAccess.description')}
        </p>

        {/* Hub Auth Status */}
        {!hubApi.isAuthenticated() ? (
          <div className="flex items-center gap-3 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <svg className="w-5 h-5 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm text-amber-600 dark:text-amber-400">
              {t('settings:remoteAccess.loginRequired')}
            </span>
            <button
              onClick={handleLogin}
              className="ml-auto px-3 py-1.5 text-xs font-medium bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors"
            >
              {t('settings:remoteAccess.signIn')}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-content-secondary">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            {t('settings:remoteAccess.signedInAs')} <strong>{hubUser?.username ?? hubUser?.displayName}</strong>
          </div>
        )}

        {/* Toggle + Status */}
        {hubApi.isAuthenticated() && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={handleToggle}
                  disabled={toggling || loading}
                  className={`relative w-12 h-6 rounded-full transition-colors duration-200 ${
                    status?.enabled ? 'bg-brand-600' : 'bg-gray-300 dark:bg-gray-600'
                  } ${(toggling || loading) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <span className={`block w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200 ${
                    status?.enabled ? 'translate-x-6' : 'translate-x-0.5'
                  }`} />
                </button>
                <span className="text-sm font-medium">
                  {isConnecting
                    ? t('settings:remoteAccess.connecting')
                    : status?.enabled
                      ? t('settings:remoteAccess.enabled')
                      : t('settings:remoteAccess.disabled')}
                </span>
                {isConnecting && <Spinner />}
              </div>

              {status?.enabled && (
                <div className={`flex items-center gap-1.5 text-xs ${
                  status.connected
                    ? 'text-green-600 dark:text-green-400'
                    : (status.state === 'registering' || status.state === 'connecting')
                      ? 'text-blue-600 dark:text-blue-400'
                      : 'text-amber-600 dark:text-amber-400'
                }`}>
                  <span className={`w-2 h-2 rounded-full ${
                    status.connected
                      ? 'bg-green-500 animate-pulse'
                      : (status.state === 'registering' || status.state === 'connecting')
                        ? 'bg-blue-500 animate-pulse'
                        : 'bg-amber-500'
                  }`} />
                  {status.connected
                    ? t('settings:remoteAccess.connected')
                    : (status.state === 'registering')
                      ? t('settings:remoteAccess.registering')
                      : (status.state === 'connecting')
                        ? t('settings:remoteAccess.connecting')
                        : t('settings:remoteAccess.disconnected')}
                  {status.connected && status.peerCount > 0 && (
                    <> &middot; {t('settings:remoteAccess.peerCount', { count: status.peerCount })}</>
                  )}
                  {(status.state === 'registering' || status.state === 'connecting') && <Spinner />}
                </div>
              )}
            </div>

            {error && (
              <div className="p-2 rounded-lg bg-red-500/10 text-red-500 text-sm">{error}</div>
            )}

            {/* Connected Peers List */}
            {status?.enabled && status.peers && status.peers.length > 0 && (
              <div className="p-4 rounded-lg bg-surface-elevated border border-border-default space-y-2">
                <label className="text-xs text-content-tertiary uppercase tracking-wider">
                  {t('settings:remoteAccess.connectedPeers')}
                </label>
                <div className="space-y-2 mt-1">
                  {status.peers.map((peer) => (
                    <div key={peer.peerId} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-surface-inset">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${
                        peer.transport === 'p2p' ? 'bg-green-500' : peer.transport === 'relay' ? 'bg-blue-500' : 'bg-amber-500 animate-pulse'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-mono text-content-primary truncate">
                          {peer.peerId.slice(0, 8)}...
                        </div>
                        <div className="text-xs text-content-tertiary">
                          {t('settings:remoteAccess.connectedSince', { time: new Date(peer.connectedAt).toLocaleTimeString() })}
                        </div>
                      </div>
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                        peer.transport === 'p2p'
                          ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                          : peer.transport === 'relay'
                            ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      }`}>
                        {peer.transport === 'p2p' ? 'P2P' : peer.transport === 'relay' ? 'Relay' : t('settings:remoteAccess.peerConnecting')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Remote URL + QR Code */}
            {status?.enabled && status.remoteUrl && (
              <div className="p-4 rounded-lg bg-surface-elevated border border-border-default space-y-3">
                <div>
                  <label className="text-xs text-content-tertiary uppercase tracking-wider">
                    {t('settings:remoteAccess.url')}
                  </label>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="flex-1 px-3 py-1.5 text-sm bg-surface-inset rounded font-mono truncate">
                      {status.remoteUrl}
                    </code>
                    <button
                      onClick={handleCopy}
                      className={`px-2 py-1.5 text-xs border rounded transition-colors ${
                        copied
                          ? 'border-green-500 text-green-600 dark:text-green-400'
                          : 'border-border-default hover:bg-surface-elevated'
                      }`}
                    >
                      {copied ? t('settings:remoteAccess.copied') : t('settings:remoteAccess.copy')}
                    </button>
                  </div>
                </div>

                {qrUrl && (
                  <div>
                    <label className="text-xs text-content-tertiary uppercase tracking-wider">
                      {t('settings:remoteAccess.qrCode')}
                    </label>
                    <p className="text-xs text-content-secondary mt-0.5 mb-2">
                      {t('settings:remoteAccess.scanQr')}
                    </p>
                    <QRCode url={qrUrl} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin text-content-secondary" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function QRCode({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setError(false);

    import('qrcode').then((QRLib) => {
      QRLib.toCanvas(canvas, url, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      });
    }).catch(() => setError(true));
  }, [url]);

  if (error) {
    return (
      <a href={url} target="_blank" rel="noopener" className="text-sm text-brand-500 underline">{url}</a>
    );
  }

  return (
    <div className="inline-block p-2 bg-white rounded-lg">
      <canvas ref={canvasRef} className="block" style={{ width: 160, height: 160 }} />
    </div>
  );
}
