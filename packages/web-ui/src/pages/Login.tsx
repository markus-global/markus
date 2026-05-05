import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type AuthUser } from '../api.ts';

interface InitialSetupProps {
  onSetup: (user: AuthUser, needsOnboarding: boolean) => void;
}

export function InitialSetup({ onSetup }: InitialSetupProps) {
  const { t } = useTranslation('auth');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleAvatarFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 2 * 1024 * 1024) return;
    const reader = new FileReader();
    reader.onload = () => setAvatarDataUrl(reader.result as string);
    reader.readAsDataURL(file);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError(t('setup.passwordMinLength')); return; }
    if (password !== confirm) { setError(t('setup.passwordsDoNotMatch')); return; }
    setLoading(true);
    try {
      const { user, needsOnboarding } = await api.auth.init(name.trim(), email.trim(), password);
      if (avatarDataUrl) {
        try { await api.auth.uploadAvatar(avatarDataUrl, 'user'); } catch { /* non-critical */ }
      }
      onSetup(user, needsOnboarding ?? true);
    } catch {
      setError(t('setup.error'));
    } finally {
      setLoading(false);
    }
  };

  const initial = name.trim() ? name.trim()[0]!.toUpperCase() : '?';

  return (
    <div className="min-h-dvh bg-surface-primary flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-brand-950/50 via-transparent to-transparent" />
      <div className="w-full max-w-sm relative z-10">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Markus" className="w-14 h-14 mx-auto mb-3 rounded-xl shadow-lg shadow-black/40" />
          <div className="text-2xl font-extrabold tracking-tight text-fg-primary mb-1">Markus</div>
          <div className="text-sm text-fg-tertiary">{t('setup.subtitle')}</div>
        </div>

        <form
          onSubmit={submit}
          className="bg-surface-secondary/80 backdrop-blur-sm border border-border-default rounded-2xl p-8 space-y-5 shadow-2xl shadow-black/30"
        >
          <h2 className="text-lg font-semibold text-fg-primary text-center">{t('setup.title')}</h2>

          <div className="flex flex-col items-center gap-2">
            <div className="relative group cursor-pointer" onClick={() => fileRef.current?.click()}>
              {avatarDataUrl ? (
                <img src={avatarDataUrl} alt="" className="w-16 h-16 rounded-full object-cover ring-2 ring-border-default group-hover:ring-brand-500 transition-all" />
              ) : (
                <div className="w-16 h-16 rounded-full bg-surface-elevated border-2 border-dashed border-border-default group-hover:border-brand-500 flex items-center justify-center transition-all">
                  <svg className="w-6 h-6 text-fg-tertiary group-hover:text-brand-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" /><circle cx="12" cy="13" r="3" /></svg>
                </div>
              )}
              <div className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-brand-600 flex items-center justify-center ring-2 ring-surface-secondary">
                <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleAvatarFile(f); }}
              />
            </div>
            <span className="text-xs text-fg-tertiary">{t('setup.uploadAvatar')}</span>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-fg-tertiary font-medium">{t('setup.name')}</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              autoComplete="name"
              autoFocus
              placeholder="Admin"
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors placeholder:text-fg-tertiary"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-fg-tertiary font-medium">{t('setup.email')}</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="your@email.com"
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors placeholder:text-fg-tertiary"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-fg-tertiary font-medium">{t('setup.password')}</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-fg-tertiary font-medium">{t('setup.confirmPassword')}</label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              autoComplete="new-password"
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
              required
            />
          </div>

          {error && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-500">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !name || !email || !password || !confirm}
            className="w-full py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-all shadow-md shadow-brand-900/40 hover:shadow-lg hover:shadow-brand-900/50"
          >
            {loading ? t('setup.creating') : t('setup.createAccount')}
          </button>
        </form>
      </div>
    </div>
  );
}

interface Props {
  onLogin: (user: AuthUser, needsOnboarding: boolean) => void;
}

export function Login({ onLogin }: Props) {
  const { t } = useTranslation('auth');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError('');
    setLoading(true);
    try {
      const { user, needsOnboarding } = await api.auth.login(email.trim(), password);
      onLogin(user, needsOnboarding ?? false);
    } catch {
      setError(t('login.invalidCredentials'));
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
          <div className="text-sm text-fg-tertiary">{t('login.subtitle')}</div>
        </div>

        <form
          onSubmit={submit}
          className="bg-surface-secondary/80 backdrop-blur-sm border border-border-default rounded-2xl p-8 space-y-5 shadow-2xl shadow-black/30"
        >
          <h2 className="text-lg font-semibold text-fg-primary text-center">{t('login.signIn')}</h2>

          <div className="space-y-1">
            <label className="text-xs text-fg-tertiary font-medium">{t('login.email')}</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="your@email.com"
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors placeholder:text-fg-tertiary"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-fg-tertiary font-medium">{t('login.password')}</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
              required
            />
          </div>

          {error && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-500">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-all shadow-md shadow-brand-900/40 hover:shadow-lg hover:shadow-brand-900/50"
          >
            {loading ? t('login.signingIn') : t('login.signIn')}
          </button>

          <p className="text-center text-xs text-fg-tertiary">
            {t('login.defaultCredentials')}
          </p>
        </form>
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
              <div className="text-red-500 text-3xl">⚠</div>
              <p className="text-sm text-fg-secondary">{t('invite.invalidLink')}</p>
              <button onClick={() => { window.location.hash = ''; onComplete(); }}
                className="text-sm text-brand-500 hover:text-brand-400">{t('login.signIn')}</button>
            </div>
          ) : done ? (
            <div className="text-center space-y-3">
              <div className="text-green-500 text-3xl">✓</div>
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
