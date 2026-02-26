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
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="text-4xl font-bold text-white mb-1">◈ Markus</div>
          <div className="text-sm text-gray-500">AI Digital Employee Platform</div>
        </div>

        {/* Card */}
        <form
          onSubmit={submit}
          className="bg-gray-900 border border-gray-800 rounded-2xl p-8 space-y-5 shadow-2xl"
        >
          <h2 className="text-lg font-semibold text-white text-center">Sign in</h2>

          <div className="space-y-1">
            <label className="text-xs text-gray-500 font-medium">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-sm text-gray-100 focus:border-indigo-500 outline-none transition-colors"
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
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-sm text-gray-100 focus:border-indigo-500 outline-none transition-colors"
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
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors"
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
