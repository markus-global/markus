import { useState } from 'react';
import { api } from '../api.ts';

interface Props {
  onComplete: () => void;
  isFirstTime?: boolean;
}

export function ChangePassword({ onComplete, isFirstTime }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (next.length < 6) { setError('Password must be at least 6 characters'); return; }
    if (next !== confirm) { setError('Passwords do not match'); return; }
    setLoading(true);
    try {
      await api.auth.changePassword(current, next);
      onComplete();
    } catch {
      setError('Failed to change password. Check your current password.');
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
          <div className="text-sm text-fg-tertiary">AI Digital Employee Platform</div>
        </div>

        <form onSubmit={submit} className="bg-surface-secondary/80 backdrop-blur-sm border border-border-default rounded-2xl p-8 space-y-5 shadow-2xl shadow-black/30">
          <div>
            <h2 className="text-lg font-semibold text-fg-primary text-center">
              {isFirstTime ? 'Set Your Password' : 'Change Password'}
            </h2>
            {isFirstTime && (
              <p className="text-xs text-amber-600/80 text-center mt-2">
                You're using the default password. Please set a new one before continuing.
              </p>
            )}
          </div>

          {!isFirstTime && (
            <div className="space-y-1">
              <label className="text-xs text-fg-tertiary font-medium">Current Password</label>
              <input
                type="password"
                value={current}
                onChange={e => setCurrent(e.target.value)}
                autoComplete="current-password"
                className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
              />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-fg-tertiary font-medium">New Password</label>
            <input
              type="password"
              value={next}
              onChange={e => setNext(e.target.value)}
              autoComplete="new-password"
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-fg-primary focus:border-brand-500 outline-none transition-colors"
              required
              minLength={6}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-fg-tertiary font-medium">Confirm New Password</label>
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
            disabled={loading || !next || !confirm}
            className="w-full py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors"
          >
            {loading ? 'Saving…' : isFirstTime ? 'Set Password & Continue' : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  );
}
