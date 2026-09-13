import { useMemo, useState } from 'react';
import type { DirectoryEntry } from '../api.ts';

function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Split an absolute path into segments while preserving the root/drive prefix. */
function splitPath(path: string): { segments: string[]; root: string } {
  const sep = path.includes('\\') ? '\\' : '/';
  if (sep === '/') {
    const parts = path.split('/').filter(Boolean);
    return { segments: parts, root: '/' };
  }
  // Windows drive path e.g. C:\foo\bar
  const match = path.match(/^([A-Za-z]:\\)(.*)$/);
  if (match) {
    const parts = match[2].split('\\').filter(Boolean);
    return { segments: parts, root: match[1] };
  }
  return { segments: path.split('\\').filter(Boolean), root: '' };
}

function joinPath(root: string, segments: string[], sep: string): string {
  if (segments.length === 0) return root || '.';
  const body = segments.join(sep);
  if (sep === '/') return root === '/' ? `/${body}` : `${root}${body}`;
  return `${root}${body}`;
}

const FILE_EXT_BADGE: Record<string, string> = {
  md: 'MD', markdown: 'MD', html: 'HTML', htm: 'HTML', json: 'JSON', csv: 'CSV',
  pdf: 'PDF', docx: 'DOCX', doc: 'DOC', xlsx: 'XLSX', xls: 'XLS', pptx: 'PPTX', ppt: 'PPT',
  txt: 'TXT', ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX', py: 'PY', css: 'CSS',
};

const MEDIA_EXT: Record<string, string> = {
  png: 'IMG', jpg: 'IMG', jpeg: 'IMG', gif: 'IMG', webp: 'IMG', svg: 'IMG', bmp: 'IMG', ico: 'IMG', avif: 'IMG',
  mp3: 'AUDIO', wav: 'AUDIO', ogg: 'AUDIO', flac: 'AUDIO', aac: 'AUDIO', m4a: 'AUDIO',
  mp4: 'VIDEO', webm: 'VIDEO', mov: 'VIDEO', mkv: 'VIDEO', avi: 'VIDEO', m4v: 'VIDEO',
};

export function prettyTypeLabel(ext?: string, isDirectory = false): string {
  if (isDirectory) return '目录';
  if (!ext) return '文件';
  const e = ext.replace(/^\./, '').toLowerCase();
  if (MEDIA_EXT[e]) return MEDIA_EXT[e];
  if (FILE_EXT_BADGE[e]) return FILE_EXT_BADGE[e];
  return e.slice(0, 6).toUpperCase() || '文件';
}

interface DirectoryPreviewProps {
  path: string;
  entries: DirectoryEntry[];
  onNavigate: (dirPath: string) => void;
  onOpenFile: (filePath: string) => void;
  onReveal?: (path: string) => void;
  onCopyPath?: (path: string) => void;
  emptyText?: string;
}

export function DirectoryPreview({
  path, entries, onNavigate, onOpenFile, onReveal, onCopyPath, emptyText,
}: DirectoryPreviewProps) {
  const { segments, root } = useMemo(() => splitPath(path), [path]);
  const sep = path.includes('\\') ? '\\' : '/';
  const [copied, setCopied] = useState(false);

  const handleCopyPath = async () => {
    const r = onCopyPath?.(path) as unknown;
    try {
      // 若父组件返回 Promise（如 Deliverables 的 async copyPath），等待其明确失败才不显示成功
      if (r && typeof (r as Promise<boolean>).then === 'function') {
        const ok = await (r as Promise<boolean | void>);
        if (ok === false) return;
      }
    } catch {
      return; // 复制异常（如剪贴板权限）由父组件兜底提示，这里不误报成功
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const crumbs = useMemo(() => {
    const list: Array<{ label: string; path: string }> = [];
    if (root) list.push({ label: root.replace(/[\\/]$/, ''), path: root });
    let acc = root;
    for (let i = 0; i < segments.length; i++) {
      acc = joinPath(root, segments.slice(0, i + 1), sep);
      list.push({ label: segments[i], path: acc });
    }
    return list;
  }, [root, segments, sep]);

  return (
    <div className="flex flex-col min-h-0 h-full">
      {/* Top row: full path + external actions (copy / open in file browser) */}
      {(onReveal || onCopyPath) && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle bg-surface-secondary/50 shrink-0" data-testid="dir-top-actions">
          <span className="flex-1 min-w-0 text-[11px] font-mono text-fg-tertiary truncate" title={path}>{path}</span>
          {onCopyPath && (
            <button
              className={`shrink-0 text-[11px] cursor-pointer transition-colors ${copied ? 'text-green-500 font-medium' : 'text-fg-secondary hover:text-fg-primary hover:underline'}`}
              onClick={() => void handleCopyPath()}
              title={copied ? '已复制' : '复制路径'}
            >
              {copied ? '✓ 已复制' : '复制路径'}
            </button>
          )}
          {onReveal && (
            <button
              className="shrink-0 text-[11px] text-fg-secondary hover:text-fg-primary hover:underline cursor-pointer"
              onClick={() => onReveal(path)}
            >
              在文件浏览器中显示
            </button>
          )}
        </div>
      )}

      {/* Breadcrumb navigation */}
      <div className="flex items-center gap-1 flex-wrap px-3 py-2 border-b border-border-subtle bg-surface-secondary/50 text-xs shrink-0" data-testid="dir-breadcrumb">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <span key={c.path} className="flex items-center gap-1 min-w-0">
              {i > 0 && <span className="text-fg-tertiary select-none">/</span>}
              {isLast ? (
                <span className="text-fg-primary font-medium truncate max-w-[180px]">{c.label}</span>
              ) : (
                <button
                  className="text-fg-secondary hover:text-brand-500 hover:underline truncate max-w-[140px] cursor-pointer"
                  onClick={() => onNavigate(c.path)}
                  title={c.path}
                >
                  {c.label}
                </button>
              )}
            </span>
          );
        })}
      </div>

      {/* Entry list */}
      <div className="flex-1 overflow-y-auto py-1">
        {entries.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-fg-tertiary">{emptyText ?? '此目录为空'}</p>
        ) : (
          entries.map((e) => {
            const badge = e.isDirectory ? undefined : prettyTypeLabel(e.ext);
            const isMedia = !!e.ext && !!MEDIA_EXT[e.ext.replace(/^\./, '').toLowerCase()];
            return (
              <button
                key={e.path}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left hover:bg-surface-overlay/60 transition-colors cursor-pointer group"
                onClick={() => (e.isDirectory ? onNavigate(e.path) : onOpenFile(e.path))}
                title={e.path}
              >
                {e.isDirectory ? (
                  <svg className="w-4 h-4 shrink-0 text-blue-400" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M3.5 3A1.5 1.5 0 002 4.5v11A1.5 1.5 0 003.5 17h13a1.5 1.5 0 001.5-1.5v-8A1.5 1.5 0 0016.5 6h-6.53a.5.5 0 01-.354-.146L8.706 4.854A1.5 1.5 0 007.586 4H3.5z" />
                  </svg>
                ) : isMedia ? (
                  <svg className="w-4 h-4 shrink-0 text-purple-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4 5a2 2 0 012-2h3.5a1.5 1.5 0 011.06.44l1.5 1.5c.14.14.331.22.53.22H14a2 2 0 012 2v7a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm4.5 4.5a.75.75 0 00-1.5 0v3a.75.75 0 001.06.68l2.5-1.5a.75.75 0 000-1.32l-2.5-1.5a.75.75 0 00-.56-.06z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="w-4 h-4 shrink-0 text-fg-tertiary group-hover:text-fg-secondary" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                  </svg>
                )}
                <span className="flex-1 min-w-0 text-sm text-fg-primary truncate">{e.name}</span>
                {badge && (
                  <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono uppercase bg-surface-overlay/60 text-fg-tertiary border border-border-subtle">
                    {badge}
                  </span>
                )}
                {!e.isDirectory && (
                  <span className="shrink-0 text-[11px] text-fg-tertiary tabular-nums">{formatBytes(e.size)}</span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}