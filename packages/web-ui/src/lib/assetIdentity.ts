// Asset identity system — deterministic, cohesive visuals for marketplace assets.
//
// Every asset (agent / team / skill / connector) and every creator gets a stable,
// good-looking visual identity derived from a seed string, so the community/store
// looks intentional and polished even before anyone uploads custom art.
//
// No external icon library is required: glyphs are inline SVG, gradients are CSS.
// Default creator avatars use DiceBear's open-source HTTP API (deterministic by seed).

export type AssetType = 'agent' | 'team' | 'skill' | 'connector';

export interface AssetTypeMeta {
  /** English label */
  label: string;
  /** Chinese label (creator-facing vocabulary) */
  labelZh: string;
  /** Tailwind gradient classes for badges/accents */
  gradient: string;
  /** Base accent hex (used for glows, rings) */
  accent: string;
  /** Deterministic gradient palettes (from,to) used for asset covers */
  covers: Array<[string, string]>;
}

export const ASSET_TYPE_META: Record<AssetType, AssetTypeMeta> = {
  agent: {
    label: 'Agent',
    labelZh: '智能体',
    gradient: 'from-violet-500 to-indigo-600',
    accent: '#8b5cf6',
    covers: [
      ['#7c3aed', '#4f46e5'],
      ['#8b5cf6', '#6366f1'],
      ['#a855f7', '#4338ca'],
      ['#6d28d9', '#2563eb'],
    ],
  },
  team: {
    label: 'Team',
    labelZh: 'AI 小队',
    gradient: 'from-cyan-500 to-blue-600',
    accent: '#06b6d4',
    covers: [
      ['#0891b2', '#2563eb'],
      ['#06b6d4', '#3b82f6'],
      ['#0e7490', '#1d4ed8'],
      ['#22d3ee', '#4f46e5'],
    ],
  },
  skill: {
    label: 'Skill',
    labelZh: '技能',
    gradient: 'from-amber-500 to-orange-600',
    accent: '#f59e0b',
    covers: [
      ['#f59e0b', '#ea580c'],
      ['#d97706', '#dc2626'],
      ['#fbbf24', '#f97316'],
      ['#f59e0b', '#b45309'],
    ],
  },
  connector: {
    label: 'Connector',
    labelZh: '连接器',
    gradient: 'from-emerald-500 to-teal-600',
    accent: '#10b981',
    covers: [
      ['#10b981', '#0d9488'],
      ['#059669', '#0891b2'],
      ['#34d399', '#14b8a6'],
      ['#16a34a', '#0f766e'],
    ],
  },
};

/** Normalize any incoming type-ish string to a known AssetType. */
export function normalizeAssetType(t?: string | null): AssetType {
  const v = (t || '').toLowerCase();
  if (v === 'team') return 'team';
  if (v === 'skill') return 'skill';
  if (v === 'connector' || v === 'mcp') return 'connector';
  return 'agent';
}

/** Stable 32-bit hash (FNV-1a) for a seed string. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Base hue per asset type. Each item derives a distinct-but-cohesive hue by
 * spreading around this base, so a wall of cards feels varied instead of a
 * monotone block of the same gradient.
 */
const TYPE_HUE: Record<AssetType, number> = {
  agent: 258,     // violet / indigo
  team: 205,      // blue / cyan
  skill: 32,      // amber / orange
  connector: 162, // emerald / teal
};

/** Pick a deterministic cover gradient (CSS) for an asset, varied by seed. */
export function assetCoverGradient(type: AssetType, seed: string): string {
  const base = TYPE_HUE[type];
  const h = hashSeed(seed);
  // Spread ±34° around the type's base hue for per-item variety.
  const hue = ((base + ((h % 68) - 34)) % 360 + 360) % 360;
  const hue2 = (hue + 22 + ((h >>> 8) % 24)) % 360;
  const angle = 120 + (h % 44);
  return `linear-gradient(${angle}deg, hsl(${hue} 72% 56%), hsl(${hue2} 66% 43%))`;
}

// A small set of on-brand geometric glyphs (inline SVG paths, 24x24 viewBox).
// Chosen deterministically so each asset gets a distinct-but-cohesive mark.
export const GLYPH_PATHS: string[] = [
  'M12 2l2.4 6.9L21 9l-5.4 4 2 7-5.6-4.1L6.4 20l2-7L3 9l6.6-.1z', // star
  'M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a6 6 0 110 12 6 6 0 010-12z', // ring
  'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', // grid
  'M12 2l9 5v10l-9 5-9-5V7z', // hexagon-ish
  'M3 12a9 9 0 019-9v9h9a9 9 0 11-18 0z', // pie
  'M6 3h12l3 6-9 12L3 9z', // gem
  'M12 3l3 6 6 .9-4.5 4.3 1 6.3L12 18l-5.5 2.5 1-6.3L3 9.9 9 9z', // sparkle-star
  'M4 12a8 8 0 018-8v4a4 4 0 00-4 4zm8 8a8 8 0 01-8-8h4a4 4 0 004 4z', // arcs
  'M12 2l7 4v12l-7 4-7-4V6z M12 6l-3 1.7v3.4L12 13l3-1.9V7.7z', // nested hex
  'M3 6h18M3 12h18M3 18h18', // lines
  'M12 2a10 10 0 100 20A6 6 0 0112 8a6 6 0 010 12', // yin
  'M12 2l4 8h-8zM4 12h16l-8 10z', // hourglass
];

export function assetGlyphPath(seed: string): string {
  return GLYPH_PATHS[hashSeed(seed + 'g') % GLYPH_PATHS.length];
}

/** True if an icon string points to an image rather than an emoji/short glyph. */
export function isImageIcon(icon?: string): boolean {
  if (!icon) return false;
  return (
    icon.startsWith('http://') ||
    icon.startsWith('https://') ||
    icon.startsWith('/') ||
    icon.startsWith('data:') ||
    /\.(png|jpe?g|gif|webp|svg)$/i.test(icon)
  );
}

/** True if an icon string is a short emoji (renderable as-is). */
export function isEmojiIcon(icon?: string): boolean {
  if (!icon) return false;
  if (isImageIcon(icon)) return false;
  // Heuristic: 1-4 codepoints, contains a non-ascii symbol
  return [...icon].length <= 4 && /\p{Extended_Pictographic}/u.test(icon);
}

/**
 * Deterministic default avatar URL for a creator/user, via DiceBear (open source, CC0 styles).
 * Uses the "thumbs" / "bottts-neutral" style set for a friendly, on-brand look.
 */
export function defaultAvatarUrl(seed: string, kind: 'user' | 'org' = 'user'): string {
  const style = kind === 'org' ? 'shapes' : 'thumbs';
  const s = encodeURIComponent(seed || 'markus');
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${s}&radius=50&backgroundType=gradientLinear`;
}

/** Format large counts compactly (e.g. 1.2k, 3.4M). */
export function formatCount(n?: number): string {
  const v = n ?? 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`.replace('.0k', 'k');
  return `${(v / 1_000_000).toFixed(1)}M`.replace('.0M', 'M');
}

/** Format a price in cents to a display string, or "Free". */
export function formatPrice(priceCents?: number, currency = 'usd'): string {
  if (!priceCents || priceCents <= 0) return 'Free';
  const symbol = currency.toLowerCase() === 'usd' ? '$' : '';
  return `${symbol}${(priceCents / 100).toFixed(priceCents % 100 === 0 ? 0 : 2)}`;
}
