import { useState, useEffect, useCallback, useRef, useSyncExternalStore, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.ts';

const LazyMarkdownMessage = lazy(() => import('./MarkdownMessage.tsx').then(m => ({ default: m.MarkdownMessage })));

// ─── Modal stack for nested preview modals ───────────────────────────────────

let modalCloseStack: (() => void)[] = [];
let modalZCounter = 60;

function useModalStack(onClose: () => void) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [zIndex] = useState(() => ++modalZCounter);

  useEffect(() => {
    const closeFn = () => closeRef.current();
    modalCloseStack.push(closeFn);

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalCloseStack[modalCloseStack.length - 1] === closeFn) {
        e.preventDefault();
        closeFn();
      }
    };
    window.addEventListener('keydown', handleKey, true);
    return () => {
      window.removeEventListener('keydown', handleKey, true);
      modalCloseStack = modalCloseStack.filter(fn => fn !== closeFn);
      if (modalCloseStack.length === 0) modalZCounter = 60;
    };
  }, []);

  return zIndex;
}

// ─── Global file-check store (singleton) ─────────────────────────────────────
// Replaces per-message Context providers. All FilePathLink components across
// the entire app share one cache and one batched API call queue. Each component
// subscribes only to its own path via useSyncExternalStore, so cache updates
// never cause unrelated re-renders.

interface FileInfo {
  exists: boolean;
  isFile: boolean;
  type: string;
}

const fileCache = new Map<string, FileInfo>();
const pendingPaths = new Set<string>();
const subscribers = new Map<string, Set<() => void>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function notifyPath(path: string) {
  const subs = subscribers.get(path);
  if (subs) for (const fn of subs) fn();
}

function flush() {
  flushTimer = null;
  const batch = [...pendingPaths];
  pendingPaths.clear();
  if (batch.length === 0) return;

  api.files.check(batch).then(({ results }) => {
    for (const [p, info] of Object.entries(results)) {
      fileCache.set(p, info);
      notifyPath(p);
    }
  }).catch(() => {
    for (const p of batch) {
      fileCache.set(p, { exists: false, isFile: false, type: 'unknown' });
      notifyPath(p);
    }
  });
}

function requestFileCheck(path: string) {
  if (fileCache.has(path) || pendingPaths.has(path)) return;
  pendingPaths.add(path);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 30);
}

function subscribeToPath(path: string, cb: () => void) {
  let set = subscribers.get(path);
  if (!set) { set = new Set(); subscribers.set(path, set); }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) subscribers.delete(path);
  };
}

function useFileInfo(path: string): FileInfo | undefined {
  const subscribe = useCallback((cb: () => void) => subscribeToPath(path, cb), [path]);
  const getSnapshot = useCallback(() => fileCache.get(path), [path]);
  const info = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => { requestFileCheck(path); }, [path]);

  return info;
}

// ─── File path detection ─────────────────────────────────────────────────────

const FILE_PATH_RE = /^(?:\/[\w.\-@+]+(?:\/[\w.\-@+ ]*)*|~\/[\w.\-@+]+(?:\/[\w.\-@+ ]*)*|[A-Z]:\\[\w.\-@+ ]+(?:\\[\w.\-@+ ]*)*|\.\.?\/[\w.\-@+]+(?:\/[\w.\-@+ ]*)*)$/;

export function looksLikeFilePath(text: string): boolean {
  if (text.length < 2 || text.length > 500) return false;
  return FILE_PATH_RE.test(text);
}

// ─── File preview modal ──────────────────────────────────────────────────────

function FilePreviewModal({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const zIndex = useModalStack(onClose);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [fileType, setFileType] = useState('');
  const [fileName, setFileName] = useState('');

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.files.preview(filePath).then((data) => {
      setContent(data.content);
      setFileType(data.type);
      setFileName(data.name);
    }).catch((err) => {
      setError(String(err?.message || err));
    }).finally(() => {
      setLoading(false);
    });
  }, [filePath]);

  const displayName = fileName || filePath.split(/[/\\]/).pop() || filePath;

  return createPortal(
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center" style={{ zIndex }} onClick={onClose}>
      <div
        className="bg-surface-secondary border border-border-default rounded-xl shadow-2xl w-[90vw] max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default bg-surface-elevated/50 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <svg className="w-4 h-4 shrink-0 text-fg-secondary" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
            </svg>
            <span className="text-sm font-medium text-fg-primary truncate">{displayName}</span>
            <span className="text-xs text-fg-tertiary truncate hidden sm:inline">{filePath}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className="text-xs text-fg-secondary hover:text-fg-primary px-2 py-1 rounded hover:bg-surface-elevated transition-colors"
              onClick={() => api.files.reveal(filePath)}
              title="Reveal in file explorer"
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path d="M4.5 17a2.5 2.5 0 01-2.5-2.5v-9A2.5 2.5 0 014.5 3h3.672a1.5 1.5 0 011.06.44L10.56 4.77a.5.5 0 00.354.147H15.5A2.5 2.5 0 0118 7.417v7.083A2.5 2.5 0 0115.5 17h-11z" />
              </svg>
            </button>
            <button
              className="text-fg-secondary hover:text-fg-primary p-1 rounded hover:bg-surface-elevated transition-colors"
              onClick={onClose}
            >
              <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-brand-500/30 border-t-brand-500 rounded-full animate-spin" />
            </div>
          )}
          {error && (
            <div className="text-center py-12 text-fg-secondary text-sm">
              <p className="text-red-400 mb-1">Failed to load file</p>
              <p className="text-xs text-fg-tertiary">{error}</p>
            </div>
          )}
          {!loading && !error && fileType === 'markdown' && (
            <Suspense fallback={<div className="text-xs text-fg-tertiary">Loading…</div>}>
              <LazyMarkdownMessage content={content} className="text-sm" />
            </Suspense>
          )}
          {!loading && !error && fileType === 'image' && (
            <div className="flex justify-center">
              <img src={`data:image/png;base64,${content}`} alt={displayName} className="max-w-full rounded" />
            </div>
          )}
          {!loading && !error && fileType === 'text' && (
            <pre className="text-xs text-fg-secondary font-mono whitespace-pre-wrap break-all leading-relaxed">{content}</pre>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── FilePathLink component ──────────────────────────────────────────────────

export function FilePathLink({ path: filePath }: { path: string }) {
  const info = useFileInfo(filePath);
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  const exists = info?.exists ?? false;
  const isMarkdown = info?.type === 'markdown';

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!exists) return;
    if (isMarkdown) {
      setPreviewPath(filePath);
    } else {
      api.files.reveal(filePath);
    }
  }, [exists, isMarkdown, filePath]);

  const iconCls = 'inline w-3 h-3 align-[-0.125em]';
  const fileIcon = isMarkdown
    ? <svg className={iconCls} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" /></svg>
    : <svg className={iconCls} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" /></svg>;

  if (!info) {
    return <code className="bg-surface-secondary px-1.5 py-0.5 rounded text-xs font-mono text-fg-secondary break-all">{filePath}</code>;
  }

  if (!exists) {
    return (
      <code className="bg-surface-secondary/50 px-1.5 py-0.5 rounded text-xs font-mono text-fg-tertiary border border-border-default/30 line-through decoration-fg-tertiary/30 break-all" title="File not found">
        {filePath}
      </code>
    );
  }

  return (
    <>
      <code
        className="bg-brand-500/10 px-1.5 py-0.5 rounded text-xs font-mono text-brand-500 cursor-pointer hover:bg-brand-500/20 transition-colors border border-brand-500/20 hover:border-brand-500/40 break-all"
        onClick={handleClick}
        title={isMarkdown ? 'Click to preview' : 'Click to reveal in file explorer'}
        role="button"
        tabIndex={0}
      ><span className="whitespace-nowrap">{fileIcon}{filePath.charAt(0)}</span>{filePath.slice(1)}</code>
      {previewPath && <FilePreviewModal filePath={previewPath} onClose={() => setPreviewPath(null)} />}
    </>
  );
}
