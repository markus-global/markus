import { useState, useRef, useCallback } from 'react';
import { api } from '../api.ts';

// ─── Display Avatar ──────────────────────────────────────────────────────────

interface AvatarProps {
  name?: string;
  avatarUrl?: string | null;
  size?: number;
  className?: string;
  bgClass?: string;
}

export function Avatar({ name, avatarUrl, size = 28, className = '', bgClass = 'bg-brand-600' }: AvatarProps) {
  const initial = name?.[0]?.toUpperCase() ?? '?';
  const fontSize = size <= 20 ? 'text-[8px]' : size <= 28 ? 'text-xs' : size <= 40 ? 'text-sm' : 'text-lg';

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name ?? ''}
        className={`rounded-full object-cover shrink-0 ${className}`}
        style={{ width: size, height: size }}
        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
      />
    );
  }

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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const displayUrl = previewUrl ?? currentUrl;

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return;
    if (file.size > 2 * 1024 * 1024) {
      alert('Image must be under 2MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      setPreviewUrl(dataUrl);
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
  }, [targetType, targetId, onUploaded]);

  const initial = name?.[0]?.toUpperCase() ?? '?';
  const fontSize = size <= 32 ? 'text-sm' : size <= 48 ? 'text-lg' : 'text-2xl';

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
        title="Click to upload avatar"
      >
        {displayUrl ? (
          <img src={displayUrl} alt={name ?? ''} className="w-full h-full object-cover" />
        ) : (
          <div className={`w-full h-full bg-brand-600 flex items-center justify-center text-white ${fontSize} font-bold`}>
            {initial}
          </div>
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
    </div>
  );
}
