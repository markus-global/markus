import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * TabScrollRail — 标签条专用的横向滚动指示轨道。
 *
 * 为什么自绘而不用原生滚动条：
 * macOS 的滚动条是「浮层（overlay）」——它画在滚动视口的**内部**底边之上。
 * 右侧栏标签条只有约 28px 高，浮层条恰好压在标签按钮的下半部分：
 * hover 时缩略块显形，点击标签下缘就会变成「拖拽滚动条」，造成误操作。
 * 原生浮层的厚度、出现时机、是否占位都由系统/浏览器决定，无法用 CSS 可靠地挪开。
 *
 * 因此这里改为：标签条保持 `scrollbar-hide`（原生条永不绘制），
 * 在标签**下方单独一行**渲染本轨道——独立布局带，结构上不可能与标签重叠；
 * 且只要有溢出就常显（原生浮层块只在滚动/hover 时闪现，可发现性差）。
 */

export type RailMetric = { left: number; width: number; viewport: number };

/** 缩略块最小宽度（轨道百分比），保证几乎占满时仍可抓取。 */
const MIN_THUMB_PCT = 8;

/**
 * 由滚动度量推导轨道的可见性与缩略块几何。
 * 纯函数，便于单测锁定口径（与 DOM 无关）。
 */
export function computeRailGeometry(m: RailMetric): {
  visible: boolean;
  leftPct: number;
  widthPct: number;
  overflow: number;
} {
  const { left, width, viewport } = m;
  const overflow = Math.max(0, width - viewport);
  if (overflow <= 0 || width <= 0 || viewport <= 0) {
    return { visible: false, leftPct: 0, widthPct: 0, overflow: 0 };
  }
  const widthPct = Math.max(MIN_THUMB_PCT, (viewport / width) * 100);
  // 夹住左边界，保证 left + width <= 100，缩略块不会越过轨道末端。
  const leftPct = Math.max(0, Math.min(100 - widthPct, (left / width) * 100));
  return { visible: true, leftPct, widthPct, overflow };
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export default function TabScrollRail({
  scrollRef,
  watch,
}: {
  /** 被观察的横向滚动容器。 */
  scrollRef: RefObject<HTMLElement | null>;
  /** 变化时重新测量（如标签数量变化）。 */
  watch?: string | number;
}) {
  const [metric, setMetric] = useState<RailMetric>({ left: 0, width: 0, viewport: 0 });
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startLeft: number } | null>(null);

  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next: RailMetric = { left: el.scrollLeft, width: el.scrollWidth, viewport: el.clientWidth };
    setMetric(prev =>
      prev.left === next.left && prev.width === next.width && prev.viewport === next.viewport ? prev : next,
    );
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    // 观察容器与每个子项的尺寸变化：标签增删/标题换行都会改变 scrollWidth。
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener('scroll', sync);
      ro.disconnect();
    };
  }, [scrollRef, sync, watch]);

  const geo = computeRailGeometry(metric);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    const track = trackRef.current;
    if (!el || !track || !geo.visible || e.button !== 0) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const thumbW = (geo.widthPct / 100) * rect.width;
    const thumbL = (geo.leftPct / 100) * rect.width;
    const x = e.clientX - rect.left;
    if (x < thumbL || x > thumbL + thumbW) {
      // 点在轨道空白处：先让缩略块中心对准点击位置，再从该处继续拖拽。
      const ratio = el.scrollWidth / rect.width;
      el.scrollLeft = clamp((x - thumbW / 2) * ratio, 0, geo.overflow);
    }
    dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startLeft: el.scrollLeft };
    try {
      track.setPointerCapture(e.pointerId);
    } catch {
      /* 指针捕获失败不影响拖拽（走冒泡路径）。 */
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const el = scrollRef.current;
    const track = trackRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !el || !track) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = el.scrollWidth / rect.width;
    el.scrollLeft = clamp(drag.startLeft + (e.clientX - drag.startX) * ratio, 0, geo.overflow);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    try {
      trackRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* 已释放。 */
    }
  };

  if (!geo.visible) return null;

  return (
    <div
      ref={trackRef}
      aria-hidden
      data-tab-scroll-rail
      className="relative h-[3px] mt-[3px] mx-1 shrink-0 rounded-full bg-border-default/30 cursor-pointer select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className="absolute top-0 h-full rounded-full bg-fg-muted/60 hover:bg-fg-secondary transition-colors"
        style={{ left: `${geo.leftPct}%`, width: `${geo.widthPct}%` }}
      />
    </div>
  );
}
