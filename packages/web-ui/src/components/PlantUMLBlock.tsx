import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
// Vite resolves the bare specifier and returns a URL to the asset
// @ts-expect-error Vite ?url import
import vizGlobalUrl from '@plantuml/core/viz-global.js?url';

type RenderToString = (
  lines: string[],
  onSuccess: (svg: string) => void,
  onError: (msg: string) => void,
  options?: { dark?: boolean },
) => void;

let vizLoaded = false;
let enginePromise: Promise<{ renderToString: RenderToString }> | null = null;

function loadVizScript(): Promise<void> {
  if (vizLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-plantuml-viz]');
    if (existing) {
      if ((globalThis as Record<string, unknown>).Viz) {
        vizLoaded = true;
        resolve();
      } else {
        existing.addEventListener('load', () => { vizLoaded = true; resolve(); });
        existing.addEventListener('error', () => reject(new Error('Failed to load viz-global.js')));
      }
      return;
    }
    const script = document.createElement('script');
    script.setAttribute('data-plantuml-viz', '');
    script.src = vizGlobalUrl;
    script.onload = () => { vizLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Failed to load viz-global.js'));
    document.head.appendChild(script);
  });
}

function loadEngine(): Promise<{ renderToString: RenderToString }> {
  if (!enginePromise) {
    enginePromise = loadVizScript().then(() =>
      import('@plantuml/core') as Promise<{ renderToString: RenderToString }>,
    );
  }
  return enginePromise;
}

let renderQueue = Promise.resolve();

function enqueueRender(
  code: string,
  dark: boolean,
): Promise<string> {
  const job = renderQueue.then(
    () =>
      new Promise<string>((resolve, reject) => {
        loadEngine()
          .then(({ renderToString }) => {
            const lines = code.split(/\r\n|\r|\n/);
            renderToString(lines, resolve, reject, { dark });
          })
          .catch(reject);
      }),
  );
  renderQueue = job.then(() => {}, () => {});
  return job;
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

function useIsDarkMode(): boolean {
  return useSyncExternalStore(subscribeToTheme, () => isDarkMode());
}

export function PlantUMLBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const renderedRef = useRef<{ code: string; dark: boolean } | null>(null);
  const dark = useIsDarkMode();

  useEffect(() => {
    if (!code.trim()) return;
    if (renderedRef.current && renderedRef.current.code === code && renderedRef.current.dark === dark) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    enqueueRender(code.trim(), dark)
      .then(result => {
        if (!cancelled) {
          setSvg(result);
          renderedRef.current = { code, dark };
        }
      })
      .catch(e => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [code, dark]);

  if (error) {
    return (
      <div className="my-2 rounded-lg overflow-hidden border border-red-500/30">
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 border-b border-red-500/20">
          <svg className="w-3.5 h-3.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span className="text-[10px] font-medium text-red-400">PlantUML render error</span>
        </div>
        <pre className="p-3 bg-surface-secondary text-xs text-fg-secondary overflow-x-auto font-mono">{code}</pre>
      </div>
    );
  }

  return (
    <div className="not-prose my-2 rounded-lg bg-surface-secondary border border-border-subtle p-4 overflow-x-auto">
      {loading && (
        <div className="flex items-center gap-2 text-xs text-fg-tertiary">
          <div className="w-4 h-4 border-2 border-fg-tertiary/30 border-t-fg-tertiary rounded-full animate-spin" />
          Rendering diagram…
        </div>
      )}
      {svg && (
        <div
          className={`flex justify-center [&>svg]:max-w-full${loading ? ' hidden' : ''}`}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
    </div>
  );
}
