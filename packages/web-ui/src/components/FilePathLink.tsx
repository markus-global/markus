import { useState, useEffect, useCallback, useRef, useSyncExternalStore, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.ts';
import type { DirectoryEntry } from '../api.ts';
import { useLayout } from '../contexts/LayoutContext.tsx';
import { DirectoryPreview } from './DirectoryPreview.tsx';
import { OfficePreviewer } from './OfficePreviewer.tsx';

const LazyMarkdownMessage = lazy(() => import('./MarkdownMessage.tsx').then(m => ({ default: m.MarkdownMessage })));
const LazyContentRenderer = lazy(() => import('./ContentRenderer.tsx').then(m => ({ default: m.ContentRenderer })));

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

const FILE_CACHE_MAX = 500;
const fileCache = new Map<string, FileInfo>();
const pendingPaths = new Set<string>();
const subscribers = new Map<string, Set<() => void>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function evictOldestEntries() {
  if (fileCache.size <= FILE_CACHE_MAX) return;
  const toRemove = fileCache.size - FILE_CACHE_MAX;
  const iter = fileCache.keys();
  for (let i = 0; i < toRemove; i++) {
    const { value, done } = iter.next();
    if (done) break;
    fileCache.delete(value);
  }
}

function cacheSet(path: string, info: FileInfo) {
  // Move to end (most recently used) by re-inserting
  fileCache.delete(path);
  fileCache.set(path, info);
  evictOldestEntries();
}

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
      cacheSet(p, info);
      notifyPath(p);
    }
  }).catch(() => {
    for (const p of batch) {
      cacheSet(p, { exists: false, isFile: false, type: 'unknown' });
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

const FILE_PATH_RE = /^(?:\/[\w.\-@+]+(?:\/[\w.\-@+ ]*)*|~\/[\w.\-@+]+(?:\/[\w.\-@+ ]*)*|[A-Za-z]:(?:\\|\/)[\w.\-@+ ]+(?:(?:\\|\/)[\w.\-@+ ]*)*|\.\.?\/[\w.\-@+]+(?:\/[\w.\-@+ ]*)*)$/;

export function looksLikeFilePath(text: string): boolean {
  if (text.length < 2 || text.length > 500) return false;
  return FILE_PATH_RE.test(text);
}

function parentDir(p: string): string {
  const sep = p.includes('\\') ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  if (idx <= 0) return sep === '/' ? '/' : p.slice(0, 2);
  return p.slice(0, idx);
}

// ─── File preview modal ──────────────────────────────────────────────────────

function FilePreviewModal({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const zIndex = useModalStack(onClose);
  // Navigation cursor — starts at the link's path; subdir/file clicks update it
  // so the modal browses inside the directory without leaving the modal.
  const [activePath, setActivePath] = useState(filePath);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [fileType, setFileType] = useState('');
  const [fileName, setFileName] = useState('');
  const [mimeType, setMimeType] = useState('');
  const [streamUrl, setStreamUrl] = useState('');
  const [dirEntries, setDirEntries] = useState<DirectoryEntry[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent('');
    setDirEntries(null);
    api.files.preview(activePath).then((data) => {
      if (data.type === 'directory' && Array.isArray(data.entries)) {
        setFileType('directory');
        setFileName(data.name);
        setDirEntries(data.entries);
        return;
      }
      setFileType(data.type);
      setFileName(data.name);
      setMimeType(data.mimeType || '');
      setContent(typeof data.content === 'string' ? data.content : '');
      setStreamUrl(
        data.streamUrl
        || (data.path ? api.files.streamUrl(data.path) : '')
        || (data.type === 'audio' || data.type === 'video' ? api.files.streamUrl(activePath) : ''),
      );
    }).catch((err) => {
      setError(String(err?.message || err));
    }).finally(() => {
      setLoading(false);
    });
  }, [activePath]);

  const displayName = fileName || activePath.split(/[/\\]/).pop() || activePath;
  const dirNavEnabled = fileType === 'directory' || activePath !== filePath;
  const backToDir = () => setActivePath((prev) => parentDir(prev));
  const copyPath = () => {
    navigator.clipboard?.writeText(activePath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return createPortal(
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center" style={{ zIndex }} onClick={onClose}>
      <div
        className="bg-surface-secondary border border-border-default rounded-xl shadow-2xl w-[90vw] max-w-3xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-default bg-surface-elevated/50 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {fileType === 'directory' && (
              <svg className="w-4 h-4 shrink-0 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                <path d="M3.5 3A1.5 1.5 0 002 4.5v11A1.5 1.5 0 003.5 17h13a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0016.5 6h-6.53a.5.5 0 01-.354-.146L8.706 4.854A1.5 1.5 0 007.586 4H3.5z" />
              </svg>
            )}
            {fileType !== 'directory' && (
              <svg className="w-4 h-4 shrink-0 text-fg-secondary" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
              </svg>
            )}
            <span className="text-sm font-medium text-fg-primary truncate">{displayName}</span>
            <span className="text-xs text-fg-tertiary truncate hidden sm:inline">{activePath}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {dirNavEnabled && (
              <button
                className="text-xs text-fg-secondary hover:text-fg-primary px-2 py-1 rounded hover:bg-surface-elevated transition-colors"
                onClick={backToDir}
                title="返回上级目录"
              >
                ← 上级
              </button>
            )}
            <button
              className="text-xs text-fg-secondary hover:text-fg-primary px-2 py-1 rounded hover:bg-surface-elevated transition-colors"
              onClick={copyPath}
              title="复制路径"
            >
              {copied ? '✓ 已复制' : '复制路径'}
            </button>
            <button
              className="text-xs text-fg-secondary hover:text-fg-primary px-2 py-1 rounded hover:bg-surface-elevated transition-colors"
              onClick={() => api.files.reveal(activePath)}
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
          {!loading && !error && fileType === 'directory' && dirEntries && (
            <DirectoryPreview
              path={activePath}
              entries={dirEntries}
              onNavigate={(p) => setActivePath(p)}
              onOpenFile={(p) => setActivePath(p)}
              onReveal={(p) => api.files.reveal(p)}
              onCopyPath={(p) => {
                navigator.clipboard?.writeText(p).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }).catch(() => {});
              }}
            />
          )}
          {!loading && !error && fileType === 'office' && streamUrl && (
            <OfficePreviewer
              data={{
                format: (activePath.split('.').pop() || 'pdf').toLowerCase(),
                streamUrl,
                name: displayName,
              }}
              reference={activePath}
              onFallback={() => void api.files.reveal(activePath)}
            />
          )}
          {!loading && !error && fileType === 'image' && content && (
            <div className="flex justify-center">
              <img src={`data:${mimeType || 'image/png'};base64,${content}`} alt={displayName} className="max-w-full rounded" />
            </div>
          )}
          {!loading && !error && fileType === 'audio' && streamUrl && (
            <audio controls preload="metadata" src={streamUrl} className="w-full" />
          )}
          {!loading && !error && fileType === 'video' && streamUrl && (
            <video controls preload="metadata" src={streamUrl} className="w-full max-h-[60vh] rounded-lg bg-black" />
          )}
          {!loading && !error && (fileType === 'binary' || (!content && fileType !== 'image' && fileType !== 'audio' && fileType !== 'video' && fileType !== 'directory')) && (
            <div className="text-center py-8 space-y-3">
              <p className="text-sm text-fg-secondary">This file type cannot be previewed.</p>
              <button
                className="px-3 py-2 text-xs rounded-lg bg-brand-600/20 text-brand-500 hover:bg-brand-600/30 transition-colors"
                onClick={() => void api.files.reveal(activePath)}
              >
                Reveal in file explorer
              </button>
            </div>
          )}
          {!loading && !error && content && fileType !== 'image' && fileType !== 'audio' && fileType !== 'video' && fileType !== 'binary' && fileType !== 'directory' && (
            <Suspense fallback={<div className="text-xs text-fg-tertiary">Loading…</div>}>
              <LazyContentRenderer content={content} format={fileType === 'text' ? 'text' : fileType} className="text-sm" />
            </Suspense>
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
  const layout = useLayout();

  const exists = info?.exists ?? false;
  const isPreviewable = info?.type === 'markdown' || info?.type === 'html' || info?.type === 'json'
    || info?.type === 'text' || info?.type === 'image' || info?.type === 'audio' || info?.type === 'video'
    || info?.type === 'office' || info?.type === 'directory';

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!exists) return;
    if (isPreviewable) {
      // Prefer the right-side panel when the active page hosts one; else modal.
      if (layout?.hostAvailable) { layout.openRightPanel({ kind: 'file', path: filePath }); return; }
      setPreviewPath(filePath);
    } else {
      api.files.reveal(filePath);
    }
  }, [exists, isPreviewable, filePath, layout]);

  const iconCls = 'inline w-3 h-3 align-[-0.125em]';
  const fileIcon = isPreviewable
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
        title={isPreviewable ? 'Click to preview' : 'Click to reveal in file explorer'}
        role="button"
        tabIndex={0}
      ><span className="whitespace-nowrap">{fileIcon}{filePath.charAt(0)}</span>{filePath.slice(1)}</code>
      {previewPath && <FilePreviewModal filePath={previewPath} onClose={() => setPreviewPath(null)} />}
    </>
  );
}
