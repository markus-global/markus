import { useState, useEffect, useRef } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import type { ThemeMode } from '../hooks/useTheme.ts';
import { api } from '../api.ts';
import { AvatarUpload } from './Avatar.tsx';

interface Props {
  onComplete: () => void;
  theme: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

interface EnvModelDetected {
  provider: string; displayName: string; apiKeySet: boolean; apiKeyPreview: string;
  model: string; baseUrl?: string; envVars: Record<string, string>;
}
interface EnvModelsResponse { detected: EnvModelDetected[]; timeoutMs?: number }
interface OpenClawPreview { found: boolean; summary: { configPath: string; models?: { providerCount: number; providers: Array<{ name: string; modelCount: number; baseUrl?: string }> } } }

const PROFILE_STEP = 1;
const LLM_STEP = 3;

export function Onboarding({ onComplete, theme, onThemeChange }: Props) {
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
  const [setupMsg, setSetupMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const envDetected = useRef(false);

  const authHeaders = (): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem('markus_token') ?? ''}`,
  });

  useEffect(() => {
    fetch('/api/settings/llm')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.providers && Object.values(d.providers as Record<string, { configured: boolean }>).some(p => p.configured)) {
          setLlmConfigured(true);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (step === LLM_STEP && !envDetected.current && !llmConfigured) {
      envDetected.current = true;
      void detectEnvModels();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, llmConfigured]);

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
    { value: 'dark', label: t('theme.dark'), icon: '🌙', desc: t('theme.darkDesc') },
    { value: 'cyberpunk', label: t('theme.cyberpunk'), icon: '🔮', desc: t('theme.cyberpunkDesc') },
    { value: 'midnight', label: t('theme.midnight'), icon: '🌊', desc: t('theme.midnightDesc') },
  ];

  const steps = [
    // Step 0: Welcome
    {
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
    // Step 2: LLM Setup
    {
      title: t('llm.title'),
      subtitle: t('llm.subtitle'),
      content: llmConfigured ? (
        <div className="flex items-center gap-3 bg-green-500/10 border border-green-500/30 rounded-xl p-4">
          <span className="text-green-600 text-lg">&#10003;</span>
          <div>
            <div className="text-sm font-medium text-green-600">{t('llm.configured')}</div>
            <div className="text-xs text-fg-secondary mt-0.5">{t('llm.configuredHint')}</div>
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
    // Step 3: Done
    {
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

  const handleNext = () => {
    if (step === PROFILE_STEP && !profileSaved) return;
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
        <div className="bg-surface-secondary border border-border-default rounded-2xl p-8">
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
              {step === PROFILE_STEP && !profileSaved && (
                <button onClick={() => setStep(step + 1)} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary transition-colors">
                  {t('llm.skipForNow')}
                </button>
              )}
              {step === LLM_STEP && !llmConfigured && (
                <button onClick={handleNext} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary transition-colors">
                  {t('llm.skipForNow')}
                </button>
              )}
              <button
                onClick={handleNext}
                disabled={step === PROFILE_STEP && !profileSaved}
                className={`px-6 py-2.5 text-white text-sm rounded-xl transition-colors ${
                  step === PROFILE_STEP && !profileSaved
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
