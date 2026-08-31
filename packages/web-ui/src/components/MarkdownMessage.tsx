import { useMemo, useState, useRef, useEffect, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import { useLayout } from '../contexts/LayoutContext.tsx';
import {
  transformOutsideCode, normalizeMathDelimiters,
  preprocessMentions, preprocessEntityLinksInCode, preprocessEntityIds,
  autolinkBareUrls,
} from './markdown-utils.ts';
import {
  isLocalFilesystemPath,
  normalizeWindowsPathsInMarkdown,
  rehypeSlugifyHeadings,
} from './markdown-links.ts';
import { copyPlainText, copyAsHtml } from './markdown-copy.ts';
import { TypographySettings, loadTypographyConfig, resolveTypographyCSS } from './TypographySettings.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import {
  useMarkdownComponents, ImagePreviewModal,
} from './MarkdownComponents.tsx';

// Re-export for external consumers (e.g. Team.tsx)
export { ImagePreviewModal };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REMARK_PLUGINS: any[] = [remarkGfm, remarkMath, remarkBreaks];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REHYPE_PLUGINS: any[] = [
  rehypeSlugifyHeadings,
  [rehypeKatex, { strict: 'ignore' }],
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
];

// URL transform: allow internal entity schemes + local filesystem paths
function chatUrlTransform(url: string): string {
  const CUSTOM_URI_SCHEME_RE = /^(deliverable|task|requirement|project|agent|team|workflow):/i;
  if (CUSTOM_URI_SCHEME_RE.test(url) || isLocalFilesystemPath(url)) return url;
  return defaultUrlTransform(url);
}

interface Props {
  content: string;
  className?: string;
  /** When provided, @mentions in the text become clickable */
  onMentionClick?: (name: string, event: React.MouseEvent) => void;
  /** Known agent/user names for multi-word mention matching */
  knownNames?: string[];
  /** Base directory for resolving relative image paths */
  basePath?: string;
}

const thinkRegex = / thinking([\s\S]*?)(<\/think>|$)/g;

function extractThinkBlocks(text: string): { thinking: string[]; rest: string } {
  const thinking: string[] = [];
  let rest = text.replace(thinkRegex, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed) thinking.push(trimmed);
    return '';
  });
  rest = rest.replace(/<\/think>/g, '').replace(/ thinking/g, '');
  return { thinking, rest: rest.trim() };
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
    // Must run LAST: wrap bare URLs so GFM autolink doesn't swallow CJK.
    t = transformOutsideCode(t, autolinkBareUrls);
    return t;
  }, [knownNames]);

  const processedRest = useMemo(() => preprocess(rest), [rest, preprocess]);

  const components = useMarkdownComponents({
    onMentionClick,
    basePath,
    onImagePreview: setPreviewSrc,
    contentRef,
    hostAvailable: layout?.hostAvailable,
    openRightPanel: layout?.openRightPanel,
  });

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