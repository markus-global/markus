import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { FilePathLink, looksLikeFilePath } from './FilePathLink.tsx';
import { copyPlainText, copyAsHtml } from './markdown-copy.ts';

interface Props {
  content: string;
  className?: string;
  /** When provided, @mentions in the text become clickable and invoke this callback with the mentioned name and click event */
  onMentionClick?: (name: string, event: React.MouseEvent) => void;
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

/** Normalise LaTeX delimiters from LLM output to remark-math's expected syntax.
 *  \(...\) → $...$  and  \[...\] → $$...$$ */
function normalizeMathDelimiters(text: string): string {
  // Block math: \[...\] → $$...$$  (may span multiple lines)
  let out = text.replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner: string) => `$$${inner}$$`);
  // Inline math: \(...\) → $...$  (single line only to avoid false positives)
  out = out.replace(/\\\((.+?)\\\)/g, (_m, inner: string) => `$${inner}$`);
  return out;
}

const MENTION_PREFIX = '#mention:';

/** Convert @mentions in raw text to markdown links before ReactMarkdown processes it.
 *  Uses `#mention:` (hash prefix) so ReactMarkdown's URL sanitiser doesn't strip them. */
function preprocessMentions(text: string): string {
  return text.replace(/@\[([^\]]+)\]|@([\w\p{L}\p{N}]+)/gu, (_full, bracketName: string | undefined, wordName: string | undefined) => {
    const name = bracketName ?? wordName!;
    return `[@${name}](${MENTION_PREFIX}${encodeURIComponent(name)})`;
  });
}

const mdComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="text-sm font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="text-sm font-semibold mb-1 mt-2 first:mt-0">{children}</h3>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="leading-relaxed">{children}</li>,
  code: ({ children, className: cls }: { children?: React.ReactNode; className?: string }) => {
    if (cls?.includes('language-')) {
      return <code className="text-fg-secondary font-mono">{children}</code>;
    }
    const text = typeof children === 'string' ? children : String(children ?? '');
    if (looksLikeFilePath(text)) {
      return <FilePathLink path={text} />;
    }
    return <code className="bg-surface-secondary px-1.5 py-0.5 rounded text-xs font-mono text-brand-500 break-all">{children}</code>;
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="bg-surface-secondary rounded-lg p-3 overflow-x-auto my-2 text-xs [&>code]:bg-transparent [&>code]:p-0 [&>code]:rounded-none [&>code]:text-fg-secondary">
      {children}
    </pre>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold text-fg-primary">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic text-fg-secondary">{children}</em>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-brand-500 pl-3 my-2 text-fg-secondary italic">{children}</blockquote>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:text-brand-500 underline break-all">{children}</a>
  ),
  hr: () => <hr className="border-border-default my-3" />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-xs border-collapse border border-border-default">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-surface-elevated">{children}</thead>,
  tbody: ({ children }: { children?: React.ReactNode }) => <tbody className="divide-y divide-gray-700/50">{children}</tbody>,
  tr: ({ children }: { children?: React.ReactNode }) => <tr className="hover:bg-surface-elevated/50 transition-colors">{children}</tr>,
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-3 py-1.5 text-left text-xs font-semibold text-fg-secondary border border-border-default">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-3 py-1.5 text-xs text-fg-secondary border border-border-default">{children}</td>
  ),
};

// ─── Copy menu ───────────────────────────────────────────────────────────────

function CopyMenu({ content, contentRef }: { content: string; contentRef: React.RefObject<HTMLDivElement | null> }) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
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
    showFlash(ok ? 'Copied!' : 'Failed');
    setOpen(false);
  };

  const handleCopyHtml = async (theme: 'light' | 'dark') => {
    const el = contentRef.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    const result = await copyAsHtml(el, theme, content);
    showFlash(result.ok ? (result.method === 'html' ? `HTML (${theme}) copied` : 'Text copied') : 'Failed');
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
        title="Copy content"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-surface-elevated border border-border-default rounded-lg shadow-xl py-1 min-w-[180px]">
          <button
            onClick={handleCopyMd}
            className="w-full px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-2"
          >
            <span className="w-4 text-center text-fg-tertiary shrink-0 font-mono text-[10px]">Md</span>
            Copy Markdown Source
          </button>
          <button
            onClick={() => handleCopyHtml('light')}
            className="w-full px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-2"
          >
            <span className="w-4 text-center shrink-0 text-[10px]">☀️</span>
            Copy HTML (Light)
          </button>
          <button
            onClick={() => handleCopyHtml('dark')}
            className="w-full px-3 py-2 text-left text-xs text-fg-secondary hover:bg-surface-overlay hover:text-fg-primary transition-colors flex items-center gap-2"
          >
            <span className="w-4 text-center shrink-0 text-[10px]">🌙</span>
            Copy HTML (Dark)
          </button>
        </div>
      )}
    </div>
  );
}

// ─── MarkdownMessage ─────────────────────────────────────────────────────────

export function MarkdownMessage({ content, className = '', onMentionClick }: Props) {
  const { thinking, rest } = extractThinkBlocks(content);
  const contentRef = useRef<HTMLDivElement>(null);

  const processedRest = useMemo(() => {
    let t = normalizeMathDelimiters(rest);
    if (onMentionClick) t = preprocessMentions(t);
    return t;
  }, [rest, onMentionClick]);

  const components = useMemo(() => {
    if (!onMentionClick) return mdComponents;
    return {
      ...mdComponents,
      a: ({ href, children }: { href?: string; children?: React.ReactNode }) => {
        if (href?.startsWith(MENTION_PREFIX)) {
          const name = decodeURIComponent(href.slice(MENTION_PREFIX.length));
          return (
            <span
              className="text-brand-500 font-medium cursor-pointer hover:underline"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMentionClick(name, e); }}
              title={name}
            >
              {children}
            </span>
          );
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:text-brand-500 underline break-all">{children}</a>
        );
      },
    };
  }, [onMentionClick]);

  return (
    <div className="relative group/md">
      <CopyMenu content={content} contentRef={contentRef} />
      <div ref={contentRef}>
        <div className={`prose prose-sm max-w-none break-words pr-8 ${className}`}>
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
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={mdComponents}>
                      {normalizeMathDelimiters(full)}
                    </ReactMarkdown>
                  </div>
                </div>
              </details>
            );
          })()}
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
            {processedRest}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}
