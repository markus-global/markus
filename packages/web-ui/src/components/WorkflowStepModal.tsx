/**
 * `WorkflowStepModal` — a single step of a workflow **template** (definition).
 *
 * Not a run. That distinction was the bug in the previous version: it showed the
 * step's *run* status ("已完成") and a link to "the task it produced", neither of
 * which exists for a template — a template step is a definition, and only a run
 * has tasks. Instance facts live in `WorkflowRunDrawer`.
 *
 * What a definition step needs is to be *editable*: name, role and prompt are
 * exactly the knobs an owner reaches for after a run goes wrong. Saving writes
 * the template YAML through the existing `PUT .../workflows/:name` endpoint, so
 * the server's parser stays the single validator.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface WorkflowStepPatch {
  name?: string;
  role?: string;
  prompt?: string;
}

export interface WorkflowStepModalProps {
  /** Current definition of the step. */
  step: { id: string; name: string; role: string; prompt: string };
  index: number;
  total: number;
  /** Upstream steps, already resolved to display names by the caller. */
  dependsOnNames: string[];
  onClose: () => void;
  onSave: (patch: WorkflowStepPatch) => Promise<void> | void;
}

export function WorkflowStepModal({
  step,
  index,
  total,
  dependsOnNames,
  onClose,
  onSave,
}: WorkflowStepModalProps) {
  const { t } = useTranslation(['work', 'common']);
  const [name, setName] = useState(step.name);
  const [role, setRole] = useState(step.role);
  const [prompt, setPrompt] = useState(step.prompt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const dirty = name !== step.name || role !== step.role || prompt !== step.prompt;

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      // Cmd/Ctrl+Enter saves — the prompt is long, reaching for the button is friction.
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && dirty) {
        void submit();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, name, role, prompt]);

  async function submit() {
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ name, role, prompt });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-step-title"
        className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-default bg-surface-secondary shadow-2xl"
        data-testid="workflow-step-modal"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border-default/50 px-5 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-wider text-fg-quaternary">
              {t('work:task.workflowStepOf', '步骤 {{index}} / {{total}}', { index: index + 1, total })}
            </p>
            <h2 id="workflow-step-title" className="mt-0.5 truncate text-sm font-semibold text-fg-primary">
              {step.name}
            </h2>
            {dependsOnNames.length > 0 ? (
              <p className="mt-1 text-[11px] text-fg-tertiary">
                {t('work:task.workflowDependsOn', '依赖 {{steps}}', { steps: dependsOnNames.join('、') })}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:close', '关闭')}
            className="rounded-lg p-1.5 text-fg-tertiary transition-colors hover:bg-surface-elevated hover:text-fg-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-3">
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="workflow-step-name" className="mb-1 block text-[11px] font-medium text-fg-secondary">
                {t('work:task.workflowStepName', '步骤名称')}
              </label>
              <input
                id="workflow-step-name"
                ref={nameRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="input-field w-full text-xs"
              />
            </div>
            <div className="w-40 shrink-0">
              <label htmlFor="workflow-step-role" className="mb-1 block text-[11px] font-medium text-fg-secondary">
                {t('work:task.workflowStepRole', '角色')}
              </label>
              <input
                id="workflow-step-role"
                value={role}
                onChange={(event) => setRole(event.target.value)}
                className="input-field w-full font-mono text-xs"
              />
            </div>
          </div>

          <div>
            <label htmlFor="workflow-step-prompt" className="mb-1 block text-[11px] font-medium text-fg-secondary">
              {t('work:task.workflowStepPrompt', '提示词')}
            </label>
            <textarea
              id="workflow-step-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              spellCheck={false}
              rows={14}
              className="input-field w-full resize-y font-mono text-[11px] leading-relaxed"
            />
            <p className="mt-1 text-[10px] text-fg-quaternary">
              {t('work:task.workflowStepPromptHint', '保存时服务端会重新校验模板；{{var}} 是运行时参数占位符。')}
            </p>
          </div>

          {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-border-default/50 px-5 py-3">
          <button type="button" onClick={onClose} className="btn-secondary px-4 py-1.5 text-xs">
            {t('work:task.workflowCancel', '取消')}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!dirty || saving}
            className="btn-primary px-4 py-1.5 text-xs disabled:opacity-60"
          >
            {saving ? t('work:task.workflowSaving', '保存中…') : t('work:task.workflowSave', '保存')}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default WorkflowStepModal;
