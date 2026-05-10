/**
 * ExternalAdmin - Full-featured "External" tab for managing agent's external mode.
 *
 * Sections: Service Status, Share Links, Configuration (editable),
 * Middleware, UI Customization.
 * Uses app design tokens for dark/light mode and i18n for all strings.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { DynamicUIRenderer } from '../components/DynamicUIRenderer.js';

interface ExternalServiceInfo {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  welcomeMessage?: string;
  inputPlaceholder?: string;
  version: number;
  status: string;
  maxConcurrentSessions: number;
  sessionTimeoutMs: number;
  maxMessagesPerSession: number;
  tokenBudgetPerSession: number;
  tokenBudgetPerDay: number;
  middlewares: MiddlewareConfig[];
  uiMode: string;
  uiConfig?: Record<string, unknown>;
  publishedAt?: string;
  updatedAt: string;
}

interface MiddlewareConfig {
  name: string;
  enabled: boolean;
  phase: string;
  priority: number;
  config: Record<string, unknown>;
}

interface ShareTokenInfo {
  id: string;
  token: string;
  status: string;
  usageCount: number;
  maxUses?: number;
  expiresAt?: string;
  createdAt: string;
}

interface ServiceStats {
  poolStats: { totalSessions: number; activeCalls: number; maxConcurrent: number; waitQueueLength: number } | null;
  activeSessions: number;
}

interface ExternalAdminProps {
  agentId: string;
  orgId: string;
}

const MIDDLEWARE_KEYS = [
  { name: 'security-gate', phase: 'pre', priority: 0 },
  { name: 'rate-limiter', phase: 'pre', priority: 10 },
  { name: 'auth-checker', phase: 'pre', priority: 5 },
  { name: 'token-budget', phase: 'pre', priority: 20 },
  { name: 'content-filter', phase: 'post', priority: 90 },
  { name: 'audit-logger', phase: 'both', priority: 100 },
  { name: 'payment', phase: 'pre', priority: 30 },
  { name: 'file-upload', phase: 'pre', priority: 40 },
  { name: 'feedback', phase: 'post', priority: 95 },
];

type TabKey = 'status' | 'links' | 'config' | 'middleware' | 'ui';

export function ExternalAdmin({ agentId }: ExternalAdminProps) {
  const { t } = useTranslation(['agent']);
  const [service, setService] = useState<ExternalServiceInfo | null>(null);
  const [tokens, setTokens] = useState<ShareTokenInfo[]>([]);
  const [stats, setStats] = useState<ServiceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('status');

  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editWelcome, setEditWelcome] = useState('');
  const [editPlaceholder, setEditPlaceholder] = useState('');
  const [editMaxSessions, setEditMaxSessions] = useState(10);
  const [editMaxMessages, setEditMaxMessages] = useState(100);
  const [editTokenSession, setEditTokenSession] = useState(50000);
  const [editTokenDay, setEditTokenDay] = useState(500000);

  const [middlewares, setMiddlewares] = useState<MiddlewareConfig[]>([]);

  const [uiDescription, setUiDescription] = useState('');
  const [generatingUI, setGeneratingUI] = useState(false);
  const [generatedUI, setGeneratedUI] = useState<Record<string, unknown> | null>(null);

  const fetchService = useCallback(async () => {
    try {
      const res = await fetch(`/api/external/services/get?agentId=${agentId}`);
      if (res.ok) {
        const svc = await res.json();
        setService(svc);
        syncEditState(svc);
      } else if (res.status !== 404) {
        setError(t('agent:external.errors.loadFailed'));
      }
    } catch {
      setError(t('agent:external.errors.network'));
    } finally {
      setLoading(false);
    }
  }, [agentId, t]);

  const syncEditState = (svc: ExternalServiceInfo) => {
    setEditName(svc.name ?? '');
    setEditDesc(svc.description ?? '');
    setEditWelcome(svc.welcomeMessage ?? '');
    setEditPlaceholder(svc.inputPlaceholder ?? '');
    setEditMaxSessions(svc.maxConcurrentSessions);
    setEditMaxMessages(svc.maxMessagesPerSession);
    setEditTokenSession(svc.tokenBudgetPerSession);
    setEditTokenDay(svc.tokenBudgetPerDay);
    setMiddlewares(svc.middlewares?.length ? svc.middlewares : MIDDLEWARE_KEYS.slice(0, 4).map(m => ({ name: m.name, enabled: true, phase: m.phase, priority: m.priority, config: {} })));
  };

  const fetchStats = useCallback(async () => {
    if (!service) return;
    try {
      const res = await fetch(`/api/external/services/stats?serviceId=${service.id}`);
      if (res.ok) setStats(await res.json());
    } catch { /* ignore */ }
  }, [service]);

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetch(`/api/external/share/tokens?agentId=${agentId}`);
      if (res.ok) {
        const data = await res.json();
        setTokens(data.tokens ?? []);
      }
    } catch { /* ignore */ }
  }, [agentId]);

  useEffect(() => { fetchService(); }, [fetchService]);
  useEffect(() => { if (service) { fetchStats(); fetchTokens(); } }, [service, fetchStats, fetchTokens]);

  const publishService = async () => {
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch('/api/external/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          config: {
            name: editName || undefined,
            description: editDesc || undefined,
            welcomeMessage: editWelcome || undefined,
            inputPlaceholder: editPlaceholder || undefined,
            maxConcurrentSessions: editMaxSessions,
            maxMessagesPerSession: editMaxMessages,
            tokenBudgetPerSession: editTokenSession,
            tokenBudgetPerDay: editTokenDay,
            middlewares,
          },
        }),
      });
      if (res.ok) {
        const svc = await res.json();
        setService(svc);
        syncEditState(svc);
        setSuccess(t('agent:external.publishSuccess'));
        setTimeout(() => setSuccess(null), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? t('agent:external.errors.publishFailed'));
      }
    } catch {
      setError(t('agent:external.errors.network'));
    } finally {
      setPublishing(false);
    }
  };

  const updateStatus = async (status: string) => {
    if (!service) return;
    try {
      const res = await fetch('/api/external/services/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: service.id, status }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? t('agent:external.errors.statusFailed'));
        return;
      }
      fetchService();
      setSuccess(status === 'active' ? t('agent:external.status.resumeBtn') : t('agent:external.status.pauseBtn'));
      setTimeout(() => setSuccess(null), 3000);
    } catch { setError(t('agent:external.errors.statusFailed')); }
  };

  const saveConfig = async () => {
    if (!service) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/external/services/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceId: service.id,
          name: editName,
          description: editDesc,
          welcomeMessage: editWelcome,
          inputPlaceholder: editPlaceholder,
          maxConcurrentSessions: editMaxSessions,
          maxMessagesPerSession: editMaxMessages,
          tokenBudgetPerSession: editTokenSession,
          tokenBudgetPerDay: editTokenDay,
          middlewares,
        }),
      });
      if (res.ok) {
        const updated = await res.json();
        setService(updated);
        setSuccess(t('agent:external.publishSuccess'));
        setTimeout(() => setSuccess(null), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? t('agent:external.errors.saveFailed'));
      }
    } catch {
      setError(t('agent:external.errors.network'));
    } finally {
      setSaving(false);
    }
  };

  const generateToken = async () => {
    try {
      const res = await fetch('/api/external/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
      if (res.ok) {
        const data = await res.json();
        setTokens(prev => [{ id: data.id, token: data.token, status: 'active', usageCount: 0, maxUses: undefined, expiresAt: data.expiresAt, createdAt: new Date().toISOString() }, ...prev]);
        setSuccess(t('agent:external.links.generateBtn'));
        setTimeout(() => setSuccess(null), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? t('agent:external.errors.tokenFailed'));
      }
    } catch { setError(t('agent:external.errors.tokenFailed')); }
  };

  const generateUI = async () => {
    if (!uiDescription.trim()) return;
    setGeneratingUI(true);
    setError(null);
    try {
      const res = await fetch('/api/external/services/generate-ui', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: uiDescription }),
      });
      if (res.ok) {
        const data = await res.json();
        setGeneratedUI(data.uiConfig);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? t('agent:external.errors.generateFailed'));
      }
    } catch {
      setError(t('agent:external.errors.network'));
    } finally {
      setGeneratingUI(false);
    }
  };

  const applyGeneratedUI = async () => {
    if (!service || !generatedUI) return;
    setSaving(true);
    try {
      const res = await fetch('/api/external/services/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: service.id, uiMode: 'custom', uiConfig: generatedUI }),
      });
      if (res.ok) {
        const updated = await res.json();
        setService(updated);
        setGeneratedUI(null);
        setUiDescription('');
        setSuccess(t('agent:external.ui.applied'));
        setTimeout(() => setSuccess(null), 3000);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? t('agent:external.errors.saveFailed'));
      }
    } catch {
      setError(t('agent:external.errors.network'));
    } finally {
      setSaving(false);
    }
  };

  const toggleMiddleware = (name: string) => {
    setMiddlewares(prev => {
      const existing = prev.find(m => m.name === name);
      if (existing) {
        return prev.map(m => m.name === name ? { ...m, enabled: !m.enabled } : m);
      }
      const def = MIDDLEWARE_KEYS.find(m => m.name === name);
      if (!def) return prev;
      return [...prev, { name, enabled: true, phase: def.phase, priority: def.priority, config: {} }];
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-6 h-6 border-2 border-border-default border-t-fg-secondary rounded-full animate-spin" />
      </div>
    );
  }

  if (!service) {
    return (
      <div className="text-center py-16">
        <div className="w-16 h-16 rounded-2xl bg-surface-elevated flex items-center justify-center mx-auto mb-4">
          <span className="text-2xl">🌐</span>
        </div>
        <h3 className="text-lg font-semibold text-fg-primary mb-2">{t('agent:external.emptyTitle')}</h3>
        <p className="text-sm text-fg-tertiary mb-6 max-w-sm mx-auto">
          {t('agent:external.emptyDesc')}
        </p>
        {error && <p className="text-xs text-red-400 mb-4">{error}</p>}
        <button onClick={publishService} disabled={publishing} className="px-5 py-2.5 bg-brand-600 text-white text-sm font-medium rounded-lg hover:bg-brand-500 disabled:opacity-50 transition-colors">
          {publishing ? t('agent:external.publishing') : t('agent:external.publishBtn')}
        </button>
      </div>
    );
  }

  const tabKeys: Array<{ key: TabKey; labelKey: string }> = [
    { key: 'status', labelKey: 'agent:external.tabs.status' },
    { key: 'links', labelKey: 'agent:external.tabs.links' },
    { key: 'config', labelKey: 'agent:external.tabs.config' },
    { key: 'middleware', labelKey: 'agent:external.tabs.middleware' },
    { key: 'ui', labelKey: 'agent:external.tabs.ui' },
  ];

  return (
    <div className="max-w-4xl">
      {/* Alerts */}
      {error && (
        <div className="mb-4 px-4 py-2.5 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center justify-between">
          <span className="text-sm text-red-400">{error}</span>
          <button onClick={() => setError(null)} className="text-red-400/60 hover:text-red-400 text-lg leading-none">&times;</button>
        </div>
      )}
      {success && (
        <div className="mb-4 px-4 py-2.5 bg-green-500/10 border border-green-500/20 rounded-lg">
          <span className="text-sm text-green-400">{success}</span>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-0 border-b border-border-default mb-5 overflow-x-auto">
        {tabKeys.map(tk => (
          <button
            key={tk.key}
            onClick={() => setTab(tk.key)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
              tab === tk.key
                ? 'border-brand-500 text-fg-primary'
                : 'border-transparent text-fg-tertiary hover:text-fg-secondary'
            }`}
          >
            {t(tk.labelKey)}
          </button>
        ))}
      </div>

      {/* Status Tab */}
      {tab === 'status' && (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
              service.status === 'active' ? 'bg-green-500/15 text-green-400' : 'bg-amber-500/15 text-amber-400'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${service.status === 'active' ? 'bg-green-500' : 'bg-amber-500'}`} />
              {t(`agent:external.status.${service.status}`)}
            </span>
            <span className="text-xs text-fg-muted">{t('agent:external.status.version', { version: service.version })}</span>
            {service.publishedAt && <span className="text-xs text-fg-muted">{t('agent:external.status.publishedAt', { date: new Date(service.publishedAt).toLocaleDateString() })}</span>}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label={t('agent:external.status.activeSessions')} value={stats?.activeSessions ?? 0} />
            <StatCard label={t('agent:external.status.activeLLMCalls')} value={stats?.poolStats?.activeCalls ?? 0} />
            <StatCard label={t('agent:external.status.maxConcurrent')} value={service.maxConcurrentSessions} />
            <StatCard label={t('agent:external.status.queue')} value={stats?.poolStats?.waitQueueLength ?? 0} />
          </div>

          <div className="flex gap-2 pt-2">
            {service.status === 'active' && (
              <button onClick={() => updateStatus('paused')} className="px-4 py-2 text-sm font-medium text-amber-400 bg-amber-500/10 rounded-lg hover:bg-amber-500/20 transition-colors">
                {t('agent:external.status.pauseBtn')}
              </button>
            )}
            {service.status === 'paused' && (
              <button onClick={() => updateStatus('active')} className="px-4 py-2 text-sm font-medium text-green-400 bg-green-500/10 rounded-lg hover:bg-green-500/20 transition-colors">
                {t('agent:external.status.resumeBtn')}
              </button>
            )}
            <button onClick={publishService} disabled={publishing} className="px-4 py-2 text-sm font-medium text-fg-secondary bg-surface-elevated rounded-lg hover:bg-surface-overlay disabled:opacity-50 transition-colors">
              {publishing ? t('agent:external.publishing') : t('agent:external.status.publishNewBtn')}
            </button>
          </div>
        </div>
      )}

      {/* Share Links Tab */}
      {tab === 'links' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-fg-tertiary">{t('agent:external.links.desc')}</p>
            <button onClick={generateToken} className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-500 transition-colors">
              {t('agent:external.links.generateBtn')}
            </button>
          </div>
          <div className="space-y-2">
            {tokens.length === 0 ? (
              <p className="text-sm text-fg-muted py-8 text-center">{t('agent:external.links.empty')}</p>
            ) : (
              tokens.map(tk => <ShareLinkRow key={tk.id} tokenInfo={tk} />)
            )}
          </div>
        </div>
      )}

      {/* Configuration Tab */}
      {tab === 'config' && (
        <div className="space-y-5">
          <div className="grid gap-4">
            <FieldRow label={t('agent:external.config.name')}>
              <input value={editName} onChange={e => setEditName(e.target.value)} className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 outline-none" />
            </FieldRow>
            <FieldRow label={t('agent:external.config.description')}>
              <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={2} className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 outline-none resize-none" />
            </FieldRow>
            <FieldRow label={t('agent:external.config.welcomeMessage')}>
              <textarea value={editWelcome} onChange={e => setEditWelcome(e.target.value)} rows={2} className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 outline-none resize-none" placeholder={t('agent:external.config.welcomePlaceholder')} />
            </FieldRow>
            <FieldRow label={t('agent:external.config.inputPlaceholder')}>
              <input value={editPlaceholder} onChange={e => setEditPlaceholder(e.target.value)} className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 outline-none" placeholder={t('agent:external.config.inputPlaceholderDefault')} />
            </FieldRow>
            <div className="grid grid-cols-2 gap-4">
              <FieldRow label={t('agent:external.config.maxSessions')}>
                <input type="number" value={editMaxSessions} onChange={e => setEditMaxSessions(Number(e.target.value))} className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 outline-none" />
              </FieldRow>
              <FieldRow label={t('agent:external.config.maxMessages')}>
                <input type="number" value={editMaxMessages} onChange={e => setEditMaxMessages(Number(e.target.value))} className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 outline-none" />
              </FieldRow>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <FieldRow label={t('agent:external.config.tokenSession')}>
                <input type="number" value={editTokenSession} onChange={e => setEditTokenSession(Number(e.target.value))} className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 outline-none" />
              </FieldRow>
              <FieldRow label={t('agent:external.config.tokenDay')}>
                <input type="number" value={editTokenDay} onChange={e => setEditTokenDay(Number(e.target.value))} className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 outline-none" />
              </FieldRow>
            </div>
          </div>
          <div className="pt-2">
            <button onClick={saveConfig} disabled={saving} className="px-5 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-500 disabled:opacity-50 transition-colors">
              {saving ? t('agent:external.config.saving') : t('agent:external.config.saveBtn')}
            </button>
          </div>
        </div>
      )}

      {/* Middleware Tab */}
      {tab === 'middleware' && (
        <div className="space-y-4">
          <p className="text-sm text-fg-tertiary">{t('agent:external.middleware.desc')}</p>
          <div className="space-y-2">
            {MIDDLEWARE_KEYS.map(mw => {
              const current = middlewares.find(m => m.name === mw.name);
              const enabled = current?.enabled ?? false;
              const mwLabel = t(`agent:external.middleware.items.${mw.name}.label` as any);
              const mwDesc = t(`agent:external.middleware.items.${mw.name}.desc` as any);
              return (
                <div key={mw.name} className="flex items-center justify-between p-3 rounded-lg border border-border-subtle hover:border-border-default transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-fg-primary">{mwLabel}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-elevated text-fg-muted">{mw.phase}</span>
                    </div>
                    <p className="text-xs text-fg-muted mt-0.5">{mwDesc}</p>
                  </div>
                  <button
                    onClick={() => toggleMiddleware(mw.name)}
                    className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ml-3 ${enabled ? 'bg-brand-500' : 'bg-surface-overlay'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                </div>
              );
            })}
          </div>
          <div className="pt-2">
            <button onClick={saveConfig} disabled={saving} className="px-5 py-2.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-500 disabled:opacity-50 transition-colors">
              {saving ? t('agent:external.middleware.saving') : t('agent:external.middleware.saveBtn')}
            </button>
          </div>
        </div>
      )}

      {/* UI Customization Tab */}
      {tab === 'ui' && (
        <div className="space-y-5">
          <div>
            <h4 className="text-sm font-medium text-fg-primary mb-1">{t('agent:external.ui.currentMode')}</h4>
            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
              service.uiMode === 'custom' ? 'bg-brand-500/15 text-brand-400' : 'bg-surface-elevated text-fg-tertiary'
            }`}>
              {service.uiMode === 'custom' ? t('agent:external.ui.custom') : t('agent:external.ui.default')}
            </span>
            {service.uiMode === 'custom' && (
              <button
                onClick={async () => {
                  setSaving(true);
                  try {
                    const res = await fetch('/api/external/services/update', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ serviceId: service.id, uiMode: 'default', uiConfig: null }),
                    });
                    if (!res.ok) {
                      const data = await res.json().catch(() => ({}));
                      setError(data.error ?? t('agent:external.errors.saveFailed'));
                    } else {
                      fetchService();
                      setSuccess(t('agent:external.ui.applied'));
                      setTimeout(() => setSuccess(null), 3000);
                    }
                  } catch {
                    setError(t('agent:external.errors.network'));
                  } finally {
                    setSaving(false);
                  }
                }}
                className="ml-3 text-xs text-fg-muted hover:text-fg-secondary underline"
              >
                {t('agent:external.ui.resetBtn')}
              </button>
            )}
          </div>

          <div className="border border-border-default rounded-xl p-5">
            <h4 className="text-sm font-medium text-fg-primary mb-3">{t('agent:external.ui.generateTitle')}</h4>
            <p className="text-xs text-fg-tertiary mb-3">{t('agent:external.ui.generateDesc')}</p>
            <textarea
              value={uiDescription}
              onChange={e => setUiDescription(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 text-sm bg-surface-elevated border border-border-default rounded-lg text-fg-primary focus:border-brand-500 focus:ring-1 focus:ring-brand-500/30 outline-none resize-none mb-3"
              placeholder={t('agent:external.ui.generatePlaceholder')}
            />
            <button
              onClick={generateUI}
              disabled={generatingUI || !uiDescription.trim()}
              className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-500 disabled:opacity-50 transition-colors"
            >
              {generatingUI ? (
                <span className="flex items-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {t('agent:external.ui.generating')}
                </span>
              ) : t('agent:external.ui.generateBtn')}
            </button>
          </div>

          {generatedUI && (
            <div className="border border-brand-500/30 rounded-xl p-5 bg-brand-500/5">
              <h4 className="text-sm font-medium text-fg-primary mb-3">{t('agent:external.ui.previewTitle')}</h4>
              <div className="border border-border-default rounded-lg p-3 mb-3 bg-surface-elevated overflow-hidden max-h-80">
                <DynamicUIRenderer config={generatedUI} sessionState="active">
                  <div className="p-4 text-sm text-fg-tertiary text-center">{t('agent:external.ui.previewTitle')}</div>
                </DynamicUIRenderer>
              </div>
              <details className="mb-3">
                <summary className="text-xs text-fg-muted cursor-pointer hover:text-fg-secondary">JSON</summary>
                <pre className="text-xs bg-surface-elevated border border-border-default rounded-lg p-3 overflow-auto max-h-48 mt-2 text-fg-secondary">
                  {JSON.stringify(generatedUI, null, 2)}
                </pre>
              </details>
              <div className="flex gap-2">
                <button onClick={applyGeneratedUI} disabled={saving} className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-500 disabled:opacity-50 transition-colors">
                  {saving ? t('agent:external.ui.applying') : t('agent:external.ui.applyBtn')}
                </button>
                <button onClick={() => setGeneratedUI(null)} className="px-4 py-2 text-sm font-medium text-fg-secondary bg-surface-elevated rounded-lg hover:bg-surface-overlay transition-colors">
                  {t('agent:external.ui.discardBtn')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-surface-elevated rounded-xl p-4 text-center">
      <div className="text-xl font-bold text-fg-primary">{value}</div>
      <div className="text-xs text-fg-tertiary mt-1">{label}</div>
    </div>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-fg-secondary mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function ShareLinkRow({ tokenInfo }: { tokenInfo: ShareTokenInfo }) {
  const { t } = useTranslation(['agent']);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const shareUrl = `${window.location.origin}/ext/${tokenInfo.token}`;

  const copyLink = () => {
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="flex items-center gap-3 p-3 rounded-lg border border-border-subtle hover:border-border-default transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium text-white ${tokenInfo.status === 'active' ? 'bg-green-500' : 'bg-red-500'}`}>
            {tokenInfo.status}
          </span>
          <span className="text-[11px] text-fg-muted">
            {tokenInfo.maxUses
              ? t('agent:external.links.usesMax', { count: tokenInfo.usageCount, max: tokenInfo.maxUses })
              : t('agent:external.links.uses', { count: tokenInfo.usageCount })}
          </span>
          {tokenInfo.expiresAt && (
            <span className="text-[11px] text-fg-muted">
              {t('agent:external.links.expires', { date: new Date(tokenInfo.expiresAt).toLocaleDateString() })}
            </span>
          )}
        </div>
        <code className="text-[11px] text-fg-tertiary break-all leading-relaxed">{shareUrl}</code>
      </div>
      <button onClick={copyLink} className="px-3 py-1.5 text-xs font-medium text-fg-secondary bg-surface-elevated rounded-lg hover:bg-surface-overlay transition-colors whitespace-nowrap">
        {copied ? t('agent:external.links.copied') : t('agent:external.links.copyBtn')}
      </button>
    </div>
  );
}

export default ExternalAdmin;
