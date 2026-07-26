import { useState, type ReactNode } from 'react';
import { AssetGlyph, CreatorAvatar, AssetTypeBadge, resolveIconSrc } from './AssetIdentity.tsx';
import { ASSET_TYPE_META, assetCoverGradient, formatCount, formatPrice, normalizeAssetType } from '../lib/assetIdentity.ts';

export interface AssetCardProps {
  type?: string;
  name: string;
  description?: string;
  /** stable seed for deterministic identity (slug or name) */
  seed?: string;
  icon?: string;
  cover?: string | null;
  hubBase?: string;
  author?: { displayName?: string; username?: string; avatarUrl?: string } | null;
  authorLabel?: string;
  version?: string;
  category?: string;
  tags?: string[];
  rating?: number;
  ratingCount?: number;
  downloadCount?: number;
  priceCents?: number;
  currency?: string;
  installed?: boolean;
  glowing?: boolean;
  selected?: boolean;
  showTypeBadge?: boolean;
  /** hide the rating/download stats row (e.g. for built-in templates with no hub metrics) */
  hideStats?: boolean;
  /** small pill shown in the meta line (e.g. "内置") */
  cornerLabel?: string;
  /** footer action buttons (install / buy / upgrade) */
  actions?: ReactNode;
  /** optional left-aligned footer content (e.g. external registry metrics) */
  footerLeft?: ReactNode;
  /** top-right header action (e.g. delete) — kept out of the crowded footer */
  headerAction?: ReactNode;
  onClick?: () => void;
  className?: string;
}

function Stars({ rating = 0 }: { rating?: number }) {
  const full = Math.round(rating);
  return (
    <span className="inline-flex items-center" aria-label={`${rating} out of 5`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg key={i} viewBox="0 0 24 24" width="12" height="12" className={i < full ? 'text-amber-400' : 'text-fg-muted/40'} fill="currentColor" aria-hidden>
          <path d="M12 2l2.4 6.9L21 9l-5.4 4 2 7-5.6-4.1L6.4 20l2-7L3 9l6.6-.1z" />
        </svg>
      ))}
    </span>
  );
}

/** Unified, premium marketplace card for agent / team / skill / connector assets. */
export function AssetCard(props: AssetCardProps) {
  const {
    type,
    name,
    description,
    seed,
    icon,
    cover,
    hubBase,
    author,
    authorLabel,
    version,
    category,
    tags,
    rating = 0,
    ratingCount = 0,
    downloadCount = 0,
    priceCents,
    currency = 'usd',
    installed,
    glowing,
    selected,
    showTypeBadge = true,
    hideStats = false,
    cornerLabel,
    actions,
    footerLeft,
    headerAction,
    onClick,
    className = '',
  } = props;

  const t = normalizeAssetType(type);
  const meta = ASSET_TYPE_META[t];
  const identitySeed = seed || name;
  const isPaid = (priceCents ?? 0) > 0;
  const hasBanner = !!resolveIconSrc(cover || undefined, hubBase);
  const identityGradient = assetCoverGradient(t, identitySeed);
  const subtitle = authorLabel ?? author?.displayName ?? author?.username ?? '';

  // Cover cards adopt the image's own aspect ratio (clamped to a sensible
  // range) so the whole image shows in the waterfall instead of being cropped.
  const [coverAspect, setCoverAspect] = useState<number | null>(null);

  // Compact status marker shown top-right of the header to fill the space and
  // signal state at a glance: installed > custom label > price.
  const topRightBadge = installed ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 text-emerald-400 border border-emerald-500/25 px-2 py-0.5 text-[10px] font-semibold">
      <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"><polyline points="20 6 9 17 4 12" /></svg>
    </span>
  ) : cornerLabel ? (
    <span className="chip">{cornerLabel}</span>
  ) : isPaid ? (
    <span className="badge-paid">{formatPrice(priceCents, currency)}</span>
  ) : null;

  // ── Full-bleed variant: when a real cover image exists, use it as the whole
  // card background with content overlaid, rather than an awkward top banner.
  if (hasBanner) {
    const coverSrc = resolveIconSrc(cover || undefined, hubBase)!;
    return (
      <div
        onClick={onClick}
        style={{ aspectRatio: coverAspect ?? undefined }}
        className={`group asset-card card-shine relative flex flex-col overflow-hidden min-h-[180px] ${onClick ? 'cursor-pointer' : ''} ${
          selected ? 'ring-1 ring-brand-500/60' : ''
        } ${glowing ? 'ring-2 ring-brand-500 shadow-lg shadow-brand-500/20' : ''} ${className}`}
      >
        <img
          src={coverSrc}
          alt=""
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth && img.naturalHeight) {
              setCoverAspect(Math.min(1.9, Math.max(1.0, img.naturalWidth / img.naturalHeight)));
            }
          }}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-[600ms] group-hover:scale-[1.05]"
        />
        {/* readability scrims */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/50 to-black/5" />
        <div className="absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-black/50 to-transparent" />

        {/* top row: type badge + status / header action */}
        <div className="relative flex items-start justify-between gap-2 p-3">
          <span>{showTypeBadge && <AssetTypeBadge type={t} />}</span>
          <span className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            {installed ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/25 text-emerald-50 border border-emerald-300/40 px-2 py-0.5 text-[10px] font-semibold backdrop-blur-md">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg>
              </span>
            ) : cornerLabel ? (
              <span className="inline-flex items-center rounded-full bg-white/15 text-white border border-white/25 px-2 py-0.5 text-[10px] font-medium backdrop-blur-md">{cornerLabel}</span>
            ) : !headerAction ? (
              <span className={isPaid ? 'badge-paid' : 'badge-free'}>{formatPrice(priceCents, currency)}</span>
            ) : null}
            {headerAction}
          </span>
        </div>

        {/* bottom content over the image */}
        <div className="relative mt-auto p-4 pt-10 flex flex-col gap-2 text-white">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold truncate drop-shadow-md">{name}</h3>
            {version && <span className="shrink-0 rounded-full bg-white/15 border border-white/25 px-1.5 py-0.5 text-[10px] font-medium backdrop-blur-md">v{version}</span>}
          </div>

          {subtitle && (
            <div className="flex items-center gap-1.5 text-[11px] text-white/85">
              {author && (
                <CreatorAvatar name={author.displayName} username={author.username} avatarUrl={author.avatarUrl} hubBase={hubBase} size={15} />
              )}
              <span className="truncate">{subtitle}</span>
            </div>
          )}

          {description && <p className="text-[12.5px] text-white/80 truncate leading-snug drop-shadow-sm">{description}</p>}

          {(category || (tags && tags.length > 0)) && (
            <div className="flex flex-nowrap gap-1.5 overflow-hidden">
              {category && <span className="shrink-0 rounded-full bg-white/15 border border-white/20 text-white/95 px-2 py-0.5 text-[10px] font-semibold capitalize backdrop-blur-md">{category}</span>}
              {tags?.slice(0, 3).map((tag) => (
                <span key={tag} className="shrink-0 rounded-full bg-white/10 border border-white/15 text-white/85 px-2 py-0.5 text-[10px] backdrop-blur-md">{tag}</span>
              ))}
            </div>
          )}

          {(!hideStats || actions) && (
            <div className="flex items-center justify-between gap-2 pt-1 shrink-0">
              {!hideStats ? (
                <div className="flex items-center gap-3 text-[11px] text-white/80">
                  <span className="inline-flex items-center gap-1">
                    <Stars rating={rating} />
                    {ratingCount > 0 && <span className="text-white/60">({formatCount(ratingCount)})</span>}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" /></svg>
                    {formatCount(downloadCount)}
                  </span>
                </div>
              ) : <span />}
              {actions && <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>{actions}</div>}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={onClick}
      className={`group asset-card card-shine relative flex flex-col ${onClick ? 'cursor-pointer' : ''} ${
        selected ? 'ring-1 ring-brand-500/60' : ''
      } ${glowing ? 'ring-2 ring-brand-500 shadow-lg shadow-brand-500/20' : ''} ${className}`}
    >
      {/* accent hairline that lights up on hover */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px] opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{ background: `linear-gradient(90deg, transparent, ${meta.accent}, transparent)` }}
      />

      {/* subtle per-item color wash so each icon-less card keeps a distinct identity */}
      <div
        className="pointer-events-none absolute -top-10 -left-10 w-36 h-36 rounded-full blur-2xl opacity-[0.12] group-hover:opacity-20 transition-opacity duration-300"
        style={{ background: identityGradient }}
      />

      {headerAction && (
        <div className="absolute top-2.5 right-2.5 z-10" onClick={(e) => e.stopPropagation()}>
          {headerAction}
        </div>
      )}

      <div className="relative p-4 flex flex-col flex-1 gap-2.5">
        {/* Header: icon tile + title + author subtitle */}
        <div className="flex items-start gap-3">
          <AssetGlyph
            type={t}
            seed={identitySeed}
            icon={icon}
            hubBase={hubBase}
            size={46}
            rounded="rounded-2xl"
            className="ring-1 ring-white/10 shadow-sm shadow-black/20"
          />
          <div className={`min-w-0 flex-1 ${headerAction ? 'pr-7' : ''}`}>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-fg-primary truncate group-hover:text-brand-300 transition-colors">{name}</h3>
              {version && <span className="chip shrink-0">v{version}</span>}
              {topRightBadge && <span className="ml-auto shrink-0">{topRightBadge}</span>}
            </div>
            {(subtitle || showTypeBadge) && (
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-tertiary min-w-0">
                {author && (
                  <CreatorAvatar name={author.displayName} username={author.username} avatarUrl={author.avatarUrl} hubBase={hubBase} size={15} />
                )}
                {subtitle && <span className="truncate">{subtitle}</span>}
                {showTypeBadge && (
                  <>
                    {subtitle && <span className="text-fg-muted">·</span>}
                    <span className="font-semibold shrink-0" style={{ color: meta.accent }}>{meta.label}</span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {description && <p className="text-[13px] text-fg-secondary truncate leading-snug">{description}</p>}

        {(category || (tags && tags.length > 0)) && (
          <div className="flex flex-wrap gap-1.5">
            {category && <span className="chip-accent capitalize">{category}</span>}
            {tags?.slice(0, 3).map((tag) => (
              <span key={tag} className="chip">{tag}</span>
            ))}
            {(tags?.length ?? 0) > 3 && <span className="text-[10px] text-fg-muted self-center">+{(tags?.length ?? 0) - 3}</span>}
          </div>
        )}

        {(() => {
          const leftContent = footerLeft ?? (!hideStats ? (
            <span className="flex items-center gap-3 text-[11px] text-fg-tertiary">
              <span className="inline-flex items-center gap-1">
                <Stars rating={rating} />
                <span className="text-fg-muted">{ratingCount > 0 ? `(${formatCount(ratingCount)})` : ''}</span>
              </span>
              <span className="inline-flex items-center gap-1">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" /></svg>
                {formatCount(downloadCount)}
              </span>
            </span>
          ) : null);
          if (!leftContent && !actions) return null;
          return (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 mt-auto border-t border-border-subtle/60" onClick={(e) => e.stopPropagation()}>
              {leftContent && <div className="min-w-0 flex items-center gap-2">{leftContent}</div>}
              {actions && <div className="flex flex-wrap items-center gap-2 justify-end">{actions}</div>}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
