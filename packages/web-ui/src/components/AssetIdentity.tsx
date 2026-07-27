import { useMemo, useState } from 'react';
import {
  type AssetType,
  ASSET_TYPE_META,
  assetCoverGradient,
  assetGlyphPath,
  defaultAvatarUrl,
  isImageIcon,
  isEmojiIcon,
  normalizeAssetType,
} from '../lib/assetIdentity';
import { NamedIcon, hasNamedIcon } from '../lib/namedIcons.tsx';

/** Resolve an asset icon string to a usable <img> src, prefixing hub-relative paths. */
export function resolveIconSrc(icon: string | undefined, hubBase?: string): string | null {
  if (!icon || !isImageIcon(icon)) return null;
  if (icon.startsWith('http') || icon.startsWith('data:')) return icon;
  if (icon.startsWith('/') && hubBase) return `${hubBase}${icon}`;
  return icon;
}

interface AssetGlyphProps {
  type?: string;
  seed: string;
  icon?: string;
  hubBase?: string;
  size?: number;
  className?: string;
  rounded?: string;
}

/** Compact square asset mark: image icon > emoji > deterministic gradient+glyph. */
export function AssetGlyph({
  type,
  seed,
  icon,
  hubBase,
  size = 44,
  className = '',
  rounded = 'rounded-xl',
}: AssetGlyphProps) {
  const t = normalizeAssetType(type);
  const imgSrc = resolveIconSrc(icon, hubBase);
  const gradient = useMemo(() => assetCoverGradient(t, seed), [t, seed]);
  const glyph = useMemo(() => assetGlyphPath(seed), [seed]);
  const [imgError, setImgError] = useState(false);

  if (imgSrc && !imgError) {
    return (
      <img
        src={imgSrc}
        alt=""
        onError={() => setImgError(true)}
        style={{ width: size, height: size }}
        className={`${rounded} object-cover shrink-0 ${className}`}
      />
    );
  }

  if (isEmojiIcon(icon)) {
    return (
      <div
        style={{ width: size, height: size, background: gradient, fontSize: size * 0.5 }}
        className={`${rounded} shrink-0 flex items-center justify-center shadow-inner ${className}`}
      >
        <span className="drop-shadow-sm">{icon}</span>
      </div>
    );
  }

  if (icon && hasNamedIcon(icon)) {
    return (
      <div
        style={{ width: size, height: size, background: gradient }}
        className={`${rounded} shrink-0 flex items-center justify-center text-white shadow-inner ${className}`}
      >
        <NamedIcon name={icon} size={size * 0.52} className="drop-shadow-sm" />
      </div>
    );
  }

  return (
    <div
      style={{ width: size, height: size, background: gradient }}
      className={`${rounded} shrink-0 flex items-center justify-center shadow-inner ${className}`}
    >
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d={glyph} fill="rgba(255,255,255,0.92)" />
      </svg>
    </div>
  );
}

interface AssetCoverProps {
  type?: string;
  seed: string;
  icon?: string;
  hubBase?: string;
  /** optional full cover image (thumbnail/screenshot) */
  cover?: string | null;
  className?: string;
  children?: React.ReactNode;
}

/** Large cover banner used at the top of asset cards. */
export function AssetCover({ type, seed, icon, hubBase, cover, className = '', children }: AssetCoverProps) {
  const t = normalizeAssetType(type);
  const gradient = useMemo(() => assetCoverGradient(t, seed), [t, seed]);
  const glyph = useMemo(() => assetGlyphPath(seed), [seed]);
  const coverSrc = resolveIconSrc(cover || undefined, hubBase);
  const iconSrc = resolveIconSrc(icon, hubBase);
  const [coverError, setCoverError] = useState(false);

  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={coverSrc && !coverError ? undefined : { background: gradient }}
    >
      {coverSrc && !coverError ? (
        <img
          src={coverSrc}
          alt=""
          onError={() => setCoverError(true)}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : (
        <>
          {/* subtle decorative glyph watermark */}
          <svg
            className="absolute -right-6 -bottom-8 opacity-[0.18]"
            width="140"
            height="140"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden
          >
            <path d={glyph} fill="white" />
          </svg>
          <div className="absolute inset-0 bg-gradient-to-t from-black/25 to-transparent" />
          {iconSrc ? (
            <img src={iconSrc} alt="" className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-xl object-cover ring-2 ring-white/30" />
          ) : isEmojiIcon(icon) ? (
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-4xl drop-shadow">{icon}</span>
          ) : icon && hasNamedIcon(icon) ? (
            <span className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 rounded-xl bg-white/15 ring-1 ring-white/30 backdrop-blur-sm flex items-center justify-center text-white">
              <NamedIcon name={icon} size={26} className="drop-shadow" />
            </span>
          ) : null}
        </>
      )}
      {children}
    </div>
  );
}

interface CreatorAvatarProps {
  name?: string;
  username?: string;
  avatarUrl?: string;
  hubBase?: string;
  size?: number;
  className?: string;
  verified?: boolean;
}

/** Round creator avatar: uploaded image > deterministic DiceBear default. */
export function CreatorAvatar({
  name,
  username,
  avatarUrl,
  hubBase,
  size = 24,
  className = '',
  verified,
}: CreatorAvatarProps) {
  const seed = username || name || 'markus';
  const uploaded = resolveIconSrc(avatarUrl, hubBase);
  const [error, setError] = useState(false);
  const src = uploaded && !error ? uploaded : defaultAvatarUrl(seed);
  return (
    <span className={`relative inline-flex shrink-0 ${className}`} style={{ width: size, height: size }}>
      <img
        src={src}
        alt={name || username || ''}
        onError={() => setError(true)}
        className="w-full h-full rounded-full object-cover ring-1 ring-white/10 bg-surface-elevated"
      />
      {verified && (
        <span
          className="absolute -right-0.5 -bottom-0.5 flex items-center justify-center rounded-full bg-brand-500 ring-2 ring-surface-primary"
          style={{ width: size * 0.42, height: size * 0.42 }}
        >
          <svg viewBox="0 0 24 24" width="60%" height="60%" fill="white" aria-hidden>
            <path d="M9 16.2l-3.5-3.5 1.4-1.4L9 13.4l7.1-7.1 1.4 1.4z" />
          </svg>
        </span>
      )}
    </span>
  );
}

/** Small pill showing the asset type with its brand color. */
export function AssetTypeBadge({ type, className = '' }: { type?: string; className?: string }) {
  const t = normalizeAssetType(type);
  const meta = ASSET_TYPE_META[t];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white bg-gradient-to-r ${meta.gradient} ${className}`}
    >
      {meta.label}
    </span>
  );
}

export { ASSET_TYPE_META };
export type { AssetType };
