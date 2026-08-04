import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';

export type CodeLanguage =
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'json'
  | 'python'
  | 'css'
  | 'html'
  | 'markdown'
  | 'xml'
  | 'text';

function useIsDarkEditor(): boolean {
  const read = () => {
    const htmlEl = document.documentElement;
    if (htmlEl.classList.contains('light')) return false;
    if (
      htmlEl.classList.contains('dark')
      || htmlEl.classList.contains('cyberpunk')
      || htmlEl.classList.contains('mono')
    ) {
      return true;
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onMq = () => setDark(read());
    mq.addEventListener('change', onMq);
    return () => {
      obs.disconnect();
      mq.removeEventListener('change', onMq);
    };
  }, []);
  return dark;
}

/** Map a filesystem path (or explicit format) to a CodeMirror language. */
export function languageFromPath(path: string, formatHint?: string): CodeLanguage {
  if (formatHint === 'markdown') return 'markdown';
  if (formatHint === 'html') return 'html';
  if (formatHint === 'json') return 'json';
  const base = path.split(/[/\\]/).pop()?.toLowerCase() || '';
  const ext = base.includes('.') ? base.split('.').pop()! : base;
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
    case 'jsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'py':
      return 'python';
    case 'css':
    case 'scss':
    case 'less':
      return 'css';
    case 'html':
    case 'htm':
      return 'html';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'xml':
    case 'svg':
      return 'xml';
    default:
      return 'text';
  }
}

function languageExtension(lang: CodeLanguage) {
  switch (lang) {
    case 'typescript':
      return [javascript({ typescript: true })];
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })];
    case 'javascript':
      return [javascript({ jsx: true })];
    case 'json':
      return [json()];
    case 'python':
      return [python()];
    case 'css':
      return [css()];
    case 'html':
      return [html()];
    case 'markdown':
      return [markdown()];
    case 'xml':
      return [xml()];
    default:
      return [];
  }
}

type Props = {
  path: string;
  initialContent: string;
  language?: CodeLanguage;
  /** Hide the top toolbar (when parent provides Preview/Edit chrome). */
  hideToolbar?: boolean;
  onSaved?: (content: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  className?: string;
};

/**
 * Editable local-file viewer with syntax highlighting (CodeMirror 6).
 * Save via toolbar button or Cmd/Ctrl+S.
 */
export function CodeFileEditor({
  path,
  initialContent,
  language: languageProp,
  hideToolbar = false,
  onSaved,
  onDirtyChange,
  className = '',
}: Props) {
  const { t } = useTranslation('common');
  const dark = useIsDarkEditor();
  const language = languageProp ?? languageFromPath(path);
  const [value, setValue] = useState(initialContent);
  const [baseline, setBaseline] = useState(initialContent);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  const baselineRef = useRef(baseline);
  valueRef.current = value;
  baselineRef.current = baseline;

  const dirty = value !== baseline;

  useEffect(() => {
    setValue(initialContent);
    setBaseline(initialContent);
    setStatus('idle');
    setError(null);
  }, [path, initialContent]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const extensions = useMemo(() => {
    const exts = [
      ...languageExtension(language),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px' },
        '.cm-scroller': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          lineHeight: '1.5',
        },
        '.cm-content': { paddingBottom: '2rem' },
      }),
    ];
    // Soft-wrap prose formats; keep code horizontally scrollable.
    if (language === 'markdown' || language === 'html') {
      exts.push(EditorView.lineWrapping);
    }
    return exts;
  }, [language]);

  const save = useCallback(async () => {
    if (saving) return;
    const next = valueRef.current;
    if (next === baselineRef.current) return;
    setSaving(true);
    setError(null);
    setStatus('idle');
    try {
      await api.files.write(path, next);
      setBaseline(next);
      baselineRef.current = next;
      setStatus('saved');
      onSaved?.(next);
      window.setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 1600);
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [path, saving, onSaved]);

  const revert = useCallback(() => {
    setValue(baselineRef.current);
    setStatus('idle');
    setError(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes('MAC');
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 's') return;
      const root = rootRef.current;
      const active = document.activeElement;
      if (!root || !(active instanceof Node) || !root.contains(active)) return;
      e.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const fileName = path.split(/[/\\]/).pop() || path;

  return (
    <div ref={rootRef} className={`flex flex-col min-h-0 flex-1 ${className}`}>
      {!hideToolbar && (
        <div className="shrink-0 flex items-center gap-2 px-2 py-1.5 border-b border-border-default bg-surface-elevated/60">
          <span className="text-xs text-fg-secondary truncate min-w-0 flex items-center gap-1.5">
            {dirty && <span className="w-1.5 h-1.5 rounded-full bg-brand-500 shrink-0" title={t('fileEditor.unsaved')} />}
            <span className="truncate font-mono">{fileName}</span>
          </span>
          <div className="flex-1" />
          {status === 'saved' && (
            <span className="text-[11px] text-green-600">{t('fileEditor.saved')}</span>
          )}
          {status === 'error' && (
            <span className="text-[11px] text-red-500 truncate max-w-[40%]" title={error || undefined}>
              {t('fileEditor.saveFailed')}
            </span>
          )}
          {dirty && (
            <button
              type="button"
              onClick={revert}
              className="px-2 py-1 text-[11px] rounded-md text-fg-tertiary hover:text-fg-secondary hover:bg-surface-overlay transition-colors"
            >
              {t('fileEditor.revert')}
            </button>
          )}
          <button
            type="button"
            onClick={() => { void save(); }}
            disabled={!dirty || saving}
            className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      )}
      {hideToolbar && (
        <div className="shrink-0 flex items-center justify-end gap-2 px-2 py-1 border-b border-border-default">
          {status === 'saved' && (
            <span className="text-[11px] text-green-600">{t('fileEditor.saved')}</span>
          )}
          {status === 'error' && (
            <span className="text-[11px] text-red-500">{t('fileEditor.saveFailed')}</span>
          )}
          {dirty && (
            <button
              type="button"
              onClick={revert}
              className="px-2 py-1 text-[11px] rounded-md text-fg-tertiary hover:text-fg-secondary hover:bg-surface-overlay transition-colors"
            >
              {t('fileEditor.revert')}
            </button>
          )}
          <button
            type="button"
            onClick={() => { void save(); }}
            disabled={!dirty || saving}
            className="px-2.5 py-1 text-[11px] font-medium rounded-md bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden">
        <CodeMirror
          value={value}
          height="100%"
          theme={dark ? oneDark : 'light'}
          extensions={extensions}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
            highlightSelectionMatches: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: false,
          }}
          onChange={(v) => {
            setValue(v);
            if (status === 'saved' || status === 'error') setStatus('idle');
          }}
          className="h-full [&_.cm-editor]:h-full [&_.cm-editor]:outline-none"
        />
      </div>
    </div>
  );
}

/** Ask before discarding unsaved editor changes. Returns true if caller may proceed. */
export function confirmDiscardDirty(dirty: boolean, message: string): boolean {
  if (!dirty) return true;
  return window.confirm(message);
}
