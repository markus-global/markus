import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api, hubApi } from '../api.ts';
import { ConfirmModal } from './ConfirmModal.tsx';

/** Prefer local Markus avatar; resolve Hub-relative paths against Hub origin. */
export function resolveUserAvatarSrc(localUrl?: string | null, hubUrl?: string | null): string | null {
  const pick = localUrl || hubUrl || null;
  if (!pick) return null;
  if (pick.startsWith('http') || pick.startsWith('data:') || pick.startsWith('/api/')) return pick;
  if (pick.startsWith('/')) {
    const base = hubApi.getUrl()?.replace(/\/$/, '') || '';
    return base ? `${base}${pick}` : pick;
  }
  return pick;
}

// ─── Display Avatar ──────────────────────────────────────────────────────────

interface AvatarProps {
  name?: string;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
  bgClass?: string;
  /**
   * Fallback when no usable image:
   * - `icon` — person silhouette (account / sidebar user)
   * - `initials` — letter badge (agents, mentions, etc.)
   */
  fallback?: 'icon' | 'initials';
}

/** Soft neutral person silhouette used for account / user chrome. */
function DefaultUserIcon({ size, className = '' }: { size: number; className?: string }) {
  const iconSize = Math.max(12, Math.round(size * 0.55));
  return (
    <div
      className={`rounded-full bg-surface-overlay text-fg-secondary flex items-center justify-center shrink-0 border border-border-default/70 ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </div>
  );
}

export function Avatar({
  name,
  avatarUrl,
  size = 28,
  className = '',
  bgClass = 'bg-brand-600',
  fallback = 'initials',
}: AvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => { setImgFailed(false); }, [avatarUrl]);
  const showImage = !!avatarUrl && !imgFailed;

  if (showImage) {
    return (
      <img
        src={avatarUrl!}
        alt={name ?? ''}
        className={`rounded-full object-cover shrink-0 ${className}`}
        style={{ width: size, height: size }}
        onError={() => setImgFailed(true)}
      />
    );
  }

  if (fallback === 'icon') {
    return <DefaultUserIcon size={size} className={className} />;
  }

  const initial = name?.[0]?.toUpperCase() ?? '?';
  const fontSize = size <= 20 ? 'text-[8px]' : size <= 28 ? 'text-xs' : size <= 40 ? 'text-sm' : 'text-lg';
  const hasExplicitTextColor = /\btext-(?!white\b)/.test(bgClass);
  return (
    <div
      className={`rounded-full ${bgClass} flex items-center justify-center ${hasExplicitTextColor ? '' : 'text-white'} ${fontSize} font-bold shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      {initial}
    </div>
  );
}

// ─── Avatar Upload ───────────────────────────────────────────────────────────

interface AvatarUploadProps {
  currentUrl?: string | null;
  name?: string;
  size?: number;
  targetType?: 'user' | 'agent';
  targetId?: string;
  onUploaded?: (url: string) => void;
}

export function AvatarUpload({ currentUrl, name, size = 64, targetType = 'user', targetId, onUploaded }: AvatarUploadProps) {
  const { t } = useTranslation('common');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const displayUrl = previewUrl ?? currentUrl;
  useEffect(() => { setImgFailed(false); }, [displayUrl]);
  const showImage = !!displayUrl && !imgFailed;

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 2 * 1024 * 1024) {
      setNotice(t('imageTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      setPreviewUrl(dataUrl);
      setImgFailed(false);
      setUploading(true);
      try {
        const { avatarUrl } = await api.auth.uploadAvatar(dataUrl, targetType, targetId);
        onUploaded?.(avatarUrl);
      } catch {
        setPreviewUrl(null);
      } finally {
        setUploading(false);
      }
    };
    reader.readAsDataURL(file);
  }, [targetType, targetId, onUploaded, t]);

  return (
    <div className="relative inline-block group">
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="relative rounded-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-brand-500/50"
        style={{ width: size, height: size }}
        title="Click to set avatar"
      >
        {showImage ? (
          <img
            src={displayUrl!}
            alt={name ?? ''}
            className="w-full h-full object-cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <DefaultUserIcon size={size} />
        )}
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          {uploading ? (
            <div className="w-5 h-5 border-2 border-white/60 border-t-white rounded-full animate-spin" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          )}
        </div>
      </button>
      {notice && (
        <ConfirmModal
          alertOnly
          variant="danger"
          title={t('error', { defaultValue: 'Error' })}
          message={notice}
          onConfirm={() => setNotice(null)}
          onCancel={() => setNotice(null)}
        />
      )}
    </div>
  );
}
