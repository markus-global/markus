import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, getHubUser, type AuthUser } from '../api.ts';
import { useNativeBrowserOverlay } from '../hooks/useNativeBrowserOverlay.ts';
import { AvatarUpload, resolveUserAvatarSrc } from './Avatar.tsx';

interface Props {
  authUser: AuthUser;
  onClose: () => void;
  onSaved: (u: AuthUser) => void;
  onUserUpdated?: (u: AuthUser) => void;
}

export function EditProfileModal({ authUser, onClose, onSaved, onUserUpdated }: Props) {
  const { t } = useTranslation('common');
  useNativeBrowserOverlay(true);
  const [name, setName] = useState(authUser.name || '');
  const [email, setEmail] = useState(authUser.email || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Prefer local avatar; fall back to Hub avatar so the preview matches the sidebar.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(() =>
    resolveUserAvatarSrc(authUser.avatarUrl, getHubUser()?.avatarUrl),
  );

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError(t('profile.nameRequired')); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { setError(t('profile.invalidEmail')); return; }
    setSaving(true); setError('');
    try {
      const { user } = await api.auth.updateProfile(name.trim(), email.trim());
      onSaved({ ...user, avatarUrl: avatarUrl ?? user.avatarUrl });
    } catch { setError(t('profile.failedToSave')); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[10000]" onClick={onClose}>
      <form onSubmit={submit} className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[400px] max-w-[calc(100vw-2rem)] shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-5">{t('profile.editProfile')}</h3>
        <div className="flex justify-center mb-5">
          <AvatarUpload
            currentUrl={avatarUrl}
            name={name}
            size={72}
            targetType="user"
            targetId={authUser.id}
            onUploaded={url => {
              setAvatarUrl(url);
              // Upload persists immediately — sync App authUser without closing the modal.
              onUserUpdated?.({ ...authUser, avatarUrl: url });
            }}
          />
        </div>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-fg-tertiary font-medium mb-1">{t('profile.name')}</label>
            <input value={name} onChange={e => setName(e.target.value)} className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none" />
          </div>
          <div>
            <label className="block text-xs text-fg-tertiary font-medium mb-1">{t('profile.email')}</label>
            <input value={email} onChange={e => setEmail(e.target.value)} type="email" className="w-full px-3 py-2 bg-surface-elevated border border-border-default rounded-lg text-sm text-fg-primary focus:border-brand-500 outline-none" />
          </div>
          {error && <div className="text-xs text-red-500 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</div>}
        </div>
        <div className="flex justify-end gap-3 mt-5">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">{t('cancel')}</button>
          <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 disabled:opacity-50 text-white rounded-lg">{saving ? t('saving') : t('save')}</button>
        </div>
      </form>
    </div>
  );
}
