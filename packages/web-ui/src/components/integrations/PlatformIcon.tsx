/**
 * Platform glyphs for the Integrations list.
 *
 * Collapsed cards show an icon so a platform is recognisable at a glance; brand
 * colours do the heavy lifting. The glyphs are deliberately simple **line**
 * icons in the brand colour (not the vendors' full logos): they render crisply
 * at 20px, need no assets, and ship no third-party trademark artwork.
 *
 * An unknown platform id falls back to a neutral chat glyph in a neutral colour
 * — so a platform added purely on the backend still gets a sensible collapsed
 * row (the "zero UI code" promise holds), it simply is not branded until an
 * entry is added here.
 */
import type { ReactNode } from 'react';

interface Brand {
  /** Tile tint (background). */
  color: string;
  /** The 20×20 line glyph, drawn with `currentColor`. */
  glyph: ReactNode;
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const GENERIC: Brand = {
  color: '#64748b',
  glyph: (
    <g {...stroke}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" />
    </g>
  ),
};

const BRANDS: Readonly<Record<string, Brand>> = {
  feishu: {
    color: '#3370ff',
    glyph: (
      <g {...stroke}>
        <path d="M21 5 3 11l5.5 2.2L19 7l-7.5 8.3L12 21l3-4.5L21 5z" />
      </g>
    ),
  },
  telegram: {
    color: '#229ed9',
    glyph: (
      <g {...stroke}>
        <path d="M22 3 2.5 10.5l5.5 2L21 6l-9 10v5l3.5-4.5L20 19 22 3z" />
      </g>
    ),
  },
  slack: {
    color: '#611f69',
    glyph: (
      <g {...stroke}>
        <path d="M9.5 3 7.5 20M16.5 4 14.5 21M3.5 9h17M2.5 15h17" />
      </g>
    ),
  },
  whatsapp: {
    color: '#1faa59',
    glyph: (
      <g {...stroke}>
        <path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20.5l1.6-5.3A8.5 8.5 0 1 1 21 11.5z" />
        <path d="M9 8.8c.3 2.6 2.6 4.9 5.2 5.2l1-1.3 1.9.8" />
      </g>
    ),
  },
  discord: {
    color: '#5865f2',
    glyph: (
      <g {...stroke}>
        <rect x="3" y="7" width="18" height="10" rx="4.5" />
        <path d="M7.5 11.5h3M9 10v3" />
        <circle cx="15" cy="10.7" r="0.9" />
        <circle cx="17.3" cy="13" r="0.9" />
      </g>
    ),
  },
};

export function platformBrand(id: string): Brand {
  return BRANDS[id] ?? GENERIC;
}

/** True when the id has a dedicated brand entry (unknown ids use the fallback). */
export function hasBrand(id: string): boolean {
  return id in BRANDS;
}

export function PlatformIcon({ id, size = 36 }: { id: string; size?: number }) {
  const brand = platformBrand(id);
  return (
    <span
      className="shrink-0 inline-flex items-center justify-center rounded-lg"
      style={{ width: size, height: size, backgroundColor: `${brand.color}1a`, color: brand.color }}
      aria-hidden="true"
      data-testid={`platform-icon-${id}`}
    >
      <svg width={Math.round(size * 0.58)} height={Math.round(size * 0.58)} viewBox="0 0 24 24">
        {brand.glyph}
      </svg>
    </span>
  );
}
