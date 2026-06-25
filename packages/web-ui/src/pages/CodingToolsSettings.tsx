import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type CodingToolDetection, type CodingToolName, type CodingToolModelDTO, type CodingToolsSettingsResponse } from '../api.ts';

const TOOL_ORDER: CodingToolName[] = ['claude-code', 'codex', 'cursor-agent'];

const DEFAULT_TIMEOUT_MIN = 10;

interface ToolFormState {
  enabled: boolean;
  binaryPath: string;
  defaultArgs: string;
  timeoutMin: string;
  defaultModel: string;
  maxBudgetPerSessionUsd: string;
  approvalRequired: boolean;
}

function buildFormFromSettings(data: CodingToolsSettingsResponse): Record<CodingToolName, ToolFormState> {
  const form = {} as Record<CodingToolName, ToolFormState>;
  for (const name of TOOL_ORDER) {
    const cfg = data.tools[name];
    const ms = cfg?.timeoutMs ?? DEFAULT_TIMEOUT_MIN * 60_000;
    form[name] = {
      enabled: cfg?.enabled ?? true,
      binaryPath: cfg?.binaryPath ?? '',
      defaultArgs: (cfg?.defaultArgs ?? []).join(' '),
      timeoutMin: String(Math.round(ms / 60_000)),
      defaultModel: (cfg as any)?.defaultModel ?? '',
      maxBudgetPerSessionUsd: (cfg as any)?.maxBudgetPerSessionUsd ? String((cfg as any).maxBudgetPerSessionUsd) : '',
      approvalRequired: (cfg as any)?.approvalRequired ?? false,
    };
  }
  return form;
}

// ─── Primitives ──────────────────────────────────────────────────────────────

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? 'bg-green-500' : 'bg-gray-600'} ${disabled ? 'opacity-50' : ''}`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  );
}

function Msg({ type, text }: { type: 'ok' | 'err'; text: string }) {
  return (
    <div className={`text-xs px-3 py-2 rounded-lg ${type === 'ok' ? 'bg-green-500/10 text-green-600 border border-green-500/30' : 'bg-red-500/10 text-red-500 border border-red-500/30'}`}>
      {text}
    </div>
  );
}

function Spinner({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-medium text-fg-tertiary uppercase tracking-wider">{children}</div>;
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg className={`w-4 h-4 text-fg-tertiary transition-transform ${expanded ? 'rotate-90' : ''}`} viewBox="0 0 20 20" fill="currentColor">
      <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
    </svg>
  );
}

// ─── Status ──────────────────────────────────────────────────────────────────

function StatusBadge({ info }: { info?: CodingToolDetection }) {
  const { t } = useTranslation('settings');
  const ready = info?.available && info?.authenticated;
  const installed = info?.available;
  const label = ready ? t('codingTools.ready')
    : installed ? t('codingTools.needsAuth')
    : t('codingTools.notInstalled');
  const colorCls = ready
    ? 'bg-green-500/15 text-green-500'
    : installed ? 'bg-amber-500/15 text-amber-500'
    : 'bg-gray-600/20 text-fg-tertiary';
  const dotCls = ready ? 'bg-green-400' : installed ? 'bg-amber-400' : 'bg-gray-500';
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium ${colorCls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotCls}`} />
      {label}
    </span>
  );
}

// ─── Auth Actions ────────────────────────────────────────────────────────────

const CLI_LOGIN_TOOLS = new Set<CodingToolName>(['cursor-agent', 'claude-code']);
const API_KEY_LABELS: Partial<Record<CodingToolName, string>> = {
  'cursor-agent': 'CURSOR_API_KEY',
  'claude-code': 'ANTHROPIC_API_KEY',
  codex: 'CODEX_API_KEY',
};

const AUTH_POLL_INTERVAL = 15_000;
const AUTH_POLL_MAX_ATTEMPTS = 12;

function AuthActions({ name, onAuthDone }: { name: CodingToolName; onAuthDone: () => void }) {
  const { t } = useTranslation(['settings', 'common']);
  const [mode, setMode] = useState<'idle' | 'login' | 'key'>('idle');
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptsRef = useRef(0);
  const supportsCliLogin = CLI_LOGIN_TOOLS.has(name);
  const envVar = API_KEY_LABELS[name] ?? '';

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    attemptsRef.current = 0;
    setPolling(false);
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startAuthPolling = useCallback(() => {
    stopPolling();
    attemptsRef.current = 0;
    setPolling(true);
    pollRef.current = setInterval(async () => {
      attemptsRef.current++;
      try {
        const tool = await api.settings.detectCodingTool(name);
        if (tool?.authenticated) {
          stopPolling();
          setResult({ ok: true, text: t('codingTools.authSuccess') });
          setBusy(false);
          onAuthDone();
        }
      } catch { /* ignore polling errors */ }
      if (attemptsRef.current >= AUTH_POLL_MAX_ATTEMPTS) {
        stopPolling();
        setBusy(false);
        setResult({ ok: false, text: t('codingTools.authPollTimeout') });
      }
    }, AUTH_POLL_INTERVAL);
  }, [name, onAuthDone, stopPolling, t]);

  const doCliLogin = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await api.settings.authCodingTool(name, 'cli_login');
      if (res.success && res.authenticated) {
        setResult({ ok: true, text: t('codingTools.authSuccess') });
        onAuthDone();
        setBusy(false);
      } else if (res.success) {
        setResult({ ok: false, text: t('codingTools.authBrowserHint') });
        startAuthPolling();
      } else {
        setResult({ ok: false, text: res.error ?? t('codingTools.authFailed') });
        setBusy(false);
      }
    } catch {
      setResult({ ok: false, text: t('codingTools.authFailed') });
      setBusy(false);
    }
  };

  const doApiKey = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await api.settings.authCodingTool(name, 'api_key', apiKey.trim());
      if (res.success) {
        setResult({ ok: true, text: t('codingTools.apiKeySaved', { envVar: res.envVar ?? envVar }) });
        setApiKey('');
        onAuthDone();
      } else {
        setResult({ ok: false, text: t('codingTools.authFailed') });
      }
    } catch {
      setResult({ ok: false, text: t('codingTools.authFailed') });
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'idle') {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        {supportsCliLogin && (
          <button
            type="button"
            onClick={() => { setMode('login'); void doCliLogin(); }}
            className="px-2.5 py-1 text-[10px] font-medium bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors"
          >
            {t('codingTools.loginBtn')}
          </button>
        )}
        <button
          type="button"
          onClick={() => setMode('key')}
          className="px-2.5 py-1 text-[10px] font-medium border border-border-default text-fg-secondary rounded-md hover:text-fg-primary hover:border-gray-600 transition-colors"
        >
          {t('codingTools.apiKeyBtn')}
        </button>
      </div>
    );
  }

  if (mode === 'login') {
    return (
      <div className="space-y-1.5">
        {(busy || polling) && (
          <div className="flex items-center gap-2 text-[10px] text-brand-500">
            <Spinner />
            <span>{polling ? t('codingTools.authPolling') : t('codingTools.loginWaiting')}</span>
          </div>
        )}
        {result && <Msg type={result.ok ? 'ok' : 'err'} text={result.text} />}
        {!busy && !polling && (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => { setResult(null); onAuthDone(); }}
              className="px-2.5 py-1 text-[10px] font-medium bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors"
            >
              {t('codingTools.recheckAuth')}
            </button>
            <button type="button" onClick={() => { setMode('idle'); setResult(null); stopPolling(); }} className="text-[10px] text-fg-tertiary hover:text-fg-secondary">
              {t('common:cancel')}
            </button>
          </div>
        )}
        {polling && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { stopPolling(); setBusy(false); setResult(null); onAuthDone(); }}
              className="px-2.5 py-1 text-[10px] font-medium bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors"
            >
              {t('codingTools.recheckAuth')}
            </button>
            <button type="button" onClick={() => { stopPolling(); setBusy(false); setResult(null); setMode('idle'); }} className="text-[10px] text-fg-tertiary hover:text-fg-secondary">
              {t('common:cancel')}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {name === 'cursor-agent' && (
        <div className="text-[10px] text-fg-tertiary">
          {t('codingTools.cursorApiKeyNote')}{' '}
          <a href={t('codingTools.cursorDashboardUrl')} target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:underline">↗</a>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder={envVar}
          className="flex-1 px-2.5 py-1 text-[10px] bg-surface-primary border border-border-default rounded-md text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none font-mono min-w-0"
          onKeyDown={e => { if (e.key === 'Enter') void doApiKey(); }}
        />
        <button
          type="button"
          onClick={() => void doApiKey()}
          disabled={busy || !apiKey.trim()}
          className="px-2.5 py-1 text-[10px] font-medium bg-brand-500 text-white rounded-md hover:bg-brand-600 transition-colors disabled:opacity-40 shrink-0"
        >
          {busy ? '...' : t('common:save')}
        </button>
        <button type="button" onClick={() => { setMode('idle'); setResult(null); setApiKey(''); }} className="text-[10px] text-fg-tertiary hover:text-fg-secondary shrink-0">
          {t('common:cancel')}
        </button>
      </div>
      {result && <Msg type={result.ok ? 'ok' : 'err'} text={result.text} />}
    </div>
  );
}

// ─── Model Combobox ──────────────────────────────────────────────────────────

function ModelSourceBadge({ source }: { source?: string }) {
  const { t } = useTranslation('settings');
  if (!source) return null;
  const label = source === 'api' ? t('codingTools.modelSourceApi')
    : source === 'static' ? t('codingTools.modelSourceStatic')
    : t('codingTools.modelSourceCli');
  const colorCls = source === 'api' ? 'bg-green-500/15 text-green-500'
    : source === 'static' ? 'bg-blue-500/15 text-blue-400'
    : 'bg-amber-500/15 text-amber-500';
  return <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${colorCls}`}>{label}</span>;
}

function ModelCombobox({ name, value, onChange }: { name: CodingToolName; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation('settings');
  const [models, setModels] = useState<CodingToolModelDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<string | undefined>();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const fetchedRef = useRef(false);

  const fetchModels = useCallback(async (force = false) => {
    if (fetchedRef.current && !force) return;
    fetchedRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const res = await api.settings.listCodingToolModels(name);
      const list = res.models ?? [];
      setModels(list);
      setSource(res.source);
      if (list.length === 0) setError(t('codingTools.modelsEmpty'));
    } catch {
      setError(t('codingTools.modelsFetchError'));
    }
    setLoading(false);
  }, [name, t]);

  useEffect(() => { void fetchModels(); }, [fetchModels]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filtered = models.filter(m =>
    !search || m.id.toLowerCase().includes(search.toLowerCase()) || m.name.toLowerCase().includes(search.toLowerCase()),
  );

  const modelGuidanceKey = name === 'cursor-agent'
    ? 'codingTools.modelGuidanceCursor'
    : name === 'claude-code'
    ? 'codingTools.modelGuidanceClaude'
    : name === 'codex'
    ? 'codingTools.modelGuidanceCodex'
    : null;

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={open ? search : value}
          onChange={e => { setSearch(e.target.value); onChange(e.target.value); }}
          onFocus={() => { setOpen(true); setSearch(value); }}
          placeholder={t('codingTools.modelPlaceholder')}
          className="flex-1 px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none font-mono"
        />
        {!loading && source && <ModelSourceBadge source={source} />}
        {loading && <Spinner className="w-3.5 h-3.5 text-fg-tertiary shrink-0" />}
        {!loading && error && (
          <button
            type="button"
            onClick={() => { fetchedRef.current = false; void fetchModels(true); }}
            title={t('codingTools.modelsRetry')}
            className="text-[10px] text-amber-500 hover:text-amber-400 shrink-0"
          >
            ↻
          </button>
        )}
      </div>
      {error && !loading && <div className="text-[10px] text-amber-500 mt-0.5">{error}</div>}
      {modelGuidanceKey && !loading && (
        <div className="text-[10px] mt-1 text-fg-tertiary">
          {t(modelGuidanceKey)}
        </div>
      )}
      {open && (
        <div className="absolute z-50 mt-1 w-full bg-surface-secondary border border-border-default rounded-lg shadow-xl max-h-48 overflow-y-auto">
          {loading ? (
            <div className="px-3 py-2 text-[10px] text-fg-tertiary flex items-center gap-2">
              <Spinner />
              {t('codingTools.modelsLoading')}
            </div>
          ) : filtered.length === 0 && !search ? (
            <div className="px-3 py-2 text-[10px] text-fg-tertiary">{t('codingTools.noModelsFound')}</div>
          ) : (
            <>
              {value && (
                <button
                  type="button"
                  onClick={() => { onChange(''); setSearch(''); setOpen(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-elevated transition-colors italic"
                >
                  {t('codingTools.useToolDefault')}
                </button>
              )}
              {filtered.map(m => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { onChange(m.id); setSearch(m.id); setOpen(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-elevated transition-colors ${m.id === value ? 'bg-brand-500/10 text-brand-500' : 'text-fg-primary'}`}
                >
                  <span className="font-mono">{m.id}</span>
                  {m.name !== m.id && <span className="text-fg-tertiary ml-2">{m.name}</span>}
                  {m.isDefault && <span className="text-[9px] text-fg-tertiary ml-1.5 bg-surface-primary px-1.5 py-0.5 rounded">default</span>}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Cache ───────────────────────────────────────────────────────────────────

type PerToolDetectionState = { status: 'idle' } | { status: 'loading' } | { status: 'done'; data: CodingToolDetection };

const DETECT_CACHE_KEY = 'markus_coding_tool_detect';
const DETECT_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface DetectCacheEntry { data: CodingToolDetection; ts: number }

function loadCachedDetection(): Record<CodingToolName, PerToolDetectionState> {
  const fallback: Record<CodingToolName, PerToolDetectionState> = {
    'claude-code': { status: 'idle' },
    'codex': { status: 'idle' },
    'cursor-agent': { status: 'idle' },
  };
  try {
    const raw = localStorage.getItem(DETECT_CACHE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, DetectCacheEntry | CodingToolDetection>;
    const result = { ...fallback };
    for (const name of TOOL_ORDER) {
      const entry = parsed[name];
      if (!entry) continue;
      const data = 'data' in entry && 'ts' in entry ? (entry as DetectCacheEntry).data : entry as CodingToolDetection;
      result[name] = { status: 'done', data };
    }
    return result;
  } catch { return fallback; }
}

function hasCachedData(name: CodingToolName): boolean {
  try {
    const raw = localStorage.getItem(DETECT_CACHE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Record<string, DetectCacheEntry | CodingToolDetection>;
    return !!parsed[name];
  } catch { return false; }
}

function isCacheStale(name: CodingToolName): boolean {
  try {
    const raw = localStorage.getItem(DETECT_CACHE_KEY);
    if (!raw) return true;
    const parsed = JSON.parse(raw) as Record<string, DetectCacheEntry | CodingToolDetection>;
    const entry = parsed[name];
    if (!entry) return true;
    if ('ts' in entry && typeof (entry as DetectCacheEntry).ts === 'number') {
      return Date.now() - (entry as DetectCacheEntry).ts > DETECT_CACHE_MAX_AGE_MS;
    }
    return true;
  } catch { return true; }
}

function saveCachedDetection(state: Record<CodingToolName, PerToolDetectionState>) {
  try {
    const cache: Record<string, DetectCacheEntry> = {};
    const now = Date.now();
    for (const name of TOOL_ORDER) {
      const s = state[name];
      if (s.status === 'done') cache[name] = { data: s.data, ts: now };
    }
    localStorage.setItem(DETECT_CACHE_KEY, JSON.stringify(cache));
  } catch { /* ignore */ }
}

// ─── Build / Payload ─────────────────────────────────────────────────────────

const AUTO_SAVE_DELAY = 800;

function buildPayload(globalEnabled: boolean, toolForms: Record<CodingToolName, ToolFormState>) {
  const tools: CodingToolsSettingsResponse['tools'] = {} as CodingToolsSettingsResponse['tools'];
  for (const name of TOOL_ORDER) {
    const form = toolForms[name];
    const args = form.defaultArgs.trim()
      ? form.defaultArgs.trim().split(/\s+/).filter(Boolean)
      : undefined;
    const minutes = parseFloat(form.timeoutMin);
    const timeoutMs = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60_000) : DEFAULT_TIMEOUT_MIN * 60_000;
    const budgetVal = parseFloat(form.maxBudgetPerSessionUsd);
    tools[name] = {
      tool: name,
      enabled: form.enabled,
      binaryPath: form.binaryPath.trim() || undefined,
      defaultArgs: args,
      timeoutMs,
      defaultModel: form.defaultModel.trim() || undefined,
      maxBudgetPerSessionUsd: name === 'claude-code' && Number.isFinite(budgetVal) && budgetVal > 0 ? budgetVal : undefined,
      approvalRequired: form.approvalRequired || undefined,
    };
  }
  return { enabled: globalEnabled, tools };
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function CodingToolsSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [globalEnabled, setGlobalEnabled] = useState(false);
  const [perToolDetection, setPerToolDetection] = useState<Record<CodingToolName, PerToolDetectionState>>(loadCachedDetection);
  const [toolForms, setToolForms] = useState<Record<CodingToolName, ToolFormState>>(() =>
    buildFormFromSettings({ enabled: false, tools: {} as CodingToolsSettingsResponse['tools'] }),
  );
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<CodingToolName>>(new Set());
  const [testingTool, setTestingTool] = useState<CodingToolName | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { success: boolean; detail: string } | null>>({});

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initializedRef = useRef(false);

  const detectTool = useCallback(async (name: CodingToolName, silent = false) => {
    if (!silent) {
      setPerToolDetection(prev => ({ ...prev, [name]: { status: 'loading' } }));
    }
    try {
      const data = await api.settings.detectCodingTool(name);
      setPerToolDetection(prev => {
        const next = { ...prev, [name]: { status: 'done' as const, data } };
        saveCachedDetection(next);
        return next;
      });
    } catch {
      if (!silent) {
        setPerToolDetection(prev => ({ ...prev, [name]: { status: 'idle' } }));
      }
    }
  }, []);

  const runTest = useCallback(async (name: CodingToolName) => {
    setTestingTool(name);
    setTestResult(prev => ({ ...prev, [name]: null }));
    try {
      const res = await api.settings.testCodingTool(name);
      let detail: string;
      if (res.success) {
        const parts: string[] = [t('codingTools.testSuccess')];
        if (res.model) parts.push(t('codingTools.testModel', { model: res.model }));
        if (res.apiKeySource && !res.apiKeySource.includes('@')) {
          parts.push(t('codingTools.testAuthVia', { source: res.apiKeySource }));
        } else if (res.apiKeySource?.includes('@')) {
          parts.push(res.apiKeySource);
        }
        detail = parts.join(' · ');
      } else {
        detail = res.error
          ? `${t('codingTools.testFailed')}：${res.error}`
          : t('codingTools.testFailed');
      }
      setTestResult(prev => ({ ...prev, [name]: { success: res.success, detail } }));
      if (res.success) {
        setPerToolDetection(prev => {
          const existing = prev[name];
          if (existing.status === 'done' && !existing.data.authenticated) {
            const updated = { ...prev, [name]: { status: 'done' as const, data: { ...existing.data, authenticated: true } } };
            saveCachedDetection(updated);
            return updated;
          }
          return prev;
        });
      }
    } catch (err) {
      setTestResult(prev => ({ ...prev, [name]: { success: false, detail: t('codingTools.testFailed') } }));
    } finally {
      setTestingTool(null);
    }
  }, [t]);

  const toggleExpanded = useCallback((name: CodingToolName) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      if (next.has(name)) {
        const state = perToolDetection[name];
        if (state.status === 'idle') {
          void detectTool(name);
        }
      }
      return next;
    });
  }, [perToolDetection, detectTool]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const settings = await api.settings.getCodingTools();
      setGlobalEnabled(settings.enabled);
      setToolForms(buildFormFromSettings(settings));
      initializedRef.current = true;

      if (settings.enabled) {
        for (const name of TOOL_ORDER) {
          const toolCfg = settings.tools[name];
          if (toolCfg?.enabled && isCacheStale(name)) {
            void detectTool(name, hasCachedData(name));
          }
        }
      }
    } catch {
      setMsg({ type: 'err', text: t('codingTools.failedToLoad') });
    } finally {
      setLoading(false);
    }
  }, [t, detectTool]);

  useEffect(() => { void loadAll(); }, [loadAll]);

  useEffect(() => {
    if (!initializedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setMsg(null);
      try {
        await api.settings.updateCodingTools(buildPayload(globalEnabled, toolForms));
        setMsg({ type: 'ok', text: t('codingTools.saved') });
      } catch {
        setMsg({ type: 'err', text: t('codingTools.failedToSave') });
      }
    }, AUTO_SAVE_DELAY);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [globalEnabled, toolForms, t]);

  const refreshDetection = async () => {
    setDetecting(true);
    setMsg(null);
    try {
      const detected = await api.settings.detectCodingTools();
      const newState: Record<CodingToolName, PerToolDetectionState> = {
        'claude-code': { status: 'idle' },
        'codex': { status: 'idle' },
        'cursor-agent': { status: 'idle' },
      };
      for (const d of detected.tools) {
        newState[d.name as CodingToolName] = { status: 'done', data: d };
      }
      setPerToolDetection(newState);
      saveCachedDetection(newState);
    } catch {
      setMsg({ type: 'err', text: t('codingTools.detectionFailed') });
    } finally {
      setDetecting(false);
    }
  };

  const updateTool = (name: CodingToolName, patch: Partial<ToolFormState>) => {
    setToolForms(prev => ({ ...prev, [name]: { ...prev[name], ...patch } }));
  };

  const getDetection = (name: CodingToolName): CodingToolDetection | undefined => {
    const state = perToolDetection[name];
    return state.status === 'done' ? state.data : undefined;
  };

  const isDetectingTool = (name: CodingToolName) => perToolDetection[name].status === 'loading';

  return (
    <section>
      <h3 className="text-sm font-semibold text-fg-secondary uppercase tracking-wider mb-4">
        {t('codingTools.title')}
      </h3>

      <div className="space-y-3">
        <div className="text-xs text-fg-tertiary">{t('codingTools.description')}</div>

        {/* Global enable */}
        <div className="bg-surface-elevated rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-fg-primary">{t('codingTools.globalEnable')}</div>
              <div className="text-xs text-fg-tertiary mt-0.5">{t('codingTools.globalEnableDesc')}</div>
            </div>
            <Toggle checked={globalEnabled} onChange={() => setGlobalEnabled(v => !v)} disabled={loading} />
          </div>
        </div>

        {loading ? (
          <div className="text-sm text-fg-tertiary py-8 text-center">{t('common:loading')}</div>
        ) : (
          TOOL_ORDER.map(name => {
            const info = getDetection(name);
            const form = toolForms[name];
            const toolDetecting = isDetectingTool(name);
            const DISPLAY_NAMES: Record<CodingToolName, string> = { 'claude-code': 'Claude Code', 'codex': 'Codex', 'cursor-agent': 'Cursor Agent' };
            const displayName = info?.displayName ?? DISPLAY_NAMES[name] ?? name;
            const isExpanded = expanded.has(name);
            const needsSetup = info && !info.available;
            const needsAuth = info?.available && !info?.authenticated;
            const showBinaryPath = info ? !info.available : false;

            return (
              <div key={name} className="bg-surface-elevated rounded-xl overflow-hidden">
                {/* Collapsed header */}
                <button
                  type="button"
                  onClick={() => toggleExpanded(name)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02] transition-colors text-left"
                >
                  <ChevronIcon expanded={isExpanded} />
                  <div className="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                    <span className="text-sm font-medium text-fg-primary">{displayName}</span>
                    {toolDetecting ? (
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-600/20 text-fg-tertiary">
                        <Spinner />
                        {t('codingTools.detectingTool')}
                      </span>
                    ) : (
                      <StatusBadge info={info} />
                    )}
                    {info?.version && (
                      <span className="text-[10px] text-fg-tertiary font-mono truncate">{info.version}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                    <Toggle checked={form.enabled} onChange={() => updateTool(name, { enabled: !form.enabled })} />
                  </div>
                </button>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-border-default">
                    {info?.path && (
                      <div className="text-[10px] text-fg-tertiary font-mono mt-3 truncate" title={info.path}>
                        {info.path}
                      </div>
                    )}

                    {/* ── Setup: not installed ── */}
                    {needsSetup && info && (
                      <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg">
                        <div className="text-xs text-amber-500 font-medium mb-1">{t('codingTools.stepInstall')}</div>
                        {info.installHint && (
                          <code className="text-[10px] bg-surface-primary px-2 py-1 rounded block text-fg-secondary">{info.installHint}</code>
                        )}
                      </div>
                    )}

                    {/* ── Setup: needs auth ── */}
                    {needsAuth && (
                      <div className="mt-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-lg">
                        <div className="text-xs text-amber-500 font-medium mb-2">{t('codingTools.stepAuth')}</div>
                        <div className="text-[10px] text-fg-tertiary mb-2">{t('codingTools.authHint')}</div>
                        <AuthActions name={name} onAuthDone={() => void detectTool(name)} />
                      </div>
                    )}

                    {/* ── Config fields ── */}
                    <div className="grid gap-4 mt-4">

                      {showBinaryPath && (
                        <div>
                          <label className="text-xs text-fg-secondary block mb-1">{t('codingTools.binaryPath')}</label>
                          <input
                            type="text"
                            value={form.binaryPath}
                            onChange={e => updateTool(name, { binaryPath: e.target.value })}
                            placeholder={t('codingTools.binaryPathPlaceholder')}
                            className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none font-mono"
                          />
                        </div>
                      )}

                      {/* ── Section: Model & Execution ── */}
                      <SectionLabel>{t('codingTools.sectionModelExec')}</SectionLabel>

                      <div>
                        <label className="text-xs text-fg-secondary block mb-1">{t('codingTools.defaultModel')}</label>
                        <ModelCombobox
                          name={name}
                          value={form.defaultModel}
                          onChange={v => updateTool(name, { defaultModel: v })}
                        />
                        <div className="text-[10px] text-fg-tertiary mt-0.5">{t('codingTools.defaultModelHint')}</div>
                      </div>

                      {name === 'claude-code' && (
                        <div>
                          <label className="text-xs text-fg-secondary block mb-1">{t('codingTools.budgetCap')}</label>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-fg-tertiary">$</span>
                            <input
                              type="number"
                              min={0}
                              step={0.5}
                              value={form.maxBudgetPerSessionUsd}
                              onChange={e => updateTool(name, { maxBudgetPerSessionUsd: e.target.value })}
                              placeholder="5.00"
                              className="w-32 px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none tabular-nums"
                            />
                            <span className="text-[10px] text-fg-tertiary">USD</span>
                          </div>
                          <div className="text-[10px] text-fg-tertiary mt-0.5">{t('codingTools.budgetCapHint')}</div>
                        </div>
                      )}

                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs text-fg-secondary">{t('codingTools.approvalRequired')}</div>
                          <div className="text-[10px] text-fg-tertiary mt-0.5">{t('codingTools.approvalRequiredHint')}</div>
                        </div>
                        <Toggle
                          checked={form.approvalRequired}
                          onChange={() => updateTool(name, { approvalRequired: !form.approvalRequired })}
                        />
                      </div>

                      <div className="flex items-center gap-4">
                        <div className="flex-1">
                          <label className="text-xs text-fg-secondary block mb-1">{t('codingTools.timeout')}</label>
                          <div className="flex items-center gap-2">
                            <input
                              type="number"
                              min={1}
                              step={1}
                              value={form.timeoutMin}
                              onChange={e => updateTool(name, { timeoutMin: e.target.value })}
                              className="w-24 px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary focus:border-brand-500 outline-none tabular-nums"
                            />
                            <span className="text-[10px] text-fg-tertiary">{t('codingTools.timeoutUnit')}</span>
                          </div>
                        </div>
                      </div>

                      {/* ── Section: Advanced ── */}
                      <SectionLabel>{t('codingTools.sectionAdvanced')}</SectionLabel>

                      <div>
                        <label className="text-xs text-fg-secondary block mb-1">{t('codingTools.defaultArgs')}</label>
                        <input
                          type="text"
                          value={form.defaultArgs}
                          onChange={e => updateTool(name, { defaultArgs: e.target.value })}
                          placeholder={t('codingTools.defaultArgsPlaceholder')}
                          className="w-full px-3 py-1.5 text-xs bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:border-brand-500 outline-none font-mono"
                        />
                      </div>

                      {/* ── Test ── */}
                      <div className="pt-3 border-t border-border-default">
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            disabled={testingTool === name}
                            onClick={() => runTest(name)}
                            className="px-3 py-1.5 text-xs font-medium bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-50 transition-colors flex items-center gap-1.5 shrink-0"
                          >
                            {testingTool === name && <Spinner className="w-3 h-3" />}
                            {testingTool === name ? t('codingTools.testing') : t('codingTools.testConfig')}
                          </button>
                          {!testResult[name] && (
                            <span className="text-[10px] text-fg-tertiary">{t('codingTools.testConfigHint')}</span>
                          )}
                        </div>
                        {testResult[name] && (
                          <div className={`mt-2 px-3 py-2 rounded-lg text-xs ${
                            testResult[name]!.success
                              ? 'bg-green-500/10 border border-green-500/20 text-green-600'
                              : 'bg-red-500/10 border border-red-500/20 text-red-500'
                          }`}>
                            <div className="flex items-start gap-2">
                              <span className="shrink-0 mt-0.5">{testResult[name]!.success ? '✓' : '✗'}</span>
                              <div className="min-w-0">
                                <div>{testResult[name]!.detail}</div>
                                {!testResult[name]!.success && (
                                  <div className="text-[10px] mt-1 opacity-80">{t('codingTools.testFailedHint')}</div>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}

        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            {msg && <Msg type={msg.type} text={msg.text} />}
          </div>
          <button
            type="button"
            onClick={() => void refreshDetection()}
            disabled={detecting || loading}
            className="px-3 py-1.5 text-xs border border-border-default text-fg-secondary hover:text-fg-primary hover:border-gray-600 rounded-lg transition-colors disabled:opacity-40"
          >
            {detecting ? t('codingTools.detecting') : t('codingTools.redetect')}
          </button>
        </div>
      </div>
    </section>
  );
}
