import { useEffect, useRef, useState, useId, useSyncExternalStore } from 'react';

let mermaidPromise: Promise<typeof import('mermaid')> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(m => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        fontFamily: 'inherit',
      });
      return m;
    });
  }
  return mermaidPromise;
}

function isDarkMode(): boolean {
  const html = document.documentElement;
  if (html.classList.contains('light')) return false;
  if (html.classList.contains('dark') || html.classList.contains('cyberpunk') || html.classList.contains('mono')) return true;
  return !window.matchMedia('(prefers-color-scheme: light)').matches;
}

function subscribeToTheme(cb: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', cb);
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => { mq.removeEventListener('change', cb); observer.disconnect(); };
}

function getThemeSnapshot(): boolean {
  return isDarkMode();
}

function useIsDarkMode(): boolean {
  return useSyncExternalStore(subscribeToTheme, getThemeSnapshot);
}

export function MermaidBlock({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const renderIdBase = useId();
  const renderCountRef = useRef(0);
  const renderedRef = useRef<{ code: string; dark: boolean } | null>(null);
  const dark = useIsDarkMode();

  useEffect(() => {
    if (!code.trim()) return;
    if (renderedRef.current && renderedRef.current.code === code && renderedRef.current.dark === dark) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    renderCountRef.current += 1;

    (async () => {
      try {
        const mermaid = await loadMermaid();
        if (cancelled) return;

        mermaid.default.initialize({
          startOnLoad: false,
          theme: dark ? 'dark' : 'default',
          securityLevel: 'loose',
          fontFamily: 'inherit',
        });

        const id = `mermaid-${renderIdBase.replace(/:/g, '')}-${renderCountRef.current}`;
        const { svg } = await mermaid.default.render(id, code.trim());
        if (cancelled) return;

        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
          renderedRef.current = { code, dark };
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [code, renderIdBase, dark]);

  if (error) {
    return (
      <div className="my-2 rounded-lg overflow-hidden border border-red-500/30">
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 border-b border-red-500/20">
          <svg className="w-3.5 h-3.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span className="text-[10px] font-medium text-red-400">Mermaid render error</span>
        </div>
        <pre className="p-3 bg-surface-secondary text-xs text-fg-secondary overflow-x-auto font-mono">{code}</pre>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg bg-surface-secondary border border-border-subtle p-4 overflow-x-auto">
      {loading && (
        <div className="flex items-center gap-2 text-xs text-fg-tertiary">
          <div className="w-4 h-4 border-2 border-fg-tertiary/30 border-t-fg-tertiary rounded-full animate-spin" />
          Rendering diagram…
        </div>
      )}
      <div
        ref={containerRef}
        className={`flex justify-center [&>svg]:max-w-full${loading ? ' hidden' : ''}`}
      />
    </div>
  );
}
