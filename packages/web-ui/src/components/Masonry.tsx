import { Children, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Flex-based masonry / waterfall.
 *
 * We deliberately avoid CSS `column-count` here: in Chromium/Electron, a
 * multi-column child that uses `overflow:hidden` with an absolutely-positioned
 * full-bleed image (our cover cards) is mis-painted or dropped entirely. A
 * flex column layout renders every card — including full-bleed image cards —
 * correctly while still packing cards tightly by their natural height.
 *
 * The column count is derived from the container width so each card stays
 * within a comfortable reading width (~a phone screen) and wider viewports
 * simply get more columns instead of stretching the cards.
 */
export function Masonry({
  children,
  maxCardWidth = 400,
  gap = '1rem',
  className = '',
}: {
  children: ReactNode;
  /** cap each card at roughly this width (px); more columns are added as needed */
  maxCardWidth?: number;
  gap?: string;
  className?: string;
  /** @deprecated kept for call-site compatibility; column count is now width-driven */
  columns?: 2 | 3;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = Math.max(1, Math.ceil((width || maxCardWidth) / maxCardWidth));
  const items = Children.toArray(children);
  const cols: ReactNode[][] = Array.from({ length: n }, () => []);
  items.forEach((child, i) => { cols[i % n]!.push(child); });

  return (
    <div ref={ref} className={`flex items-start ${className}`} style={{ gap }}>
      {cols.map((col, i) => (
        <div key={i} className="flex flex-col flex-1 min-w-0" style={{ gap, maxWidth: maxCardWidth }}>
          {col}
        </div>
      ))}
    </div>
  );
}
