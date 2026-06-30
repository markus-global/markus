import { useState, useRef, useCallback, isValidElement, Children, type ReactNode, type ReactElement, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { MermaidBlock } from './MermaidBlock.tsx';
import { PlantUMLBlock } from './PlantUMLBlock.tsx';
import { DiagramToggleBlock } from './DiagramToggleBlock.tsx';
import { languageDisplayName, extractLanguageFromClass } from './markdown-utils.ts';

const DIAGRAM_COMPONENTS: ComponentType<{ code: string }>[] = [MermaidBlock, PlantUMLBlock];

function extractLanguage(children: ReactNode): string | null {
  for (const child of Children.toArray(children)) {
    if (isValidElement(child) && typeof (child as ReactElement<{ className?: string }>).props?.className === 'string') {
      const cls = (child as ReactElement<{ className?: string }>).props.className!;
      return extractLanguageFromClass(cls);
    }
  }
  return null;
}

function extractCodeText(children: ReactNode): string {
  for (const child of Children.toArray(children)) {
    if (isValidElement(child)) {
      const props = child.props as { children?: ReactNode };
      if (typeof props.children === 'string') return props.children;
      if (Array.isArray(props.children)) {
        return props.children.map((c: unknown) => (typeof c === 'string' ? c : '')).join('');
      }
    }
  }
  return '';
}

export function CodeBlock({ children }: { children?: ReactNode }) {
  const { t } = useTranslation('common');
  const lang = extractLanguage(children);
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');

  const handleCopy = useCallback(async () => {
    let text: string;
    if (mode === 'source') {
      text = extractCodeText(children);
    } else {
      text = preRef.current?.querySelector('code')?.textContent ?? '';
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard access denied */ }
  }, [mode, children]);

  const hasDiagramChild = Children.toArray(children).some(
    child => isValidElement(child) && DIAGRAM_COMPONENTS.includes(child.type as ComponentType<{ code: string }>),
  );
  if (hasDiagramChild) {
    const code = extractCodeText(children);
    const diagLang = lang === 'mermaid' || lang === 'plantuml' ? lang : 'diagram';
    return <DiagramToggleBlock code={code} language={diagLang}>{children}</DiagramToggleBlock>;
  }
  if (lang === 'mermaid' || lang === 'plantuml') {
    return <>{children}</>;
  }

  return (
    <div className="relative group/code my-2 rounded-lg overflow-hidden bg-surface-secondary border border-border-subtle">
      {lang && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-subtle">
          <span className="text-[10px] font-medium text-fg-tertiary uppercase tracking-wider select-none">
            {languageDisplayName(lang)}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setMode('rendered')}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                mode === 'rendered' ? 'bg-brand-600/20 text-brand-500' : 'text-fg-tertiary hover:text-fg-secondary'
              }`}
            >
              {t('markdown.viewRendered')}
            </button>
            <button
              onClick={() => setMode('source')}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                mode === 'source' ? 'bg-brand-600/20 text-brand-500' : 'text-fg-tertiary hover:text-fg-secondary'
              }`}
            >
              {t('markdown.viewSource')}
            </button>
          </div>
        </div>
      )}
      <div className="relative">
        {mode === 'rendered' ? (
          <pre
            ref={preRef}
            className="p-3 overflow-x-auto text-xs [&>code]:bg-transparent [&>code]:p-0 [&>code]:rounded-none [&>code]:text-fg-secondary"
          >
            {children}
          </pre>
        ) : (
          <pre className="p-3 overflow-x-auto text-xs font-mono text-fg-secondary whitespace-pre-wrap break-words">
            {extractCodeText(children)}
          </pre>
        )}
        <button
          onClick={handleCopy}
          className="absolute top-2 right-2 p-1.5 rounded-md bg-surface-elevated/80 hover:bg-surface-overlay text-fg-tertiary hover:text-fg-primary backdrop-blur-sm border border-border-default/50 transition-all opacity-0 group-hover/code:opacity-100"
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
    </div>
  );
}
