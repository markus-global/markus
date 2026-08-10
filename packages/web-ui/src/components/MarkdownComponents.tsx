/**
 * Shared Markdown rendering components used by both chat messages
 * (MarkdownMessage) and file previews (ArtifactDetail RenderedMarkdown).
 *
 * The `useMarkdownComponents` hook returns a `components` object that
 * can be spread into `ReactMarkdown` — including proper link routing
 * that opens external URLs in the system browser (Electron) or a new
 * tab (web), never navigating the Electron window.
 */

import { useState, useRef, useEffect, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNativeBrowserOverlay } from '../hooks/useNativeBrowserOverlay.ts';
import { isElectron, openExternal } from '../hooks/useElectron.ts';
import type { RightPanelPayload } from '../contexts/LayoutContext.tsx';
import { api } from '../api.ts';
import {
  classifyMarkdownHref,
  isLocalFilesystemPath,
  normalizeLocalFilesystemPath,
  scrollToMarkdownFragment,
} from './markdown-links.ts';
import {
  looksLikePlantUML, looksLikeMermaid,
} from './markdown-utils.ts';
import {
  EntityChip, EntityCard, looksLikeEntityId, chipTypeToEntityType, type EntityType,
} from './EntityCard.tsx';
import { FilePathLink, looksLikeFilePath } from './FilePathLink.tsx';
import { CodeBlock } from './CodeBlock.tsx';
import { MermaidBlock } from './MermaidBlock.tsx';
import { PlantUMLBlock } from './PlantUMLBlock.tsx';
import { DiagramToggleBlock } from './DiagramToggleBlock.tsx';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';

// ─── Constants ────────────────────────────────────────────────────────────────

const MENTION_PREFIX = '#mention:';
const ENTITY_PREFIX = '#entity:';
const ENTITY_LINK_CONTENT_RE = /^\[([^\]]+)\]\(#entity:((tsk|req|proj|dlv|agt|team)_[a-f0-9]{6,})\)$/i;
const CHIP_HREF_RE = /^(workflow|task|requirement|project|deliverable|agent|team):(.+)$/;
export const MD_LINK_CLASS = 'text-brand-500 hover:text-brand-500 underline break-all cursor-pointer';

// ─── hast helpers ─────────────────────────────────────────────────────────────

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

// ─── Static components (base layer, overridden by the hook) ───────────────────

export const mdComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 last:mb-0 leading-relaxed text-fg-secondary">{children}</p>,
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-base font-bold mb-2 mt-3 first:mt-0 text-fg-primary">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-sm font-bold mb-2 mt-3 first:mt-0 text-fg-primary">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-sm font-semibold mb-1 mt-2 first:mt-0 text-fg-primary">{children}</h3>,
  h4: ({ children }: { children?: React.ReactNode }) => <h4 className="text-sm font-semibold mb-1 mt-2 first:mt-0 text-fg-primary">{children}</h4>,
  h5: ({ children }: { children?: React.ReactNode }) => <h5 className="text-xs font-semibold mb-1 mt-2 first:mt-0 text-fg-primary">{children}</h5>,
  h6: ({ children }: { children?: React.ReactNode }) => <h6 className="text-xs font-medium mb-1 mt-2 first:mt-0 text-fg-primary">{children}</h6>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
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
  // Static fallback a — real click routing is in useMarkdownComponents
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

const loadedImageCache = new Map<string, string>();

export function MarkdownImage({ src, alt, onPreview, basePath }: { src: string; alt?: string; onPreview?: (src: string) => void; basePath?: string }) {
  const effectiveSrc = useMemo(() => {
    if (!isLocalImagePath(src)) return src;
    return localImageUrl(resolveImagePath(src, basePath));
  }, [src, basePath]);

  const isLocalApi = effectiveSrc.startsWith('/api/files/image?');
  const cached = loadedImageCache.get(effectiveSrc);
  const [displaySrc, setDisplaySrc] = useState<string | null>(cached ?? (isLocalApi ? null : effectiveSrc));
  const [loaded, setLoaded] = useState(!!cached);
  const [error, setError] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
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

// ─── Image Preview Modal ──────────────────────────────────────────────────────

async function fetchImageBlob(src: string): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`);
  return res.blob();
}

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

// ─── Shared hook: useMarkdownComponents ───────────────────────────────────────
//
// Returns a `components` object for `ReactMarkdown`. Link routing:
// - #fragment         → scroll to heading in the same document
// - file path         → open in right panel (if available) or reveal in OS
// - http(s) / mailto  → open in right panel (if available) or system browser
// - #mention: / #entity: / scheme:id → in-app entity chips
// - unknown / bare    → prevent Electron window navigation for non-scheme hrefs

export interface MarkdownComponentsOptions {
  /** Called when an @mention link is clicked (chat messages only) */
  onMentionClick?: (name: string, event: React.MouseEvent) => void;
  /** Base directory for resolving relative image/file paths */
  basePath?: string;
  /** Called when a markdown image is clicked (for preview modal) */
  onImagePreview?: (src: string) => void;
  /** Ref to the container element, used for fragment (heading) scroll */
  contentRef?: React.RefObject<HTMLDivElement | null>;
  /** Layout context – if hostAvailable, use right panel for external URLs & files */
  hostAvailable?: boolean;
  /** Open right panel callback */
  openRightPanel?: (payload: RightPanelPayload) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useMarkdownComponents(options: MarkdownComponentsOptions = {}): Record<string, any> {
  const { onMentionClick, basePath, onImagePreview, contentRef, hostAvailable, openRightPanel } = options;

  const handleRoutedLinkClick = useCallback((e: ReactMouseEvent, href: string) => {
    const classified = classifyMarkdownHref(href, basePath);
    if (classified.kind === 'passthrough') return;

    e.preventDefault();
    e.stopPropagation();

    if (classified.kind === 'fragment') {
      scrollToMarkdownFragment(contentRef?.current ?? null, classified.id);
      return;
    }

    if (classified.kind === 'file') {
      if (hostAvailable && openRightPanel) {
        openRightPanel({
          kind: 'file',
          path: classified.path,
          title: classified.path.split(/[/\\]/).pop(),
        });
      } else {
        void api.files.reveal(classified.path).catch(() => {});
      }
      return;
    }

    if (classified.kind === 'external') {
      if (hostAvailable && openRightPanel && /^https?:\/\//i.test(classified.url)) {
        openRightPanel({ kind: 'url', url: classified.url, title: classified.url });
        return;
      }
      openExternal(classified.url);
    }
  }, [basePath, contentRef, hostAvailable, openRightPanel]);

  return useMemo(() => ({
    ...mdComponents,
    img: ({ src, alt }: { src?: string; alt?: string }) => (
      <MarkdownImage key={src ?? ''} src={src ?? ''} alt={alt} onPreview={onImagePreview} basePath={basePath} />
    ),
    // Render a paragraph consisting solely of one entity reference as a rich block card.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p: ({ children, node }: { children?: React.ReactNode; node?: any }) => {
      const ref = soleEntityRef(node as HastNode | undefined);
      if (ref) return <EntityCard id={ref.id} type={ref.type} label={ref.label} />;
      return <p className="mb-2 last:mb-0 leading-relaxed text-fg-secondary">{children}</p>;
    },
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
      // #mention: links → clickable mention span (chat only)
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
      // #entity: links → entity chip
      if (href?.startsWith(ENTITY_PREFIX)) {
        return <EntityChip id={href.slice(ENTITY_PREFIX.length)} />;
      }
      // scheme:id links (e.g. task:tsk_xxx) → entity chip or workflow link
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
      // Bare entity ID (e.g. agent emits `[Title](dlv_xxx)`) → chip
      if (href && looksLikeEntityId(href)) {
        return <EntityChip id={href.trim()} label={children} />;
      }

      // Classify the href and route accordingly
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

      // Unknown relative routes — still prevent Electron window navigation for non-scheme hrefs
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
  }), [onMentionClick, basePath, onImagePreview, handleRoutedLinkClick]);
}