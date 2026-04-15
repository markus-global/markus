import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

export function MarkdownMessage({ content, className = '', onMentionClick }: Props) {
  const { thinking, rest } = extractThinkBlocks(content);

  const processedRest = useMemo(
    () => onMentionClick ? preprocessMentions(rest) : rest,
    [rest, onMentionClick],
  );

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
    <div className={`prose prose-sm max-w-none break-words ${className}`}>
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
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {full}
                </ReactMarkdown>
              </div>
            </div>
          </details>
        );
      })()}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {processedRest}
      </ReactMarkdown>
    </div>
  );
}
