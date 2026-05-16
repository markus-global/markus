import { useState, useEffect, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import type { ThemeMode } from '../hooks/useTheme.ts';
import { api } from '../api.ts';
import { AvatarUpload } from './Avatar.tsx';

interface Props {
  onComplete: () => void;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
  skipProfile?: boolean;
}

interface EnvModelDetected {
  provider: string; displayName: string; apiKeySet: boolean; apiKeyPreview: string;
  model: string; baseUrl?: string; envVars: Record<string, string>;
}
interface EnvModelsResponse { detected: EnvModelDetected[]; timeoutMs?: number }
interface OpenClawPreview { found: boolean; summary: { configPath: string; models?: { providerCount: number; providers: Array<{ name: string; modelCount: number; baseUrl?: string }> } } }

const PROFILE_STEP_ID = 'profile';
const LLM_STEP_ID = 'llm';
const SEARCH_STEP_ID = 'search';

export function Onboarding({ onComplete, theme, onThemeChange, skipProfile }: Props) {
  const { t } = useTranslation(['onboarding', 'common']);
  const [step, setStep] = useState(0);

  // Profile setup state
  const [profileName, setProfileName] = useState('');
  const [profileEmail, setProfileEmail] = useState('');
  const [profilePassword, setProfilePassword] = useState('');
  const [profileConfirm, setProfileConfirm] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileAvatarUrl, setProfileAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    api.auth.me().then(({ user }) => {
      if (user.name) setProfileName(user.name);
      if (user.email) setProfileEmail(user.email);
      if (user.avatarUrl) setProfileAvatarUrl(user.avatarUrl);
    }).catch(() => {});
  }, []);

  // LLM setup state
  const [envModels, setEnvModels] = useState<EnvModelsResponse | null>(null);
  const [envLoading, setEnvLoading] = useState(false);
  const [envSelected, setEnvSelected] = useState<Record<string, boolean>>({});
  const [envApplying, setEnvApplying] = useState(false);
  const [openclawPreview, setOpenclawPreview] = useState<OpenClawPreview | null>(null);
  const [openclawLoading, setOpenclawLoading] = useState(false);
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [configuredProviders, setConfiguredProviders] = useState<Array<{ name: string; displayName: string; model: string; apiKeyPreview?: string }>>([]);
  const [setupMsg, setSetupMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [autoFallback, setAutoFallback] = useState(true);
  const envDetected = useRef(false);

  // Search API key state
  const [searchKeys, setSearchKeys] = useState<{ serper: { configured: boolean; preview: string }; brave: { configured: boolean; preview: string }; bocha: { configured: boolean; preview: string } } | null>(null);
  const [searchForm, setSearchForm] = useState({ serperApiKey: '', braveApiKey: '', bochaApiKey: '' });
  const [searchSaving, setSearchSaving] = useState(false);
  const [searchConfigured, setSearchConfigured] = useState(false);
  const [searchMsg, setSearchMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const searchDetected = useRef(false);

  const authHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}`,
  });

  useEffect(() => {
    fetch('/api/settings/llm')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.providers) {
          const active = Object.entries(d.providers as Record<string, { configured: boolean; enabled: boolean; displayName?: string; model?: string; apiKeyPreview?: string }>)
            .filter(([, p]) => p.configured)
            .map(([k, p]) => ({ name: k, displayName: p.displayName ?? k, model: p.model ?? '', apiKeyPreview: p.apiKeyPreview }));
          if (active.length > 0) {
            setLlmConfigured(true);
            setConfiguredProviders(active);
          }
        }
        if (typeof d?.autoFallback === 'boolean') setAutoFallback(d.autoFallback);
      })
      .catch(() => {});
  }, []);

  const earlyLlmStepIdx = skipProfile ? 2 : 3;
  useEffect(() => {
    if (step === earlyLlmStepIdx && !envDetected.current && !llmConfigured) {
      envDetected.current = true;
      void detectEnvModels();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, llmConfigured, earlyLlmStepIdx]);

  const earlySearchStepIdx = skipProfile ? 3 : 4;
  useEffect(() => {
    if (step === earlySearchStepIdx && !searchDetected.current) {
      searchDetected.current = true;
      void detectSearchKeys();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, earlySearchStepIdx]);

  const detectEnvModels = async () => {
    setEnvLoading(true);
    try {
      const res = await fetch('/api/settings/env-models', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json() as EnvModelsResponse;
        setEnvModels(data);
        if (data.detected.length > 0) {
          const sel: Record<string, boolean> = {};
          for (const d of data.detected) sel[d.provider] = true;
          setEnvSelected(sel);
        }
      }
    } catch { /* ignore */ }
    finally { setEnvLoading(false); }
  };

  const applyEnvModels = async () => {
    if (!envModels) return;
    const selected = envModels.detected.filter(d => envSelected[d.provider]);
    if (selected.length === 0) return;
    setEnvApplying(true); setSetupMsg(null);
    try {
      const res = await fetch('/api/settings/env-models', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          providers: selected.map(d => ({ provider: d.provider, model: d.model, baseUrl: d.baseUrl, enabled: true })),
        }),
      });
      if (res.ok) {
        const data = await res.json() as { applied: string[]; message: string };
        setSetupMsg({ type: 'ok', text: data.message });
        setLlmConfigured(true);
      } else {
        setSetupMsg({ type: 'err', text: t('llm.failedToApply') });
      }
    } catch { setSetupMsg({ type: 'err', text: t('common:networkError') }); }
    finally { setEnvApplying(false); }
  };

  const detectOpenclaw = async () => {
    setOpenclawLoading(true);
    try {
      const res = await fetch('/api/settings/import/openclaw', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ preview: true }),
      });
      const data = await res.json() as OpenClawPreview | { error: string };
      if (!('error' in data)) setOpenclawPreview(data);
    } catch { /* ignore */ }
    finally { setOpenclawLoading(false); }
  };

  const importOpenclaw = async () => {
    setOpenclawLoading(true); setSetupMsg(null);
    try {
      const res = await fetch('/api/settings/import/openclaw', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ preview: false }),
      });
      const data = await res.json() as { applied: boolean; appliedModels: number } | { error: string };
      if ('error' in data) {
        setSetupMsg({ type: 'err', text: data.error });
      } else {
        setSetupMsg({ type: 'ok', text: t('llm.importedModels', { count: data.appliedModels }) });
        setLlmConfigured(true);
      }
    } catch { setSetupMsg({ type: 'err', text: t('llm.importFailed') }); }
    finally { setOpenclawLoading(false); }
  };

  const detectSearchKeys = async () => {
    try {
      const res = await fetch('/api/settings/search', { headers: authHeaders() });
      if (res.ok) {
        const data = await res.json() as typeof searchKeys;
        setSearchKeys(data);
        if (data && (data.serper.configured || data.brave.configured || data.bocha.configured)) {
          setSearchConfigured(true);
        }
      }
    } catch { /* ignore */ }
  };

  const saveSearchKeys = async () => {
    const hasAny = searchForm.serperApiKey || searchForm.braveApiKey || searchForm.bochaApiKey;
    if (!hasAny) return;
    setSearchSaving(true); setSearchMsg(null);
    try {
      const updates: Record<string, string> = {};
      if (searchForm.serperApiKey) updates.serperApiKey = searchForm.serperApiKey;
      if (searchForm.braveApiKey) updates.braveApiKey = searchForm.braveApiKey;
      if (searchForm.bochaApiKey) updates.bochaApiKey = searchForm.bochaApiKey;
      const res = await fetch('/api/settings/search', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const data = await res.json() as typeof searchKeys;
        setSearchKeys(data);
        setSearchConfigured(true);
        setSearchForm({ serperApiKey: '', braveApiKey: '', bochaApiKey: '' });
        setSearchMsg({ type: 'ok', text: t('search.saved') });
      } else {
        setSearchMsg({ type: 'err', text: t('search.failedToSave') });
      }
    } catch { setSearchMsg({ type: 'err', text: t('common:networkError') }); }
    finally { setSearchSaving(false); }
  };

  const saveProfile = async () => {
    setProfileError('');
    if (!profileName.trim()) { setProfileError(t('profile.errors.nameRequired')); return; }
    if (!profileEmail.trim()) { setProfileError(t('profile.errors.emailRequired')); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profileEmail.trim())) { setProfileError(t('profile.errors.emailInvalid')); return; }
    if (profilePassword && profilePassword.length < 6) { setProfileError(t('profile.errors.passwordTooShort')); return; }
    if (profilePassword && profilePassword !== profileConfirm) { setProfileError(t('profile.errors.passwordMismatch')); return; }
    setProfileSaving(true);
    try {
      await api.auth.updateProfile(profileName.trim(), profileEmail.trim());
      if (profilePassword) {
        await api.auth.changePassword('', profilePassword);
      }
      setProfileSaved(true);
    } catch {
      setProfileError(t('profile.errors.saveFailed'));
    } finally {
      setProfileSaving(false);
    }
  };

  const themeOptions: Array<{ value: ThemeMode; label: string; icon: string; desc: string }> = [
    { value: 'system', label: t('theme.system'), icon: '💻', desc: t('theme.systemDesc') },
    { value: 'light', label: t('theme.light'), icon: '☀️', desc: t('theme.lightDesc') },
    { value: 'dark', label: t('theme.dark'), icon: '🌊', desc: t('theme.darkDesc') },
    { value: 'cyberpunk', label: t('theme.cyberpunk'), icon: '🔮', desc: t('theme.cyberpunkDesc') },
    { value: 'mono', label: t('theme.mono'), icon: '⬛', desc: t('theme.monoDesc') },
  ];

  const allSteps = [
    // Step 0: Welcome
    {
      id: 'welcome',
      title: t('welcome.title'),
      subtitle: t('welcome.subtitle'),
      content: (
        <div className="space-y-4 text-fg-secondary text-sm leading-relaxed">
          <p className="text-fg-secondary">
            <Trans
              i18nKey="welcome.description"
              ns="onboarding"
              components={{ strong: <strong className="text-fg-primary" /> }}
            />
          </p>
          <div className="grid grid-cols-2 gap-3 mt-6">
            {[
              [t('welcome.features.operation'), t('welcome.features.operationDesc')],
              [t('welcome.features.collaboration'), t('welcome.features.collaborationDesc')],
              [t('welcome.features.memory'), t('welcome.features.memoryDesc')],
              [t('welcome.features.anyLlm'), t('welcome.features.anyLlmDesc')],
            ].map(([title, desc]) => (
              <div key={title} className="bg-surface-elevated/50 rounded-lg p-3">
                <div className="font-medium text-fg-primary text-xs">{title}</div>
                <div className="text-fg-secondary text-xs mt-1">{desc}</div>
              </div>
            ))}
          </div>
        </div>
      ),
    },
    // Step 1: Profile Setup
    {
      id: PROFILE_STEP_ID,
      title: t('profile.title'),
      subtitle: t('profile.subtitle'),
      content: profileSaved ? (
        <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/30 rounded-xl p-4">
          <span className="text-green-600 text-lg">&#10003;</span>
          <div>
            <div className="text-sm font-medium text-green-600">{t('profile.saved')}</div>
            <div className="text-xs text-fg-secondary mt-0.5">{profileName} &middot; {profileEmail}</div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex justify-center">
            <AvatarUpload currentUrl={profileAvatarUrl} name={profileName} size={64} targetType="user" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-fg-tertiary font-medium">{t('profile.nameLabel')} <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={profileName}
              onChange={e => setProfileName(e.target.value)}
              placeholder={t('profile.namePlaceholder')}
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-fg-tertiary font-medium">{t('profile.emailLabel')} <span className="text-red-500">*</span></label>
            <input
              type="email"
              value={profileEmail}
              onChange={e => setProfileEmail(e.target.value)}
              placeholder={t('profile.emailPlaceholder')}
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-fg-tertiary font-medium">{t('profile.newPasswordLabel')}</label>
            <input
              type="password"
              value={profilePassword}
              onChange={e => setProfilePassword(e.target.value)}
              placeholder={t('profile.newPasswordPlaceholder')}
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
            />
          </div>
          {profilePassword && (
            <div className="space-y-1">
              <label className="text-xs text-fg-tertiary font-medium">{t('profile.confirmPasswordLabel')}</label>
              <input
                type="password"
                value={profileConfirm}
                onChange={e => setProfileConfirm(e.target.value)}
                placeholder={t('profile.confirmPasswordPlaceholder')}
                className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
              />
            </div>
          )}
          {profileError && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-500">
              {profileError}
            </div>
          )}
          <button
            onClick={() => void saveProfile()}
            disabled={profileSaving || !profileName.trim() || !profileEmail.trim()}
            className="w-full px-4 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-xl transition-colors"
          >
            {profileSaving ? t('common:saving') : t('profile.saveProfile')}
          </button>
        </div>
      ),
    },
    // Step 2: Appearance
    {
      id: 'theme',
      title: t('theme.title'),
      subtitle: t('theme.subtitle'),
      content: (
        <div className="grid grid-cols-3 gap-3">
          {themeOptions.map(opt => (
            <button
              key={opt.value}
              onClick={() => onThemeChange(opt.value)}
              className={`flex flex-col items-center gap-2 rounded-xl border-2 p-5 transition-all ${
                theme === opt.value
                  ? 'border-brand-500 bg-brand-500/10'
                  : 'border-border-default hover:border-fg-tertiary bg-surface-elevated/30'
              }`}
            >
              <span className="text-2xl">{opt.icon}</span>
              <span className="text-sm font-medium text-fg-primary">{opt.label}</span>
              <span className="text-[11px] text-fg-tertiary leading-tight text-center">{opt.desc}</span>
            </button>
          ))}
        </div>
      ),
    },
    // Step 3: LLM Setup
    {
      id: LLM_STEP_ID,
      title: t('llm.title'),
      subtitle: t('llm.subtitle'),
      content: llmConfigured ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-green-600 text-sm font-medium mb-1">
            <span>&#10003;</span>
            <span>{t('llm.configured')}</span>
          </div>
          {configuredProviders.map(p => (
            <div key={p.name} className="flex items-center justify-between bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-400" />
                <span className="text-sm text-fg-primary font-medium">{p.displayName}</span>
                {p.model && <span className="text-xs text-fg-tertiary">{p.model}</span>}
              </div>
              {p.apiKeyPreview && <code className="text-[10px] text-fg-tertiary">{p.apiKeyPreview}</code>}
            </div>
          ))}
          <div className="text-xs text-fg-secondary mt-1">{t('llm.configuredHint')}</div>

          <div className="flex items-center justify-between bg-surface-elevated/40 rounded-lg px-4 py-3 mt-3">
            <div>
              <div className="text-xs font-medium text-fg-primary">{t('llm.autoFallback')}</div>
              <div className="text-[11px] text-fg-tertiary mt-0.5">{t('llm.autoFallbackDesc')}</div>
            </div>
            <button
              onClick={async () => {
                const newVal = !autoFallback;
                setAutoFallback(newVal);
                try {
                  await fetch('/api/settings/llm', {
                    method: 'POST', headers: authHeaders(),
                    body: JSON.stringify({ autoFallback: newVal }),
                  });
                } catch { setAutoFallback(!newVal); }
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${autoFallback ? 'bg-green-500' : 'bg-gray-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${autoFallback ? 'translate-x-4' : 'translate-x-1'}`} />
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="text-xs text-fg-secondary uppercase tracking-wider">{t('llm.fromEnv')}</div>
            {envLoading && <div className="text-xs text-fg-tertiary animate-pulse">{t('llm.detectingKeys')}</div>}
            {envModels && envModels.detected.length > 0 && (
              <div className="space-y-2">
                {envModels.detected.map(d => (
                  <label key={d.provider} className="flex items-center gap-3 bg-surface-elevated/40 rounded-lg px-3 py-2.5 cursor-pointer hover:bg-surface-elevated/60 transition-colors">
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
                <button onClick={() => void applyEnvModels()}
                  disabled={envApplying || Object.values(envSelected).filter(Boolean).length === 0}
                  className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                  {envApplying ? t('common:applying') : t('llm.applyProviders', { count: Object.values(envSelected).filter(Boolean).length })}
                </button>
              </div>
            )}
            {envModels && envModels.detected.length === 0 && !envLoading && (
              <div className="text-xs text-fg-tertiary bg-surface-elevated/30 rounded-lg p-3">
                <Trans
                  i18nKey="llm.noKeysFound"
                  ns="onboarding"
                  components={{ code: <code className="text-fg-secondary" /> }}
                />
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border-default" />
            <span className="text-xs text-fg-tertiary">{t('llm.or')}</span>
            <div className="flex-1 h-px bg-border-default" />
          </div>

          <div className="space-y-2">
            <div className="text-xs text-fg-secondary uppercase tracking-wider">{t('llm.fromOpenClaw')}</div>
            {!openclawPreview ? (
              <button onClick={() => void detectOpenclaw()} disabled={openclawLoading}
                className="px-4 py-2 border border-border-default hover:bg-surface-elevated disabled:opacity-40 text-fg-secondary text-sm rounded-lg transition-colors w-full">
                {openclawLoading ? t('common:detecting') : t('llm.detectOpenClaw')}
              </button>
            ) : openclawPreview.found ? (
              <div className="space-y-2">
                <div className="text-xs text-green-600">{t('llm.openClawFoundLabel')} <code className="text-fg-secondary">{openclawPreview.summary.configPath}</code>
                  {openclawPreview.summary.models && <span className="text-fg-tertiary ml-1">{t('llm.openClawProviders', { count: openclawPreview.summary.models.providerCount })}</span>}
                </div>
                <button onClick={() => void importOpenclaw()} disabled={openclawLoading}
                  className="w-full px-4 py-2 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-lg transition-colors">
                  {openclawLoading ? t('common:importing') : t('llm.importModelConfigs')}
                </button>
              </div>
            ) : (
              <div className="text-xs text-fg-tertiary bg-surface-elevated/30 rounded-lg p-3">{t('llm.noOpenClawFound')}</div>
            )}
          </div>

          {setupMsg && (
            <div className={`text-xs px-3 py-2 rounded-lg ${setupMsg.type === 'ok' ? 'bg-green-500/10 text-green-600 border border-green-500/30' : 'bg-red-500/10 text-red-500 border border-red-500/30'}`}>
              {setupMsg.text}
            </div>
          )}
        </div>
      ),
    },
    // Step 4: Search API Keys
    {
      id: SEARCH_STEP_ID,
      title: t('search.title'),
      subtitle: t('search.subtitle'),
      content: searchConfigured ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-green-600 text-sm font-medium mb-1">
            <span>&#10003;</span>
            <span>{t('search.saved')}</span>
          </div>
          {searchKeys && ([
            { id: 'serper' as const, label: t('search.serper') },
            { id: 'brave' as const, label: t('search.brave') },
            { id: 'bocha' as const, label: t('search.bocha') },
          ]).filter(item => searchKeys[item.id]?.configured).map(item => (
            <div key={item.id} className="flex items-center justify-between bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-400" />
                <span className="text-sm text-fg-primary font-medium">{item.label}</span>
              </div>
              <code className="text-[10px] text-fg-tertiary">{searchKeys[item.id].preview}</code>
            </div>
          ))}
          <div className="text-xs text-fg-secondary mt-1">{t('search.savedHint')}</div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-xs text-fg-secondary">{t('search.description')}</div>

          {searchKeys && (searchKeys.serper.configured || searchKeys.brave.configured || searchKeys.bocha.configured) && (
            <div className="space-y-2">
              <div className="text-xs text-fg-secondary uppercase tracking-wider">{t('search.detected')}</div>
              {([
                { id: 'serper' as const, label: t('search.serper') },
                { id: 'brave' as const, label: t('search.brave') },
                { id: 'bocha' as const, label: t('search.bocha') },
              ]).filter(item => searchKeys[item.id]?.configured).map(item => (
                <div key={item.id} className="flex items-center justify-between bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-400" />
                    <span className="text-sm text-fg-primary">{item.label}</span>
                  </div>
                  <code className="text-[10px] text-fg-tertiary">{searchKeys[item.id].preview}</code>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-3">
            {([
              { label: t('search.serper'), field: 'serperApiKey' as const },
              { label: t('search.brave'), field: 'braveApiKey' as const },
              { label: t('search.bocha'), field: 'bochaApiKey' as const },
            ]).map(item => (
              <div key={item.field} className="space-y-1">
                <label className="text-xs text-fg-tertiary font-medium">{item.label}</label>
                <input
                  type="password"
                  value={searchForm[item.field]}
                  onChange={e => setSearchForm({ ...searchForm, [item.field]: e.target.value })}
                  placeholder={t('search.apiKeyPlaceholder')}
                  className="w-full px-4 py-2 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
                />
              </div>
            ))}
          </div>

          <button
            onClick={() => void saveSearchKeys()}
            disabled={searchSaving || (!searchForm.serperApiKey && !searchForm.braveApiKey && !searchForm.bochaApiKey)}
            className="w-full px-4 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-xl transition-colors"
          >
            {searchSaving ? t('search.saving') : t('search.save')}
          </button>

          {searchMsg && (
            <div className={`text-xs px-3 py-2 rounded-lg ${searchMsg.type === 'ok' ? 'bg-green-500/10 text-green-600 border border-green-500/30' : 'bg-red-500/10 text-red-500 border border-red-500/30'}`}>
              {searchMsg.text}
            </div>
          )}
        </div>
      ),
    },
    // Step: Done
    {
      id: 'done',
      title: t('done.title'),
      subtitle: t('done.subtitle'),
      content: (
        <div className="space-y-2 text-fg-secondary text-sm">
          {[
            [t('done.chat'), t('done.chatDesc')],
            [t('done.projects'), t('done.projectsDesc')],
            [t('done.builder'), t('done.builderDesc')],
            [t('done.settings'), t('done.settingsDesc')],
          ].map(([title, desc]) => (
            <div key={title} className="flex gap-3 bg-surface-elevated/50 rounded-lg p-3">
              <div className="text-brand-500 mt-0.5 shrink-0">&#x2192;</div>
              <div>
                <div className="font-medium text-fg-primary text-xs">{title}</div>
                <div className="text-fg-secondary text-xs">{desc}</div>
              </div>
            </div>
          ))}
        </div>
      ),
    },
  ];

  const steps = skipProfile ? allSteps.filter(s => s.id !== PROFILE_STEP_ID) : allSteps;
  const profileStepIdx = steps.findIndex(s => s.id === PROFILE_STEP_ID);
  const llmStepIdx = steps.findIndex(s => s.id === LLM_STEP_ID);
  const searchStepIdx = steps.findIndex(s => s.id === SEARCH_STEP_ID);

  const handleNext = () => {
    if (step === profileStepIdx && profileStepIdx >= 0 && !profileSaved) return;
    if (step < steps.length - 1) {
      setStep(step + 1);
    } else {
      onComplete();
    }
  };

  const current = steps[step]!;

  return (
    <div className="min-h-dvh bg-surface-primary flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="bg-surface-elevated rounded-2xl p-8">
          <div className="flex gap-1.5 mb-8">
            {steps.map((_, i) => (
              <div key={i} className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? 'bg-brand-500' : 'bg-surface-elevated'}`} />
            ))}
          </div>

          <h2 className="text-2xl font-bold text-fg-primary">{current.title}</h2>
          <p className="text-sm text-fg-secondary mt-1 mb-6">{current.subtitle}</p>

          {current.content}

          <div className="flex justify-between mt-8">
            {step > 0 ? (
              <button onClick={() => setStep(step - 1)} className="px-4 py-2 text-sm text-fg-secondary hover:text-fg-primary transition-colors">
                {t('common:back')}
              </button>
            ) : (
              <button onClick={onComplete} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary transition-colors">
                {t('common:skip')}
              </button>
            )}
            <div className="flex items-center gap-3">
              {profileStepIdx >= 0 && step === profileStepIdx && !profileSaved && (
                <button onClick={() => setStep(step + 1)} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary transition-colors">
                  {t('llm.skipForNow')}
                </button>
              )}
              {llmStepIdx >= 0 && step === llmStepIdx && !llmConfigured && (
                <button onClick={handleNext} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary transition-colors">
                  {t('llm.skipForNow')}
                </button>
              )}
              {searchStepIdx >= 0 && step === searchStepIdx && !searchConfigured && (
                <button onClick={handleNext} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary transition-colors">
                  {t('search.skipForNow')}
                </button>
              )}
              <button
                onClick={handleNext}
                disabled={profileStepIdx >= 0 && step === profileStepIdx && !profileSaved}
                className={`px-6 py-2.5 text-white text-sm rounded-xl transition-colors ${
                  profileStepIdx >= 0 && step === profileStepIdx && !profileSaved
                    ? 'bg-brand-600/40 cursor-not-allowed'
                    : 'bg-brand-600 hover:bg-brand-500'
                }`}
              >
                {step === steps.length - 1 ? t('getStarted') : t('common:next')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
