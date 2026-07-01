import { useState, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { copyPlainText } from './markdown-copy.ts';

interface DiagramToggleBlockProps {
  code: string;
  language: string;
  children: ReactNode;
}

export function DiagramToggleBlock({ code, language, children }: DiagramToggleBlockProps) {
  const { t } = useTranslation('common');
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const ok = await copyPlainText(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }, [code]);

  return (
    <div className="not-prose my-2 rounded-lg overflow-hidden border border-border-subtle">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-subtle bg-surface-secondary">
        <span className="text-[10px] font-medium text-fg-tertiary uppercase tracking-wider select-none">
          {language}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMode('rendered')}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              mode === 'rendered'
                ? 'bg-brand-600/20 text-brand-500'
                : 'text-fg-tertiary hover:text-fg-secondary'
            }`}
          >
            <span className="flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              {t('markdown.viewRendered')}
            </span>
          </button>
          <button
            onClick={() => setMode('source')}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              mode === 'source'
                ? 'bg-brand-600/20 text-brand-500'
                : 'text-fg-tertiary hover:text-fg-secondary'
            }`}
          >
            <span className="flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
              {t('markdown.viewSource')}
            </span>
          </button>
        </div>
      </div>
      {mode === 'rendered' ? (
        <div>{children}</div>
      ) : (
        <div className="relative group/source">
          <pre className="p-3 overflow-x-auto text-xs font-mono text-fg-secondary bg-surface-secondary leading-relaxed whitespace-pre-wrap break-words">
            {code}
          </pre>
          <button
            onClick={handleCopy}
            className="absolute top-2 right-2 p-1.5 rounded-md bg-surface-elevated/80 hover:bg-surface-overlay text-fg-tertiary hover:text-fg-primary backdrop-blur-sm border border-border-default/50 transition-all opacity-0 group-hover/source:opacity-100"
            title={t('markdown.copyContent')}
          >
            {copied ? (
              <svg className="w-3.5 h-3.5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
