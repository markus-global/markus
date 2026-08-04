import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ContentRenderer, type HtmlSelectionData } from './ContentRenderer.tsx';
import { CodeFileEditor, confirmDiscardDirty, languageFromPath } from './CodeFileEditor.tsx';

type ViewMode = 'preview' | 'edit';

type Props = {
  path: string;
  content: string;
  format: 'markdown' | 'html';
  basePath?: string;
  onHtmlSelection?: (data: HtmlSelectionData) => void;
  onDirtyChange?: (dirty: boolean) => void;
  className?: string;
};

/**
 * Markdown / HTML dual mode: rich preview by default, switchable to source edit.
 */
export function FilePreviewEditor({
  path,
  content: initialContent,
  format,
  basePath,
  onHtmlSelection,
  onDirtyChange,
  className = '',
}: Props) {
  const { t } = useTranslation('common');
  const [view, setView] = useState<ViewMode>('preview');
  const [buffer, setBuffer] = useState(initialContent);
  const [savedBaseline, setSavedBaseline] = useState(initialContent);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setBuffer(initialContent);
    setSavedBaseline(initialContent);
    setView('preview');
    setDirty(false);
  }, [path, initialContent]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const switchView = useCallback((next: ViewMode) => {
    if (next === view) return;
    if (view === 'edit' && next === 'preview') {
      if (!confirmDiscardDirty(dirty, t('fileEditor.discardConfirm'))) return;
      if (dirty) {
        setBuffer(savedBaseline);
        setDirty(false);
      }
    }
    setView(next);
  }, [view, dirty, t, savedBaseline]);

  const language = languageFromPath(path, format);

  return (
    <div className={`flex flex-col min-h-0 flex-1 ${className}`}>
      <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-border-default bg-surface-elevated/60">
        <div className="inline-flex rounded-md border border-border-default overflow-hidden text-[11px]">
          <button
            type="button"
            onClick={() => switchView('preview')}
            className={`px-2.5 py-1 transition-colors ${
              view === 'preview'
                ? 'bg-brand-600/20 text-brand-500 font-medium'
                : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-overlay'
            }`}
          >
            {t('fileEditor.preview')}
          </button>
          <button
            type="button"
            onClick={() => switchView('edit')}
            className={`px-2.5 py-1 border-l border-border-default transition-colors ${
              view === 'edit'
                ? 'bg-brand-600/20 text-brand-500 font-medium'
                : 'text-fg-tertiary hover:text-fg-secondary hover:bg-surface-overlay'
            }`}
          >
            {t('edit')}
          </button>
        </div>
        {dirty && view === 'edit' && (
          <span className="w-1.5 h-1.5 rounded-full bg-brand-500" title={t('fileEditor.unsaved')} />
        )}
        <div className="flex-1" />
      </div>

      {view === 'preview' ? (
        <div className="flex-1 min-h-0 overflow-auto px-1 py-2">
          <ContentRenderer
            content={buffer}
            format={format}
            className="text-fg-secondary text-sm"
            onHtmlSelection={onHtmlSelection}
            basePath={basePath}
          />
        </div>
      ) : (
        <CodeFileEditor
          path={path}
          initialContent={buffer}
          language={language}
          hideToolbar
          onDirtyChange={setDirty}
          onSaved={(next) => {
            setBuffer(next);
            setSavedBaseline(next);
            setDirty(false);
          }}
        />
      )}
    </div>
  );
}
