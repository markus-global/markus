import { useState, useCallback, useEffect, useRef } from 'react';

interface UseResizablePanelOptions {
  side: 'left' | 'right';
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  collapsedWidth?: number;
  storageKey: string;
}

export function useResizablePanel({
  side,
  defaultWidth,
  minWidth,
  maxWidth,
  collapsedWidth = 0,
  storageKey,
}: UseResizablePanelOptions) {
  const [width, setWidth] = useState(() => {
    try {
      const saved = localStorage.getItem(`${storageKey}_w`);
      if (saved) return Math.max(minWidth, Math.min(maxWidth, parseInt(saved, 10)));
    } catch { /* ignore */ }
    return defaultWidth;
  });

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(`${storageKey}_c`) === '1'; }
    catch { return false; }
  });

  const dragging = useRef(false);
  const minRef = useRef(minWidth);
  const maxRef = useRef(maxWidth);
  minRef.current = minWidth;
  maxRef.current = maxWidth;

  useEffect(() => {
    try { localStorage.setItem(`${storageKey}_w`, String(width)); } catch { /* ignore */ }
  }, [width, storageKey]);

  useEffect(() => {
    try { localStorage.setItem(`${storageKey}_c`, collapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [collapsed, storageKey]);

  useEffect(() => {
    setWidth(w => Math.max(minWidth, Math.min(maxWidth, w)));
  }, [minWidth, maxWidth]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startW = width;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const diff = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      setWidth(Math.max(minRef.current, Math.min(maxRef.current, startW + diff)));
    };

    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [width, side]);

  const toggle = useCallback(() => setCollapsed(v => !v), []);

  return {
    width: collapsed ? collapsedWidth : width,
    rawWidth: width,
    collapsed,
    toggle,
    setCollapsed,
    setWidth,
    onResizeStart,
  };
}
