import { useState } from 'react';
import { api, type AuthUser } from '../api.ts';

const DEFAULT_PASSWORD = 'markus123';

interface Props {
  onLogin: (user: AuthUser, isDefaultPassword: boolean) => void;
}

export function Login({ onLogin }: Props) {
  const [email, setEmail] = useState('admin@markus.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setError('');
    setLoading(true);
    try {
      const { user } = await api.auth.login(email.trim(), password);
      onLogin(user, password === DEFAULT_PASSWORD);
    } catch {
      setError('Invalid email or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-primary flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-brand-950/50 via-transparent to-transparent" />
      <div className="w-full max-w-sm relative z-10">
        {/* Logo */}
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Markus" className="w-14 h-14 mx-auto mb-3 rounded-xl shadow-lg shadow-black/40" />
          <div className="text-2xl font-extrabold tracking-tight text-white mb-1">Markus</div>
          <div className="text-sm text-gray-500">AI Digital Employee Platform</div>
        </div>

        {/* Card */}
        <form
          onSubmit={submit}
          className="bg-surface-secondary/80 backdrop-blur-sm border border-border-default rounded-2xl p-8 space-y-5 shadow-2xl shadow-black/30"
        >
          <h2 className="text-lg font-semibold text-white text-center">Sign in</h2>

          <div className="space-y-1">
            <label className="text-xs text-gray-500 font-medium">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-gray-100 focus:border-brand-500 outline-none transition-colors"
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-500 font-medium">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full px-4 py-2.5 bg-surface-elevated border border-border-default rounded-xl text-sm text-gray-100 focus:border-brand-500 outline-none transition-colors"
              required
            />
          </div>

          {error && (
            <div className="px-3 py-2 bg-red-900/30 border border-red-700/50 rounded-lg text-xs text-red-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full py-2.5 bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-all shadow-md shadow-brand-900/40 hover:shadow-lg hover:shadow-brand-900/50"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="text-center text-xs text-gray-600">
            Default: admin@markus.local / markus123
          </p>
        </form>
      </div>
    </div>
  );
}
