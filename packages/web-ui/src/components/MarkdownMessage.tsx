import { useMemo, useState, useRef, useEffect, useCallback, memo, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import { api } from '../api.ts';
import { useNativeBrowserOverlay } from '../hooks/useNativeBrowserOverlay.ts';
import { isElectron, openExternal } from '../hooks/useElectron.ts';
import { useLayout } from '../contexts/LayoutContext.tsx';
import { FilePathLink, looksLikeFilePath } from './FilePathLink.tsx';
import { CodeBlock } from './CodeBlock.tsx';
import { MermaidBlock } from './MermaidBlock.tsx';
import { PlantUMLBlock } from './PlantUMLBlock.tsx';
import { DiagramToggleBlock } from './DiagramToggleBlock.tsx';
import {
  transformOutsideCode, normalizeMathDelimiters,
  preprocessMentions, preprocessEntityLinksInCode, preprocessEntityIds,
  looksLikePlantUML, looksLikeMermaid,
} from './markdown-utils.ts';
import {
  classifyMarkdownHref,
  isLocalFilesystemPath,
  normalizeLocalFilesystemPath,
  normalizeWindowsPathsInMarkdown,
  rehypeSlugifyHeadings,
  scrollToMarkdownFragment,
} from './markdown-links.ts';
import { copyPlainText, copyAsHtml } from './markdown-copy.ts';
import { TypographySettings, loadTypographyConfig, resolveTypographyCSS } from './TypographySettings.tsx';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import {
  EntityChip, EntityCard, looksLikeEntityId, chipTypeToEntityType, type EntityType,
} from './EntityCard.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';

// Internal resource link schemes (e.g. `deliverable:dlv_…`, `task:tsk_…`) that the
// `a` renderer turns into clickable entity chips. react-markdown's default URL
// sanitizer strips any non-safe protocol, which would blank these hrefs before the
// chip logic runs — so allow them through here. `#entity:`/`#mention:` already
// survive sanitization because they start with `#`.
const CUSTOM_URI_SCHEME_RE = /^(deliverable|task|requirement|project|agent|team|workflow):/i;
function chatUrlTransform(url: string): string {
  // react-markdown's defaultUrlTransform treats `C:` / `file:` as unsafe schemes
  // and blanks the src — which breaks Windows local image markdown.
  if (CUSTOM_URI_SCHEME_RE.test(url) || isLocalFilesystemPath(url)) return url;
  return defaultUrlTransform(url);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REMARK_PLUGINS: any[] = [remarkGfm, remarkMath, remarkBreaks];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REHYPE_PLUGINS: any[] = [
  rehypeSlugifyHeadings,
  [rehypeKatex, { strict: 'ignore' }],
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
];

const MD_LINK_CLASS = 'text-brand-500 hover:text-brand-500 underline break-all cursor-pointer';

interface Props {
  content: string;
  className?: string;
  /** When provided, @mentions in the text become clickable and invoke this callback with the mentioned name and click event */
  onMentionClick?: (name: string, event: React.MouseEvent) => void;
  /** Known agent/user names for multi-word mention matching (e.g. "Markus Platform Dev Manager") */
  knownNames?: string[];
  /** Base directory for resolving relative image paths (e.g. the directory containing the source markdown file) */
  basePath?: string;
}

const thinkRegex = /<think>([\s\S]*?)(<\/think>|$)/g;

function extractThinkBlocks(text: string): { thinking: string[]; rest: string } {
  const thinking: string[] = [];
  let rest = text.replace(thinkRegex, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed) thinking.push(trimmed);
    return '';
  });
  // Strip orphaned closing/opening think tags that can occur when
  // think blocks span across message segments (split by tool calls)
  rest = rest.replace(/<\/think>/g, '').replace(/<think>/g, '');
  return { thinking, rest: rest.trim() };
}

const MENTION_PREFIX = '#mention:';

// ─── Entity ID linking ───────────────────────────────────────────────────────

const ENTITY_PREFIX = '#entity:';
const ENTITY_LINK_CONTENT_RE = /^\[([^\]]+)\]\(#entity:((tsk|req|proj|dlv|agt|team)_[a-f0-9]{6,})\)$/i;
const CHIP_HREF_RE = /^(workflow|task|requirement|project|deliverable|agent|team):(.+)$/;

// hast helpers for detecting a paragraph that is a single entity reference (→ block card)
type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

function hastText(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

function isBlankText(node: HastNode): boolean {
  return node.type === 'text' && (node.value ?? '').trim() === '';
}

/** If a paragraph node consists solely of one entity reference, extract it for card rendering. */
function soleEntityRef(node?: HastNode): { id: string; type?: EntityType; label?: string } | null {
  if (!node?.children) return null;
  const kids = node.children.filter(k => !isBlankText(k));
  if (kids.length !== 1) return null;
  const only = kids[0]!;
  if (only.type === 'element' && only.tagName === 'a') {
    const href = only.properties?.['href'] as string | undefined;
    if (!href) return null;
    const label = hastText(only);
    if (href.startsWith(ENTITY_PREFIX)) return { id: href.slice(ENTITY_PREFIX.length) };
    const m = href.match(CHIP_HREF_RE);
    if (m && m[1] !== 'workflow') return { id: m[2]!, type: chipTypeToEntityType(m[1]!), label };
    return null;
  }
  if (only.type === 'element' && only.tagName === 'code') {
    const txt = hastText(only).trim();
    if (looksLikeEntityId(txt)) return { id: txt };
  }
  if (only.type === 'text') {
    const txt = (only.value ?? '').trim();
    if (looksLikeEntityId(txt)) return { id: txt };
  }
  return null;
}

const mdComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 last:mb-0 leading-relaxed text-fg-secondary">{children}</p>,
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-base font-bold mb-2 mt-3 first:mt-0 text-fg-primary">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-sm font-bold mb-2 mt-3 first:mt-0 text-fg-primary">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-sm font-semibold mb-1 mt-2 first:mt-0 text-fg-primary">{children}</h3>,
  h4: ({ children }: { children?: React.ReactNode }) => <h4 className="text-sm font-semibold mb-1 mt-2 first:mt-0 text-fg-primary">{children}</h4>,
  h5: ({ children }: { children?: React.ReactNode }) => <h5 className="text-xs font-semibold mb-1 mt-2 first:mt-0 text-fg-primary">{children}</h5>,
  h6: ({ children }: { children?: React.ReactNode }) => <h6 className="text-xs font-medium mb-1 mt-2 first:mt-0 text-fg-primary">{children}</h6>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
  // Forward `start` so ordered lists that begin at a number other than 1 render
  // correctly. Agent output often intersperses block content (e.g. a bare
  // entity-id card) between items, which splits one list into several
  // single-item `<ol start="N">` lists; without `start` they'd all show "1.".
  // `pl-7` (not `pl-4`): the decimal marker sits (list-style-position: outside)
  // in the left padding; 16px is narrower than a two-digit marker like "20.",
  // so the leading digit overflows left and gets clipped by the message
  // container's `overflow-hidden` (rendering "10." as "0."). 28px fits it.
  ol: ({ children, start }: { children?: React.ReactNode; start?: number }) => (
    <ol start={start} className="list-decimal pl-7 mb-2 space-y-0.5">{children}</ol>
  ),
  li: ({ children, value }: { children?: React.ReactNode; value?: string | number | readonly string[] }) => (
    <li value={value} className="leading-relaxed text-fg-secondary marker:text-fg-secondary">{children}</li>
  ),
  code: ({ children, className: cls }: { children?: React.ReactNode; className?: string }) => {
    const text = typeof children === 'string' ? children : String(children ?? '');
    const trimmed = text.trim();
    if (cls?.includes('language-plantuml') || looksLikePlantUML(trimmed)) {
      return <DiagramToggleBlock code={trimmed} language="plantuml"><PlantUMLBlock code={trimmed} /></DiagramToggleBlock>;
    }
    if (cls?.includes('language-mermaid') || (!cls && looksLikeMermaid(trimmed))) {
      return <DiagramToggleBlock code={trimmed} language="mermaid"><MermaidBlock code={trimmed} /></DiagramToggleBlock>;
    }
    if (cls?.includes('language-')) {
      return <code className={`${cls} text-fg-secondary font-mono text-xs`}>{children}</code>;
    }
    if (looksLikeEntityId(text)) {
      return <EntityChip id={text.trim()} />;
    }
    const entityLinkMatch = text.match(ENTITY_LINK_CONTENT_RE);
    if (entityLinkMatch) {
      return <EntityChip id={entityLinkMatch[2]!} label={entityLinkMatch[1]} />;
    }
    if (looksLikeFilePath(text)) {
      return <FilePathLink path={text} />;
    }
    return <code className="bg-surface-secondary px-1.5 py-0.5 rounded text-xs font-mono text-brand-500 break-all">{children}</code>;
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <CodeBlock>{children}</CodeBlock>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-bold text-fg-primary">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic text-fg-secondary">{children}</em>,
  del: ({ children }: { children?: React.ReactNode }) => <del className="line-through text-fg-tertiary">{children}</del>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-brand-500 pl-3 my-2 text-fg-secondary italic">{children}</blockquote>
  ),
  // Static fallback — real click routing is in MarkdownMessage components.a
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} className={MD_LINK_CLASS}>{children}</a>
  ),
  hr: () => <hr className="border-border-default my-3" />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-sm border-collapse border border-border-default">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-surface-secondary">{children}</thead>,
  tbody: ({ children }: { children?: React.ReactNode }) => <tbody className="divide-y divide-border-default">{children}</tbody>,
  tr: ({ children }: { children?: React.ReactNode }) => <tr className="hover:bg-surface-elevated/50 transition-colors">{children}</tr>,
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-3 py-2 text-left text-sm font-semibold text-fg-primary border border-border-default">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-3 py-2 text-sm text-fg-primary border border-border-default">{children}</td>
  ),
};

// ─── Image support ───────────────────────────────────────────────────────────

const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

function isLocalImagePath(src: string): boolean {
  const normalized = normalizeLocalFilesystemPath(src);
  return isLocalFilesystemPath(src) && IMAGE_EXTS.test(normalized.split('?')[0] ?? normalized);
}

function resolveImagePath(src: string, basePath?: string): string {
  const normalized = normalizeLocalFilesystemPath(src);
  if (
    normalized.startsWith('/')
    || normalized.startsWith('~/')
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.startsWith('//')
  ) {
    return normalized;
  }
  if ((normalized.startsWith('./') || normalized.startsWith('../')) && basePath) {
    const base = basePath.replace(/\\/g, '/').endsWith('/')
      ? basePath.replace(/\\/g, '/')
      : `${basePath.replace(/\\/g, '/')}/`;
    const parts = (base + normalized).split('/');
    const resolved: string[] = [];
    for (const p of parts) {
      if (p === '..') resolved.pop();
      else if (p !== '.' && p !== '') resolved.push(p);
    }
    return '/' + resolved.join('/');
  }
  return normalized;
}

function localImageUrl(filePath: string): string {
  return `/api/files/image?path=${encodeURIComponent(filePath)}`;
}

/** Successful object-URL / remote loads — keep across remounts so streaming re-renders don't refetch. */
const loadedImageCache = new Map<string, string>();

function MarkdownImage({ src, alt, onPreview, basePath }: { src: string; alt?: string; onPreview?: (src: string) => void; basePath?: string }) {
  const effectiveSrc = useMemo(() => {
    if (!isLocalImagePath(src)) return src;
    return localImageUrl(resolveImagePath(src, basePath));
  }, [src, basePath]);

  // Local absolute paths are served via /api/files/image. Fetch→blob is more reliable
  // than <img src> during chat streaming: ErrorBoundary/virtualizer remounts abort in-flight
  // <img> loads and used to be permanently cached as failures.
  const isLocalApi = effectiveSrc.startsWith('/api/files/image?');
  const cached = loadedImageCache.get(effectiveSrc);
  // Local chat images should load immediately — IntersectionObserver + streaming
  // remounts previously left a permanent blank skeleton when fetches were aborted.
  const [displaySrc, setDisplaySrc] = useState<string | null>(cached ?? (isLocalApi ? null : effectiveSrc));
  const [loaded, setLoaded] = useState(!!cached);
  const [error, setError] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  /** Bumped on user retry so the fetch effect re-runs even when other deps are unchanged. */
  const [retryToken, setRetryToken] = useState(0);
  const fetchGenRef = useRef(0);

  const retryLoad = useCallback(() => {
    loadedImageCache.delete(effectiveSrc);
    setError(false);
    setErrorDetail(null);
    setLoaded(false);
    setDisplaySrc(isLocalApi ? null : `${effectiveSrc}${effectiveSrc.includes('?') ? '&' : '?'}retry=${Date.now()}`);
    setRetryToken(n => n + 1);
  }, [effectiveSrc, isLocalApi]);

  useEffect(() => {
    if (!isLocalApi) return;
    const hit = loadedImageCache.get(effectiveSrc);
    if (hit) {
      setDisplaySrc(hit);
      setLoaded(true);
      setError(false);
      setErrorDetail(null);
      return;
    }

    const gen = ++fetchGenRef.current;
    setError(false);
    setErrorDetail(null);
    setLoaded(false);
    setDisplaySrc(null);

    (async () => {
      try {
        // Do not AbortController-cancel on effect cleanup: streaming remounts were
        // aborting in-flight loads and leaving a blank skeleton with error=false.
        const res = await fetch(effectiveSrc, { credentials: 'same-origin' });
        if (gen !== fetchGenRef.current) return;
        if (!res.ok) {
          let detail = `HTTP ${res.status}`;
          try {
            const body = await res.json() as { error?: string };
            if (body.error) detail = body.error;
          } catch { /* ignore */ }
          throw new Error(detail);
        }
        const blob = await res.blob();
        if (gen !== fetchGenRef.current) return;
        if (blob.size === 0) throw new Error('Empty image response');
        // SPA/HTML fallbacks sometimes return 200 text/html — reject those.
        if (blob.type && !blob.type.startsWith('image/') && !blob.type.includes('octet-stream')) {
          throw new Error(`Unexpected content-type: ${blob.type}`);
        }
        const objectUrl = URL.createObjectURL(blob);
        loadedImageCache.set(effectiveSrc, objectUrl);
        setDisplaySrc(objectUrl);
        setLoaded(true);
        setError(false);
        setErrorDetail(null);
      } catch (err) {
        if (gen !== fetchGenRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[MarkdownImage] failed to load local image', effectiveSrc, err);
        setErrorDetail(msg);
        setError(true);
        setLoaded(false);
      }
    })();
  }, [isLocalApi, effectiveSrc, retryToken]);

  // Remote / data-URI: ordinary <img>; reset error when src changes / user retries.
  useEffect(() => {
    if (isLocalApi) return;
    setDisplaySrc(effectiveSrc);
    setLoaded(!!loadedImageCache.get(effectiveSrc));
    setError(false);
    setErrorDetail(null);
  }, [effectiveSrc, isLocalApi, retryToken]);

  if (error) {
    return (
      <button
        type="button"
        onClick={retryLoad}
        title={errorDetail ?? 'Click to retry'}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-fg-tertiary bg-surface-elevated rounded-lg border border-border-default hover:bg-surface-overlay hover:text-fg-secondary cursor-pointer transition-colors max-w-full"
      >
        <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span className="truncate">Failed to load image — click to retry{errorDetail ? ` (${errorDetail})` : ''}</span>
      </button>
    );
  }

  return (
    <span className="inline-block align-middle max-w-full">
      {!loaded && (
        <span className="block w-full min-h-[80px] max-w-[400px] bg-surface-elevated rounded-lg animate-pulse" />
      )}
      {displaySrc ? (
        <img
          src={displaySrc}
          alt={alt ?? ''}
          onLoad={() => {
            if (!isLocalApi) loadedImageCache.set(effectiveSrc, effectiveSrc);
            setLoaded(true);
          }}
          onError={() => {
            setErrorDetail('Image decode failed');
            setError(true);
          }}
          onClick={() => onPreview?.(displaySrc)}
          className={`max-w-full h-auto rounded-lg cursor-pointer hover:opacity-90 transition-opacity my-1${!loaded ? ' absolute opacity-0 pointer-events-none' : ''}`}
          style={{ maxHeight: '400px', objectFit: 'contain' }}
        />
      ) : null}
    </span>
  );
}

// ─── Image Preview Modal ────────────────────────────────────────────────────

async function fetchImageBlob(src: string): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`);
  return res.blob();
}

/** Clipboard image write usually wants image/png — convert when needed. */
async function blobAsPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
  });
}

function guessImageFilename(src: string, blob: Blob): string {
  try {
    const path = src.startsWith('data:') ? '' : new URL(src, window.location.href).pathname;
    const base = path.split('/').pop() || '';
    if (base && /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(base)) return decodeURIComponent(base);
  } catch { /* ignore */ }
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return `image.${ext}`;
}

/** Shared lightbox for markdown images and chat attachment thumbnails. */
export function ImagePreviewModal({ src, onClose }: { src: string; onClose: () => void }) {
  const { t } = useTranslation('common');
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState<'copy' | 'download' | null>(null);
  useNativeBrowserOverlay(true);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash(null), 1600);
  }, []);

  const handleCopy = useCallback(async (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy('copy');
    try {
      const blob = await fetchImageBlob(src);
      const png = await blobAsPng(blob);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      showFlash(t('imageCopied'));
    } catch {
      showFlash(t('imageCopyFailed'));
    } finally {
      setBusy(null);
    }
  }, [busy, showFlash, src, t]);

  const handleDownload = useCallback(async (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy('download');
    try {
      const blob = await fetchImageBlob(src);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = guessImageFilename(src, blob);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showFlash(t('imageDownloaded'));
    } catch {
      showFlash(t('imageDownloadFailed'));
    } finally {
      setBusy(null);
    }
  }, [busy, showFlash, src, t]);

  const toolBtn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm transition-colors disabled:opacity-50';

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="absolute top-4 right-4 z-10 flex items-center gap-2"
        onClick={e => e.stopPropagation()}
      >
        <button type="button" className={toolBtn} onClick={handleCopy} disabled={!!busy} title={t('copyImage')}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          {t('copy')}
        </button>
        <button type="button" className={toolBtn} onClick={handleDownload} disabled={!!busy} title={t('downloadImage')}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {t('downloadImage')}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-colors"
          title={t('close')}
        >
          <svg className="w-6 h-6 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {flash && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-10 px-3 py-1.5 rounded-lg bg-black/70 text-white text-xs">
          {flash}
        </div>
      )}
      <img
        src={src}
        alt="Preview"
        className="max-w-full max-h-[90vh] object-contain rounded-lg"
        onClick={e => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}

// ─── Copy menu ───────────────────────────────────────────────────────────────

function useIsNarrow(breakpoint = 640) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener('change', handler);
    setNarrow(mq.matches);
    return () => mq.removeEventListener('change', handler);
  }, [breakpoint]);
  return narrow;
}

function CopyMenu({ content, contentRef }: { content: string; contentRef: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showTypography, setShowTypography] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const isNarrow = useIsNarrow();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setShowInfo(false);
        setShowTypography(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 1500);
  }, []);

  const handleCopyMd = async () => {
    const ok = await copyPlainText(content);
    showFlash(ok ? t('markdown.copied') : t('markdown.failed'));
    setOpen(false);
  };

  const handleCopyHtml = async (theme: 'light' | 'dark') => {
    const el = contentRef.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    const typoConfig = loadTypographyConfig();
    const resolved = resolveTypographyCSS(typoConfig);
    const result = await copyAsHtml(el, theme, content, {
      fontFamily: resolved.fontFamily,
      fontSize: resolved.fontSize,
      headingScales: resolved.headingScales,
    });
    const themeLabel = theme === 'light' ? t('markdown.themeLight') : t('markdown.themeDark');
    showFlash(result.ok ? (result.method === 'html' ? t('markdown.htmlCopied', { theme: themeLabel }) : t('markdown.textCopied')) : t('markdown.failed'));
    setOpen(false);
  };

  return (
    <div className="absolute top-1 right-1 z-10 opacity-0 group-hover/md:opacity-100 transition-opacity" ref={menuRef}>
      {flash && (
        <div className="absolute right-0 top-full mt-1 z-20 px-2 py-0.5 rounded bg-surface-elevated border border-border-default text-[10px] text-fg-secondary whitespace-nowrap shadow-lg">
          {flash}
        </div>
      )}
      <button
        onClick={() => setOpen(o => !o)}
        className="p-1.5 rounded-lg bg-surface-elevated/80 hover:bg-surface-overlay text-fg-secondary hover:text-fg-primary backdrop-blur-sm border border-border-default/50 transition-all"
        title={t('markdown.copyContent')}
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-surface-elevated border border-border-default rounded-lg shadow-xl py-1 min-w-[180px]">
          {showTypography ? (
            <TypographySettings onClose={() => setShowTypography(false)} />
          ) : showInfo ? (
            <div className="px-3 py-2 text-[11px] text-fg-secondary space-y-2 max-w-[260px]">
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium text-fg-primary text-xs">{t('markdown.infoTitle')}</span>
                <button onClick={() => setShowInfo(false)} className="text-fg-tertiary hover:text-fg-primary p-0.5">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <div><span className="font-medium text-fg-primary">{t('markdown.mdAbbrev')}</span> — {t('markdown.infoMdDesc')}</div>
              <div><span className="font-medium text-fg-primary">☀️</span> — {t('markdown.infoHtmlLightDesc')}</div>
              <div><span className="font-medium text-fg-primary">🌙</span> — {t('markdown.infoHtmlDarkDesc')}</div>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between px-3 py-1 border-b border-border-subtle mb-1">
                <span className="text-[10px] text-fg-tertiary font-medium">{t('markdown.copyContent')}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setShowTypography(true)}
                    className="p-0.5 rounded text-fg-tertiary hover:text-fg-primary transition-colors"
                    title={t('markdown.typographySettings')}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setShowInfo(true)}
                    className="p-0.5 rounded text-fg-tertiary hover:text-fg-primary transition-colors"
                    title={t('markdown.infoTitle')}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <circle cx="12" cy="12" r="10" /><path strokeLinecap="round" d="M12 16v-4m0-4h.01" />
                    </svg>
                  </button>
                </div>
              </div>
              <button
                onClick={handleCopyMd}
                className="w-full px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-2"
              >
                <span className="w-4 text-center text-fg-tertiary shrink-0 font-mono text-[10px]">{t('markdown.mdAbbrev')}</span>
                {isNarrow ? t('markdown.copyMdSourceShort') : t('markdown.copyMdSource')}
              </button>
              <button
                onClick={() => handleCopyHtml('light')}
                className="w-full px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-2"
              >
                <span className="w-4 text-center shrink-0 text-[10px]">☀️</span>
                {isNarrow ? t('markdown.copyHtmlLightShort') : t('markdown.copyHtmlLight')}
              </button>
              <button
                onClick={() => handleCopyHtml('dark')}
                className="w-full px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-2"
              >
                <span className="w-4 text-center shrink-0 text-[10px]">🌙</span>
                {isNarrow ? t('markdown.copyHtmlDarkShort') : t('markdown.copyHtmlDark')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── MarkdownMessage ─────────────────────────────────────────────────────────

export const MarkdownMessage = memo(function MarkdownMessage({ content, className = '', onMentionClick, knownNames, basePath }: Props) {
  const { thinking, rest } = extractThinkBlocks(content);
  const contentRef = useRef<HTMLDivElement>(null);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const layout = useLayout();

  const preprocess = useCallback((text: string) => {
    let t = transformOutsideCode(text, normalizeMathDelimiters);
    t = transformOutsideCode(t, normalizeWindowsPathsInMarkdown);
    t = transformOutsideCode(t, preprocessEntityLinksInCode);
    t = transformOutsideCode(t, preprocessEntityIds);
    t = transformOutsideCode(t, s => preprocessMentions(s, knownNames));
    return t;
  }, [knownNames]);

  const processedRest = useMemo(() => preprocess(rest), [rest, preprocess]);

  const handleRoutedLinkClick = useCallback((e: ReactMouseEvent, href: string) => {
    const classified = classifyMarkdownHref(href, basePath);
    if (classified.kind === 'passthrough') return;

    e.preventDefault();
    e.stopPropagation();

    if (classified.kind === 'fragment') {
      scrollToMarkdownFragment(contentRef.current, classified.id);
      return;
    }

    if (classified.kind === 'file') {
      if (layout?.hostAvailable) {
        layout.openRightPanel({
          kind: 'file',
          path: classified.path,
          title: classified.path.split(/[/\\]/).pop(),
        });
      } else {
        // No right-panel host (e.g. some settings pages) — reveal in OS file manager.
        void api.files.reveal(classified.path).catch(() => {});
      }
      return;
    }

    if (classified.kind === 'external') {
      // Prefer the in-app EmbeddedBrowser when the page hosts a right panel
      // (desktop Electron). Otherwise open the system / browser tab.
      if (layout?.hostAvailable && /^https?:\/\//i.test(classified.url)) {
        layout.openRightPanel({ kind: 'url', url: classified.url, title: classified.url });
        return;
      }
      openExternal(classified.url);
    }
  }, [basePath, layout]);

  const components = useMemo(() => {
    return {
      ...mdComponents,
      img: ({ src, alt }: { src?: string; alt?: string }) => (
        <MarkdownImage key={src ?? ''} src={src ?? ''} alt={alt} onPreview={setPreviewSrc} basePath={basePath} />
      ),
      // Render a paragraph consisting solely of one entity reference as a rich block card.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      p: ({ children, node }: { children?: React.ReactNode; node?: any }) => {
        const ref = soleEntityRef(node as HastNode | undefined);
        if (ref) return <EntityCard id={ref.id} type={ref.type} label={ref.label} />;
        return <p className="mb-2 last:mb-0 leading-relaxed text-fg-secondary">{children}</p>;
      },
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        if (href?.startsWith(MENTION_PREFIX)) {
          const name = decodeURIComponent(href.slice(MENTION_PREFIX.length));
          return (
            <span
              className={`text-brand-500 font-medium${onMentionClick ? ' cursor-pointer hover:underline' : ''}`}
              onClick={onMentionClick ? (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); onMentionClick(name, e); } : undefined}
              title={name}
            >
              {children}
            </span>
          );
        }
        if (href?.startsWith(ENTITY_PREFIX)) {
          return <EntityChip id={href.slice(ENTITY_PREFIX.length)} />;
        }
        {
          const chipMatch = href?.match(CHIP_HREF_RE);
          if (chipMatch) {
            const [, chipType, chipId] = chipMatch;
            if (chipType === 'workflow') {
              return (
                <span
                  className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-brand-500/10 text-brand-500 text-xs font-medium cursor-pointer hover:bg-brand-500/20 transition-colors"
                  onClick={(e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); navBus.navigate(PAGE.WORK, { boardType: 'workflows' }); }}
                  title={`workflow: ${chipId}`}
                >
                  <span className="text-[10px]">⚙️</span>
                  <span>{children}</span>
                </span>
              );
            }
            const entityType = chipTypeToEntityType(chipType!);
            if (entityType) {
              return <EntityChip id={chipId!} type={entityType} label={children} />;
            }
          }
        }
        // Agents often emit `[Title](proj_…)` / `[Title](dlv_…)` without a scheme.
        // Treat bare Markus entity ids as in-app chips — never open as relative URLs.
        if (href && looksLikeEntityId(href)) {
          return <EntityChip id={href.trim()} label={children} />;
        }

        const classified = classifyMarkdownHref(href, basePath);
        if (classified.kind === 'fragment' || classified.kind === 'file' || classified.kind === 'external') {
          return (
            <a
              href={href}
              className={MD_LINK_CLASS}
              onClick={(e) => handleRoutedLinkClick(e, href!)}
              title={
                classified.kind === 'fragment' ? `#${classified.id}`
                  : classified.kind === 'file' ? classified.path
                    : classified.url
              }
            >
              {children}
            </a>
          );
        }

        // Unknown relative routes — still avoid target=_blank on localhost Electron.
        return (
          <a
            href={href}
            className={MD_LINK_CLASS}
            onClick={(e) => {
              if (isElectron() && href && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
                e.preventDefault();
              }
            }}
          >
            {children}
          </a>
        );
      },
    };
  }, [onMentionClick, basePath, handleRoutedLinkClick]);

  return (
    <div className="relative group/md">
      <CopyMenu content={content} contentRef={contentRef} />
      <div ref={contentRef}>
        <ErrorBoundary
          resetKeys={[processedRest]}
          fallback={<div className={`prose prose-sm max-w-none break-words whitespace-pre-wrap pr-8 text-fg-secondary ${className}`}>{rest}</div>}
        >
        <div className={`prose prose-sm max-w-none break-words pr-8 text-fg-secondary ${className}`}>
          {thinking.length > 0 && (() => {
            const full = thinking.join('\n\n');
            const firstLine = full.split('\n')[0] ?? '';
            const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
            return (
              <details className="mb-3 rounded-lg bg-surface-elevated/60 border border-border-default/50 overflow-hidden group/think">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs text-fg-secondary hover:text-fg-secondary transition-colors flex items-center gap-1.5 min-w-0">
                  <svg className="w-3 h-3 shrink-0 transition-transform group-open/think:rotate-90" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                  </svg>
                  <span className="shrink-0">Thinking</span>
                  <span className="truncate text-fg-tertiary ml-1 group-open/think:hidden">{preview}</span>
                </summary>
                <div className="px-3 pb-3 border-t border-border-default/50">
                  <div className="mt-2 pl-3 border-l-2 border-brand-500/40 text-xs text-fg-secondary leading-relaxed">
                    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components} urlTransform={chatUrlTransform}>
                      {preprocess(full)}
                    </ReactMarkdown>
                  </div>
                </div>
              </details>
            );
          })()}
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components} urlTransform={chatUrlTransform}>
            {processedRest}
          </ReactMarkdown>
        </div>
        </ErrorBoundary>
      </div>
      {previewSrc && <ImagePreviewModal src={previewSrc} onClose={() => setPreviewSrc(null)} />}
    </div>
  );
}, (prev, next) =>
  prev.content === next.content
  && prev.className === next.className
  && prev.basePath === next.basePath
  && prev.onMentionClick === next.onMentionClick
  && arraysShallowEqual(prev.knownNames, next.knownNames));

function arraysShallowEqual(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}
