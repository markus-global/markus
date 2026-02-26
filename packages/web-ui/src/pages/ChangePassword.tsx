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
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="text-4xl font-bold text-white mb-1">◈ Markus</div>
          <div className="text-sm text-gray-500">AI Digital Employee Platform</div>
        </div>

        <form onSubmit={submit} className="bg-gray-900 border border-gray-800 rounded-2xl p-8 space-y-5 shadow-2xl">
          <div>
            <h2 className="text-lg font-semibold text-white text-center">
              {isFirstTime ? 'Set Your Password' : 'Change Password'}
            </h2>
            {isFirstTime && (
              <p className="text-xs text-amber-400/80 text-center mt-2">
                You're using the default password. Please set a new one before continuing.
              </p>
            )}
          </div>

          {!isFirstTime && (
            <div className="space-y-1">
              <label className="text-xs text-gray-500 font-medium">Current Password</label>
              <input
                type="password"
                value={current}
                onChange={e => setCurrent(e.target.value)}
                autoComplete="current-password"
                className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-sm text-gray-100 focus:border-indigo-500 outline-none transition-colors"
              />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-gray-500 font-medium">New Password</label>
            <input
              type="password"
              value={next}
              onChange={e => setNext(e.target.value)}
              autoComplete="new-password"
              className="w-full px-4 py-2.5 bg-gray-800 border border-gray-700 rounded-xl text-sm text-gray-100 focus:border-indigo-500 outline-none transition-colors"
              required
              minLength={6}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-gray-500 font-medium">Confirm New Password</label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              autoComplete="new-password"
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
            disabled={loading || !next || !confirm}
            className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors"
          >
            {loading ? 'Saving…' : isFirstTime ? 'Set Password & Continue' : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  );
}
