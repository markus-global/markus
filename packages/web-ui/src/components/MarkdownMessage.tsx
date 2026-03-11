import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  content: string;
  className?: string;
}

const thinkRegex = /<think>([\s\S]*?)<\/think>/g;

function extractThinkBlocks(text: string): { thinking: string[]; rest: string } {
  const thinking: string[] = [];
  const rest = text.replace(thinkRegex, (_match, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed) thinking.push(trimmed);
    return '';
  });
  return { thinking, rest: rest.trim() };
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
      return <code className="text-gray-300 font-mono">{children}</code>;
    }
    return <code className="bg-gray-900 px-1.5 py-0.5 rounded text-xs font-mono text-indigo-300">{children}</code>;
  },
  pre: ({ children }: { children?: React.ReactNode }) => (
    <pre className="bg-gray-900 rounded-lg p-3 overflow-x-auto my-2 text-xs [&>code]:bg-transparent [&>code]:p-0 [&>code]:rounded-none [&>code]:text-gray-300">
      {children}
    </pre>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }: { children?: React.ReactNode }) => <em className="italic text-gray-300">{children}</em>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-indigo-500 pl-3 my-2 text-gray-400 italic">{children}</blockquote>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 underline">{children}</a>
  ),
  hr: () => <hr className="border-gray-700 my-3" />,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="overflow-x-auto my-2">
      <table className="min-w-full text-xs border-collapse border border-gray-700">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-gray-800">{children}</thead>,
  tbody: ({ children }: { children?: React.ReactNode }) => <tbody className="divide-y divide-gray-700/50">{children}</tbody>,
  tr: ({ children }: { children?: React.ReactNode }) => <tr className="hover:bg-gray-800/50 transition-colors">{children}</tr>,
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-3 py-1.5 text-left text-xs font-semibold text-gray-300 border border-gray-700">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-3 py-1.5 text-xs text-gray-400 border border-gray-700">{children}</td>
  ),
};

export function MarkdownMessage({ content, className = '' }: Props) {
  const { thinking, rest } = extractThinkBlocks(content);

  return (
    <div className={`prose prose-invert prose-sm max-w-none ${className}`}>
      {thinking.length > 0 && (() => {
        const full = thinking.join('\n\n');
        const firstLine = full.split('\n')[0] ?? '';
        const preview = firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
        return (
          <details className="mb-3 rounded-lg bg-gray-800/60 border border-gray-700/50 overflow-hidden group/think">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs text-gray-400 hover:text-gray-300 transition-colors flex items-center gap-1.5 min-w-0">
              <svg className="w-3 h-3 shrink-0 transition-transform group-open/think:rotate-90" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
              </svg>
              <span className="shrink-0">思考过程</span>
              <span className="truncate text-gray-500 ml-1 group-open/think:hidden">{preview}</span>
            </summary>
            <div className="px-3 pb-3 border-t border-gray-700/50">
              <div className="mt-2 pl-3 border-l-2 border-indigo-500/40 text-xs text-gray-400 max-h-60 overflow-y-auto leading-relaxed">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                  {full}
                </ReactMarkdown>
              </div>
            </div>
          </details>
        );
      })()}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {rest}
      </ReactMarkdown>
    </div>
  );
}
