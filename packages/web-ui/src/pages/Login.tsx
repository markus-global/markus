import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ensureHubAuth, getHubToken, getHubUser, saveHubAuth, clearHubAuth, type AuthUser } from '../api.ts';

interface HubLoginProps {
  onLogin: (user: AuthUser, needsOnboarding: boolean, opts?: { fromHub?: boolean }) => void;
  hasOwner: boolean;
  hasMultipleUsers: boolean;
}

export function Login({ onLogin, hasOwner, hasMultipleUsers }: HubLoginProps) {
  const { t } = useTranslation('auth');
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [showLocalLogin, setShowLocalLogin] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleHubLogin = async (method?: string, isRetry = false) => {
    setError('');
    setLoading(method ?? 'hub');
    try {
      await ensureHubAuth(method);
      const hubToken = getHubToken();
      const hubUser = getHubUser();
      if (!hubToken || !hubUser) {
        setError(t('login.hubUnavailable'));
        return;
      }
      const { user, needsOnboarding } = await api.auth.hubLogin(hubToken, hubUser);
      onLogin(user, needsOnboarding ?? false, { fromHub: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('cancelled')) {
        // User closed popup — not an error
      } else if (!isRetry && getHubToken()) {
        clearHubAuth();
        return handleHubLogin(method, true);
      } else {
        setError(msg || t('login.hubUnavailable'));
      }
    } finally {
      setLoading(null);
    }
  };

  const handleLocalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError('');
    setLoading('local');
    try {
      const { user, needsOnboarding } = await api.auth.login(email.trim(), password);
      onLogin(user, needsOnboarding ?? false);
    } catch {
      setError(t('login.invalidCredentials'));
    } finally {
      setLoading(null);
    }
  };

  const subtitle = hasOwner ? t('login.welcomeBack') : t('login.getStarted');

  return (
    <div className="min-h-dvh bg-surface-primary flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-brand-950/50 via-transparent to-transparent" />
      <div className="w-full max-w-sm relative z-10 flex-1 flex flex-col justify-center">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Markus" className="w-14 h-14 mx-auto mb-3 rounded-xl shadow-lg shadow-black/40" />
          <div className="text-2xl font-extrabold tracking-tight text-fg-primary mb-1">Markus</div>
          <div className="text-sm text-fg-tertiary">{subtitle}</div>
        </div>

        <div className="bg-surface-secondary/80 backdrop-blur-sm border border-border-default rounded-2xl p-8 space-y-4 shadow-2xl shadow-black/30">
          {!showLocalLogin ? (
            <>
              <button
                onClick={() => handleHubLogin('google')}
                disabled={!!loading}
                className="w-full flex items-center justify-center gap-3 py-2.5 px-4 bg-surface-elevated hover:bg-surface-elevated/80 border border-border-default rounded-xl text-sm text-fg-primary font-medium transition-all disabled:opacity-50"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                {loading === 'google' ? t('login.connectingHub') : t('login.withGoogle')}
              </button>

              <button
                onClick={() => handleHubLogin('github')}
                disabled={!!loading}
                className="w-full flex items-center justify-center gap-3 py-2.5 px-4 bg-surface-elevated hover:bg-surface-elevated/80 border border-border-default rounded-xl text-sm text-fg-primary font-medium transition-all disabled:opacity-50"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                {loading === 'github' ? t('login.connectingHub') : t('login.withGithub')}
              </button>

              <button
                onClick={() => handleHubLogin('email')}
                disabled={!!loading}
                className="w-full flex items-center justify-center gap-3 py-2.5 px-4 bg-surface-elevated hover:bg-surface-elevated/80 border border-border-default rounded-xl text-sm text-fg-primary font-medium transition-all disabled:opacity-50"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                </svg>
                {loading === 'email' ? t('login.connectingHub') : t('login.withEmail')}
              </button>

              <p className="text-center text-[11px] text-fg-tertiary pt-1">
                {t('login.terms')}
              </p>

              {error && (
                <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-500">
                  {error}
                </div>
              )}

              <div className="pt-1 text-center">
                <button onClick={() => setShowLocalLogin(true)} className="text-xs text-fg-tertiary hover:text-fg-secondary transition-colors">
                  {t('login.useLocalAccount')}
                </button>
              </div>
            </>
          ) : (
            <>
              <form onSubmit={handleLocalLogin} className="space-y-3">
                <div className="space-y-1">
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    autoComplete="email"
                    autoFocus
                    placeholder={t('login.email')}
                    className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors placeholder:text-fg-tertiary"
                    required
                  />
                </div>
                <div className="space-y-1">
                  <input
                    type="password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password"
                    placeholder={t('login.password')}
                    className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors placeholder:text-fg-tertiary"
                    required
                  />
                </div>

                {error && (
                  <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-500">
                    {error}
                  </div>
                )}

                {!hasMultipleUsers && (
                  <p className="text-[11px] text-fg-tertiary">{t('login.defaultCredentials')}</p>
                )}

                <button
                  type="submit"
                  disabled={loading === 'local' || !email || !password}
                  className="w-full py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-all"
                >
                  {loading === 'local' ? t('login.signingIn') : t('login.signIn')}
                </button>
              </form>

              <div className="pt-1 text-center">
                <button onClick={() => { setShowLocalLogin(false); setError(''); }} className="text-xs text-fg-tertiary hover:text-fg-secondary transition-colors">
                  {t('login.backToHub')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="relative z-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-1 py-6 text-[11px] text-fg-tertiary">
        <a href="https://markus.global" target="_blank" rel="noopener noreferrer" className="hover:text-fg-secondary transition-colors">markus.global</a>
        <a href="mailto:business@markus.global" className="hover:text-fg-secondary transition-colors">{t('login.contactSales')}</a>
      </div>
    </div>
  );
}

export function InviteSetup({ token, onComplete }: { token: string; onComplete: () => void }) {
  const { t } = useTranslation('auth');
  const [inviteInfo, setInviteInfo] = useState<{ name: string; email: string } | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    api.auth.inviteInfo(token)
      .then(info => setInviteInfo(info))
      .catch(() => setInvalid(true));
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError(t('invite.passwordMinLength')); return; }
    if (password !== confirm) { setError(t('invite.passwordsDoNotMatch')); return; }
    setLoading(true);
    try {
      await api.auth.setup(token, password);
      setDone(true);
      setTimeout(() => {
        window.location.hash = '';
        onComplete();
      }, 2000);
    } catch {
      setError(t('invite.error'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-dvh bg-surface-primary flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-brand-950/50 via-transparent to-transparent" />
      <div className="w-full max-w-sm relative z-10">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Markus" className="w-14 h-14 mx-auto mb-3 rounded-xl shadow-lg shadow-black/40" />
          <div className="text-2xl font-extrabold tracking-tight text-fg-primary mb-1">Markus</div>
          <div className="text-sm text-fg-tertiary">{t('invite.subtitle')}</div>
        </div>

        <div className="bg-surface-secondary/80 backdrop-blur-sm border border-border-default rounded-2xl p-8 space-y-5 shadow-2xl shadow-black/30">
          {invalid ? (
            <div className="text-center space-y-3">
              <div className="text-red-500 text-3xl">&#9888;</div>
              <p className="text-sm text-fg-secondary">{t('invite.invalidLink')}</p>
              <button onClick={() => { window.location.hash = ''; onComplete(); }}
                className="text-sm text-brand-500 hover:text-brand-400">{t('login.signIn')}</button>
            </div>
          ) : done ? (
            <div className="text-center space-y-3">
              <div className="text-green-500 text-3xl">&#10003;</div>
              <p className="text-sm text-fg-secondary">{t('invite.setupComplete')}</p>
            </div>
          ) : !inviteInfo ? (
            <div className="text-center text-fg-tertiary text-sm animate-pulse py-4">Loading…</div>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              <h2 className="text-lg font-semibold text-fg-primary text-center">
                {t('invite.greeting', { name: inviteInfo.name })}
              </h2>
              <p className="text-xs text-fg-tertiary text-center">{inviteInfo.email}</p>

              <div className="space-y-1">
                <label className="text-xs text-fg-tertiary font-medium">{t('invite.setPassword')}</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  autoComplete="new-password" autoFocus
                  className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
                  required />
              </div>

              <div className="space-y-1">
                <label className="text-xs text-fg-tertiary font-medium">{t('invite.confirmPassword')}</label>
                <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
                  required />
              </div>

              {error && (
                <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-500">{error}</div>
              )}

              <button type="submit" disabled={loading || !password || !confirm}
                className="w-full py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-all shadow-md shadow-brand-900/40 hover:shadow-lg hover:shadow-brand-900/50">
                {loading ? t('invite.settingUp') : t('invite.setupAccount')}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
