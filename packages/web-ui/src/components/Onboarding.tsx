import { useState, useEffect } from 'react';
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

const USAGE_TYPE_STEP_ID = 'usageType';
const PROFILE_STEP_ID = 'profile';

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
      const username = user.name || user.email?.split('@')[0] || '';
      if (username) setOrgName(t('usageType.defaultOrgName', { name: username }));
    }).catch(() => {});
    api.hubOrgs.invitations().then(d => {
      if (d.invitations?.length > 0) setPendingInvites(d.invitations);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Usage type state
  const [usageType, setUsageType] = useState<'personal' | 'organization' | null>(null);
  const [orgName, setOrgName] = useState('');
  const [orgNameSaving, setOrgNameSaving] = useState(false);
  const [orgNameSaved, setOrgNameSaved] = useState(false);
  const [pendingInvites, setPendingInvites] = useState<Array<{ orgId: string; orgName: string; invitedBy: string }>>([]);
  const [acceptingInvite, setAcceptingInvite] = useState<string | null>(null);
  const [acceptedInvite, setAcceptedInvite] = useState<string | null>(null);

  // Telemetry opt-in state
  const [telemetryEnabled, setTelemetryEnabled] = useState(true);

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
        <p className="text-fg-secondary text-sm leading-relaxed">
          <Trans
            i18nKey="welcome.description"
            ns="onboarding"
            components={{ strong: <strong className="text-fg-primary" /> }}
          />
        </p>
      ),
    },
    // Step 1: Usage Type
    {
      id: USAGE_TYPE_STEP_ID,
      title: t('usageType.title', { defaultValue: 'How will you use Markus?' }),
      subtitle: t('usageType.subtitle', { defaultValue: 'This helps us tailor your experience.' }),
      content: (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => { setUsageType('personal'); setOrgNameSaved(true); }}
              className={`flex flex-col items-center gap-3 rounded-xl border-2 p-5 transition-all text-left ${
                usageType === 'personal'
                  ? 'border-brand-500 bg-brand-500/10'
                  : 'border-border-default hover:border-fg-tertiary bg-surface-elevated/30'
              }`}
            >
              <span className="text-2xl">👤</span>
              <div>
                <div className="font-medium text-fg-primary text-sm text-center">{t('usageType.personal', { defaultValue: 'Personal' })}</div>
                <div className="text-[11px] text-fg-tertiary mt-1 text-center">{t('usageType.personalDesc', { defaultValue: 'Individual use with your own AI agents.' })}</div>
              </div>
            </button>
            <button
              onClick={() => { setUsageType('organization'); setOrgNameSaved(false); }}
              className={`flex flex-col items-center gap-3 rounded-xl border-2 p-5 transition-all text-left ${
                usageType === 'organization'
                  ? 'border-brand-500 bg-brand-500/10'
                  : 'border-border-default hover:border-fg-tertiary bg-surface-elevated/30'
              }`}
            >
              <span className="text-2xl">🏢</span>
              <div>
                <div className="font-medium text-fg-primary text-sm text-center">{t('usageType.organization', { defaultValue: 'Team & Enterprise' })}</div>
                <div className="text-[11px] text-fg-tertiary mt-1 text-center">{t('usageType.organizationDesc', { defaultValue: 'For teams sharing licenses and collaborating.' })}</div>
              </div>
            </button>
          </div>

          {usageType === 'organization' && (
            <div className="space-y-4 mt-4">
              {pendingInvites.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs text-fg-tertiary font-medium">{t('usageType.pendingInvitations')}</div>
                  {pendingInvites.map(inv => (
                    <div key={inv.orgId} className="flex items-center justify-between px-4 py-3 rounded-xl border border-amber-500/20 bg-amber-500/5">
                      <div>
                        <div className="text-sm font-medium text-fg-primary">{inv.orgName}</div>
                        <div className="text-[11px] text-fg-tertiary">{t('usageType.invitedBy', { name: inv.invitedBy })}</div>
                      </div>
                      <button
                        onClick={async () => {
                          setAcceptingInvite(inv.orgId);
                          try {
                            await api.hubOrgs.acceptInvitation(inv.orgId);
                            setAcceptedInvite(inv.orgId);
                            setOrgNameSaved(true);
                          } catch { /* ignore */ }
                          finally { setAcceptingInvite(null); }
                        }}
                        disabled={acceptingInvite === inv.orgId || acceptedInvite === inv.orgId}
                        className="px-3 py-1.5 text-xs rounded-lg bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white transition-colors"
                      >
                        {acceptedInvite === inv.orgId ? t('usageType.accepted') : acceptingInvite === inv.orgId ? t('usageType.accepting') : t('usageType.acceptAndJoin')}
                      </button>
                    </div>
                  ))}
                  <div className="text-[11px] text-fg-tertiary text-center pt-1">{t('usageType.orCreateNew')}</div>
                </div>
              )}
              <div className="space-y-1">
                <label className="text-xs text-fg-tertiary font-medium">{t('usageType.orgNameLabel')}</label>
                <input
                  type="text"
                  value={orgName}
                  onChange={e => { setOrgName(e.target.value); setOrgNameSaved(false); }}
                  placeholder={t('usageType.orgNamePlaceholder')}
                  className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
                />
              </div>
              <button
                onClick={async () => {
                  if (!orgName.trim()) return;
                  setOrgNameSaving(true);
                  try {
                    const orgsData = await api.hubOrgs.mine();
                    const firstOrg = orgsData.orgs?.[0];
                    if (firstOrg?.id) {
                      await api.hubOrgs.update(firstOrg.id, { name: orgName.trim() });
                    }
                    setOrgNameSaved(true);
                  } catch { /* ignore */ }
                  finally { setOrgNameSaving(false); }
                }}
                disabled={orgNameSaving || !orgName.trim() || orgNameSaved}
                className="w-full px-4 py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-40 text-white text-sm rounded-xl transition-colors"
              >
                {orgNameSaving ? t('common:saving') : orgNameSaved ? t('usageType.orgNameSaved') : t('usageType.setOrgName')}
              </button>
            </div>
          )}
        </div>
      ),
    },
    // Step 2: Profile Setup
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
    // Step: Appearance (final step)
    {
      id: 'theme',
      title: t('theme.title'),
      subtitle: t('theme.subtitle'),
      content: (
        <div className="space-y-4">
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

          <label className="flex items-center gap-2.5 p-3 bg-surface-elevated/30 rounded-lg cursor-pointer group">
            <input
              type="checkbox"
              checked={telemetryEnabled}
              onChange={e => setTelemetryEnabled(e.target.checked)}
              className="accent-brand-500 shrink-0"
            />
            <span className="text-[11px] text-fg-tertiary">{t('done.telemetry')}</span>
          </label>
        </div>
      ),
    },
  ];

  const steps = skipProfile ? allSteps.filter(s => s.id !== PROFILE_STEP_ID) : allSteps;
  const usageTypeStepIdx = steps.findIndex(s => s.id === USAGE_TYPE_STEP_ID);
  const profileStepIdx = steps.findIndex(s => s.id === PROFILE_STEP_ID);

  const handleNext = () => {
    if (step === usageTypeStepIdx && usageTypeStepIdx >= 0 && !usageType) return;
    if (step === usageTypeStepIdx && usageType === 'organization' && !orgNameSaved) return;
    if (step === profileStepIdx && profileStepIdx >= 0 && !profileSaved) return;
    if (step < steps.length - 1) {
      setStep(step + 1);
    } else {
      // Persist telemetry preference
      fetch('/api/settings/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: telemetryEnabled }),
      }).catch(() => {});
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
              {usageTypeStepIdx >= 0 && step === usageTypeStepIdx && !usageType && (
                <button onClick={() => { setUsageType('personal'); setOrgNameSaved(true); setStep(step + 1); }} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary transition-colors">
                  {t('common:skip')}
                </button>
              )}
              {profileStepIdx >= 0 && step === profileStepIdx && !profileSaved && (
                <button onClick={() => setStep(step + 1)} className="px-4 py-2 text-sm text-fg-tertiary hover:text-fg-secondary transition-colors">
                  {t('common:skip')}
                </button>
              )}
              <button
                onClick={handleNext}
                disabled={(profileStepIdx >= 0 && step === profileStepIdx && !profileSaved) || (usageTypeStepIdx >= 0 && step === usageTypeStepIdx && (!usageType || (usageType === 'organization' && !orgNameSaved)))}
                className={`px-6 py-2.5 text-white text-sm rounded-xl transition-colors ${
                  (profileStepIdx >= 0 && step === profileStepIdx && !profileSaved) || (usageTypeStepIdx >= 0 && step === usageTypeStepIdx && (!usageType || (usageType === 'organization' && !orgNameSaved)))
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
