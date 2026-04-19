import { useState, useEffect, useCallback, createContext, useContext, useRef, useMemo, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.ts';

const LazyMarkdownMessage = lazy(() => import('./MarkdownMessage.tsx').then(m => ({ default: m.MarkdownMessage })));

// ─── File check cache context ────────────────────────────────────────────────

interface FileInfo {
  exists: boolean;
  isFile: boolean;
  type: string;
}

type FileCheckState = FileInfo | 'pending';

interface FileCheckContextValue {
  getFileInfo: (path: string) => FileCheckState | undefined;
  requestCheck: (path: string) => void;
}

const FileCheckContext = createContext<FileCheckContextValue | null>(null);

/**
 * Provider that batches file existence checks into a single API call.
 * Wrap the markdown renderer with this to avoid N+1 requests.
 */
export function FileCheckProvider({ children }: { children: React.ReactNode }) {
  const cacheRef = useRef<Map<string, FileCheckState>>(new Map());
  const pendingRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, forceUpdate] = useState(0);

  const flush = useCallback(() => {
    const paths = [...pendingRef.current];
    pendingRef.current.clear();
    if (paths.length === 0) return;

    api.files.check(paths).then(({ results }) => {
      for (const [p, info] of Object.entries(results)) {
        cacheRef.current.set(p, info);
      }
      forceUpdate(n => n + 1);
    }).catch(() => {
      for (const p of paths) {
        cacheRef.current.set(p, { exists: false, isFile: false, type: 'unknown' });
      }
      forceUpdate(n => n + 1);
    });
  }, []);

  const requestCheck = useCallback((path: string) => {
    if (cacheRef.current.has(path)) return;
    cacheRef.current.set(path, 'pending');
    pendingRef.current.add(path);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flush, 50);
  }, [flush]);

  const getFileInfo = useCallback((path: string) => {
    return cacheRef.current.get(path);
  }, []);

  const value = useMemo(() => ({ getFileInfo, requestCheck }), [getFileInfo, requestCheck]);

  return (
    <FileCheckContext.Provider value={value}>
      {children}
    </FileCheckContext.Provider>
  );
}

// ─── File path detection ─────────────────────────────────────────────────────

const FILE_PATH_RE = /^(?:\/[\w.\-@+]+(?:\/[\w.\-@+ ]*)*|~\/[\w.\-@+]+(?:\/[\w.\-@+ ]*)*|[A-Z]:\\[\w.\-@+ ]+(?:\\[\w.\-@+ ]*)*|\.\.?\/[\w.\-@+]+(?:\/[\w.\-@+ ]*)*)$/;

export function looksLikeFilePath(text: string): boolean {
  if (text.length < 2 || text.length > 500) return false;
  return FILE_PATH_RE.test(text);
}

// ─── File preview modal ──────────────────────────────────────────────────────

function FilePreviewModal({ filePath, onClose }: { filePath: string; onClose: () => void }) {
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

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const displayName = fileName || filePath.split(/[/\\]/).pop() || filePath;

  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={onClose}>
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
  const ctx = useContext(FileCheckContext);
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  useEffect(() => {
    ctx?.requestCheck(filePath);
  }, [ctx, filePath]);

  const info = ctx?.getFileInfo(filePath);
  const isPending = info === 'pending' || info === undefined;
  const exists = !isPending && info.exists;
  const isMarkdown = !isPending && info.type === 'markdown';

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

  const baseName = filePath.split(/[/\\]/).pop() || filePath;
  const dirPart = filePath.slice(0, filePath.length - baseName.length);

  if (isPending) {
    return (
      <code className="bg-surface-secondary px-1.5 py-0.5 rounded text-xs font-mono text-fg-secondary break-all">
        {filePath}
      </code>
    );
  }

  if (!exists) {
    return (
      <code
        className="bg-surface-secondary/50 px-1.5 py-0.5 rounded text-xs font-mono text-fg-tertiary break-all border border-border-default/30 line-through decoration-fg-tertiary/30"
        title="File not found"
      >
        {filePath}
      </code>
    );
  }

  return (
    <>
      <code
        className="inline-flex items-center gap-1 bg-brand-500/10 px-1.5 py-0.5 rounded text-xs font-mono text-brand-500 break-all cursor-pointer hover:bg-brand-500/20 transition-colors border border-brand-500/20 hover:border-brand-500/40"
        onClick={handleClick}
        title={isMarkdown ? 'Click to preview' : 'Click to reveal in file explorer'}
        role="button"
        tabIndex={0}
      >
        <svg className="w-3 h-3 shrink-0 inline-block" viewBox="0 0 20 20" fill="currentColor">
          {isMarkdown ? (
            <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
          ) : (
            <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
          )}
        </svg>
        <span className="text-fg-tertiary">{dirPart}</span><span>{baseName}</span>
      </code>
      {previewPath && <FilePreviewModal filePath={previewPath} onClose={() => setPreviewPath(null)} />}
    </>
  );
}
