import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';

/**
 * 统一 Office 预览组件（T5，V2 规划）。
 *
 * 按格式分发到专用渲染器（均惰性加载，避免打包膨胀）：
 * - pdf  → pdf.js（canvas 渲染，支持缩放/翻页）
 * - docx → docx-preview（HTML 渲染）
 * - xlsx → SheetJS（自绘表格）
 * - pptx / doc / xls / ppt → 无纯前端内联方案，回退「下载 / 系统打开」
 *
 * 边界状态全覆盖：加载中 / 加载失败 / 空内容 / 超大文件提示 / 中文文件名。
 */
export interface OfficePreviewData {
  format: string;
  streamUrl: string;
  name?: string;
  size?: number;
}

const INLINE_FORMATS = new Set(['pdf', 'docx', 'xlsx']);
// 超过该体积（字节）先给提示再加载，避免浏览器白屏期过长。
const LARGE_FILE_THRESHOLD = 30 * 1024 * 1024;

export function OfficePreviewer({ data, reference, onFallback }: {
  data: OfficePreviewData;
  /** 原始文件路径（用于“系统打开”） */
  reference?: string;
  onFallback?: () => void;
}) {
  const { t } = useTranslation('deliverables');
  const normalized = (data.format || '').toLowerCase().replace(/^\./, '');
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [renderKey, setRenderKey] = useState(0);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);

  const runFallback = useCallback(() => {
    onFallback?.();
  }, [onFallback]);

  const handleOpenSystem = useCallback(async () => {
    if (reference) {
      try { await api.files.reveal(reference); return; } catch { /* fall through */ }
    }
    runFallback();
  }, [reference, runFallback]);

  const goToPage = useCallback((target: number) => {
    const el = containerRef.current?.querySelector(`canvas[data-page="${target}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setCurrentPage(target);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !INLINE_FORMATS.has(normalized)) {
      setStatus('ready');
      return;
    }
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    setStatus('loading');
    setError('');
    container.innerHTML = '';

    (async () => {
      try {
        if (normalized === 'pdf') {
          cleanup = await renderPdf(data.streamUrl, container, {
            onReady: (pages) => { setNumPages(pages); setCurrentPage(1); },
            zoom,
          });
        } else if (normalized === 'docx') {
          cleanup = await renderDocx(data.streamUrl, container);
        } else if (normalized === 'xlsx') {
          cleanup = await renderXlsx(data.streamUrl, container);
        }
        if (!cancelled) setStatus('ready');
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setError(String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (cleanup) cleanup();
      container.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.streamUrl, normalized, renderKey, zoom]);

  // 非内联格式（pptx/doc/xls/ppt 等）或加载失败 → 回退视图
  const showFallback = !INLINE_FORMATS.has(normalized);

  return (
    <div className="flex flex-col h-full min-h-0">
      {showFallback ? (
        <FallbackView
          format={normalized}
          size={data.size}
          onOpenSystem={handleOpenSystem}
          onDownload={() => runFallback()}
        />
      ) : (
        <>
          {/* Toolbar */}
          <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border-default/60 bg-surface-elevated/40">
            <span className="text-[10px] font-medium text-fg-tertiary uppercase tracking-wide">{normalized}</span>
            {data.name && <span className="text-[11px] text-fg-secondary truncate flex-1 min-w-0" title={data.name}>{data.name}</span>}
            {data.size != null && data.size > LARGE_FILE_THRESHOLD && (
              <span className="text-[10px] text-amber-500 shrink-0">{t('officeLargeFile')}</span>
            )}
            {normalized === 'pdf' && numPages != null && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => goToPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-fg-tertiary hover:text-fg-secondary disabled:opacity-30"
                >‹</button>
                <span className="text-[10px] text-fg-tertiary tabular-nums">{currentPage}/{numPages}</span>
                <button
                  onClick={() => goToPage(Math.min(numPages ?? 1, currentPage + 1))}
                  disabled={currentPage >= (numPages ?? 1)}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-fg-tertiary hover:text-fg-secondary disabled:opacity-30"
                >›</button>
              </div>
            )}
            {normalized === 'pdf' && (
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))}
                  disabled={zoom <= 0.5}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-fg-tertiary hover:text-fg-secondary disabled:opacity-30"
                >−</button>
                <span className="text-[10px] text-fg-tertiary tabular-nums">{Math.round(zoom * 100)}%</span>
                <button
                  onClick={() => setZoom(z => Math.min(3, +(z + 0.25).toFixed(2)))}
                  disabled={zoom >= 3}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-fg-tertiary hover:text-fg-secondary disabled:opacity-30"
                >+</button>
              </div>
            )}
            <button
              onClick={handleOpenSystem}
              className="shrink-0 text-[10px] text-fg-tertiary hover:text-fg-secondary px-1.5 py-0.5 rounded hover:bg-surface-overlay transition-colors"
            >{t('officeOpenSystem')}</button>
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 overflow-auto p-3">
            {status === 'loading' && (
              <div className="flex items-center justify-center h-full text-fg-tertiary">
                <svg className="animate-spin w-4 h-4 mr-2" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-xs">{t('officeLoading')}</span>
              </div>
            )}
            {status === 'error' && (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
                <span className="text-[11px] text-fg-tertiary">{t('officeFailed')}</span>
                <span className="text-[10px] text-fg-quaternary max-w-xs truncate">{error}</span>
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={() => setRenderKey(k => k + 1)}
                    className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors"
                  >{t('officeRetry')}</button>
                  <button
                    onClick={handleOpenSystem}
                    className="px-3 py-1.5 text-xs border border-border-default text-fg-secondary rounded-lg hover:bg-surface-elevated transition-colors"
                  >{t('officeOpenSystem')}</button>
                </div>
              </div>
            )}
            <div ref={containerRef} className={status === 'loading' ? 'hidden' : ''} />
          </div>
        </>
      )}
    </div>
  );
}

function FallbackView({ format, size, onOpenSystem, onDownload }: {
  format: string;
  size?: number;
  onOpenSystem: () => void;
  onDownload: () => void;
}) {
  const { t } = useTranslation('deliverables');
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
      <div className="w-12 h-12 rounded-xl bg-surface-elevated flex items-center justify-center text-xl">📄</div>
      <div className="text-xs text-fg-secondary">{t('officeNoInlinePreview', { format })}</div>
      {size != null && <div className="text-[10px] text-fg-tertiary">{t('officeSize', { size: formatBytes(size) })}</div>}
      <div className="flex gap-2">
        <button
          onClick={onOpenSystem}
          className="px-3 py-1.5 text-xs bg-brand-600 text-white rounded-lg hover:bg-brand-500 transition-colors"
        >{t('officeOpenSystem')}</button>
        <button
          onClick={onDownload}
          className="px-3 py-1.5 text-xs border border-border-default text-fg-secondary rounded-lg hover:bg-surface-elevated transition-colors"
        >{t('officeDownload')}</button>
      </div>
    </div>
  );
}

function formatBytes(n?: number): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── pdf.js renderer ─────────────────────────────────────────────────────────
// Polyfill ES2025 Map methods that pdfjs-dist 6.x depends on but
// Electron 35 (Chromium 134) doesn't ship yet.
function polyfillMapMethods(): void {
  const mp = Map.prototype as unknown as Record<string, unknown>;
  if (typeof mp.getOrInsertComputed !== 'function') {
    mp.getOrInsertComputed = function (this: Map<unknown, unknown>, key: unknown, cb: (k: unknown) => unknown) {
      if (this.has(key)) return this.get(key);
      const v = cb(key);
      this.set(key, v);
      return v;
    };
  }
  if (typeof mp.getOrInsert !== 'function') {
    mp.getOrInsert = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      if (this.has(key)) return this.get(key);
      this.set(key, value);
      return value;
    };
  }
  // Promise.try polyfill
  const PP = Promise as unknown as Record<string, unknown>;
  if (typeof PP.try !== 'function') {
    PP.try = function (fn: () => unknown) {
      return new Promise(resolve => resolve(fn()));
    };
  }
  // Iterator.prototype.join polyfill
  const ip = (typeof Iterator !== 'undefined' ? Iterator.prototype : null) as unknown as Record<string, unknown> | null;
  if (ip && typeof ip.join !== 'function') {
    ip.join = function (this: Iterable<string>, separator: string = ',') {
      let r = '';
      let first = true;
      for (const v of this) {
        if (!first) r += separator;
        r += String(v);
        first = false;
      }
      return r;
    };
  }
}
polyfillMapMethods();

// ── pdf.js Worker 包装 ────────────────────────────────────────────────────────
// Electron 35 (Chromium 134) 不支持 Map.getOrInsertComputed / getOrInsert /
// Promise.try / Iterator.prototype.join；主线程 polyfill 已在模块作用域执行，
// 但 pdf.js 的 Worker 是独立 ESM 上下文，需要注入 wrapper。
// 方案：仿照 pdfjs 自己的跨域方案 —— 创建 Blob wrapper，先 polyfill 再动态 import
// 真实 worker 模块。参见 npm:pdfjs-dist#_createCDNWrapper。
let pdfWorkerSrc: string | null = null;
function getPdfWorkerSrc(): string {
  if (!pdfWorkerSrc) {
    const originalUrl = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    const wrapper = `
Map.prototype.getOrInsertComputed ??= function(key, cb) {
  if (this.has(key)) return this.get(key);
  const v = cb(key);
  this.set(key, v);
  return v;
};
Map.prototype.getOrInsert ??= function(key, value) {
  if (this.has(key)) return this.get(key);
  this.set(key, value);
  return value;
};
Promise.try ??= function(fn) { return new Promise(function(res) { res(fn()); }); };
var ip = typeof Iterator !== 'undefined' ? Iterator.prototype : null;
if (ip && typeof ip.join !== 'function') {
  ip.join = function(sep) {
    sep = sep || ',';
    var r = '', first = true;
    for (var v of this) { if (!first) r += sep; r += String(v); first = false; }
    return r;
  };
}
await import("${originalUrl}");
`;
    pdfWorkerSrc = URL.createObjectURL(new Blob([wrapper], { type: 'text/javascript' }));
  }
  return pdfWorkerSrc;
}

async function renderPdf(url: string, container: HTMLElement, opts: {
  onReady: (total: number | null) => void;
  zoom: number;
}): Promise<(() => void) | undefined> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = getPdfWorkerSrc();
  const doc = await pdfjs.getDocument({ url }).promise;
  const pages: HTMLCanvasElement[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1.5 * opts.zoom });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    canvas.style.marginBottom = '8px';
    canvas.style.boxShadow = '0 1px 4px rgba(0,0,0,0.15)';
    canvas.style.borderRadius = '2px';
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    canvas.dataset.page = String(p);
    container.appendChild(canvas);
    pages.push(canvas);
  }
  opts.onReady(doc.numPages);
  return () => {
    for (const c of pages) c.remove();
    void doc.cleanup();
  };
}

// ── docx-preview renderer ───────────────────────────────────────────────────
async function renderDocx(url: string, container: HTMLElement): Promise<(() => void) | undefined> {
  const { renderAsync } = await import('docx-preview');
  const blob = await fetch(url).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.blob();
  });
  if (blob.size === 0) throw new Error('empty docx');
  await renderAsync(blob, container, undefined, {
    inWrapper: true,
    ignoreWidth: true,
    ignoreHeight: false,
    breakPages: true,
    className: 'office-docx',
  });
  return () => { container.innerHTML = ''; };
}

// ── SheetJS renderer ────────────────────────────────────────────────────────
async function renderXlsx(url: string, container: HTMLElement): Promise<(() => void) | undefined> {
  const XLSX = await import('xlsx');
  const data = await fetch(url).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.arrayBuffer();
  });
  if (data.byteLength === 0) throw new Error('empty xlsx');
  const wb = XLSX.read(data, { type: 'array' });
  if (!wb.SheetNames || wb.SheetNames.length === 0) throw new Error('no sheets');
  const html = XLSX.utils.sheet_to_html(wb.Sheets[wb.SheetNames[0]!], {
    id: 'office-xlsx-sheet',
    editable: false,
  });
  container.innerHTML = html;
  // Excel 网格基础样式（依赖既有 Tailwind 表层变量，简单内联足够）
  const style = document.createElement('style');
  style.textContent = `
    #office-xlsx-sheet { border-collapse: collapse; font-size: 12px; color: var(--fg-primary, #333); }
    #office-xlsx-sheet td, #office-xlsx-sheet th {
      border: 1px solid var(--border-default, #ddd); padding: 4px 8px; white-space: nowrap;
      background: var(--surface-primary, #fff);
    }
    #office-xlsx-sheet th { background: var(--surface-elevated, #f3f4f6); font-weight: 600; }
  `;
  container.prepend(style);
  return () => { container.innerHTML = ''; };
}