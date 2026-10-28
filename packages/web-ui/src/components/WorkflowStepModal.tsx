/**
 * `WorkflowStepModal` — 模板里单个步骤的**定义**编辑器。
 *
 * 交互规则（Owner 2026-10-28 反馈后重做）：
 *   1. **打开时不自动聚焦任何输入框**。用户是来看内容的，不是来打字的；
 *      自动聚焦会让光标跳进第一个输入框，还会吞掉键盘快捷键。
 *   2. **默认是只读展示，点击才进入编辑**（与任务/需求的描述框一致）；
 *      失焦即保存，Esc 放弃本次编辑。
 *   3. **角色是下拉选择**，不是自由文本——手滑打成 `manger` 会让运行时
 *      角色映射直接失败，这种"输入即错误"的字段就不该让人手打。
 *
 * 说明：这里是**模板定义**（definition），不是运行实例。状态、任务、进度属于
 * 某一次 run，见 `WorkflowRunDrawer`。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface WorkflowStepPatch {
  name?: string;
  role?: string;
  prompt?: string;
}

export interface WorkflowStepModalProps {
  step: { id: string; name: string; role: string; prompt: string };
  index: number;
  total: number;
  /** Upstream steps, already resolved to display names by the caller. */
  dependsOnNames: string[];
  /** Selectable roles (template roles + this run's mapping keys). */
  roleOptions: string[];
  onClose: () => void;
  onSave: (patch: WorkflowStepPatch) => Promise<void> | void;
}

type EditingField = 'name' | 'prompt' | null;

export function WorkflowStepModal({
  step,
  index,
  total,
  dependsOnNames,
  roleOptions,
  onClose,
  onSave,
}: WorkflowStepModalProps) {
  const { t } = useTranslation(['work', 'common']);
  const [editing, setEditing] = useState<EditingField>(null);
  const [draftName, setDraftName] = useState(step.name);
  const [draftPrompt, setDraftPrompt] = useState(step.prompt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Keep drafts in sync when the parent refetches the template after a save —
  // otherwise the next edit would start from stale text.
  useEffect(() => { setDraftName(step.name); }, [step.name]);
  useEffect(() => { setDraftPrompt(step.prompt); }, [step.prompt]);

  // No autofocus on open. Only Escape-to-close, and only when not mid-edit
  // (while editing, Escape is "cancel this field").
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (editing) {
        event.stopPropagation();
        setEditing(null);
        setDraftName(step.name);
        setDraftPrompt(step.prompt);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, onClose, step.name, step.prompt]);

  const commit = async (patch: WorkflowStepPatch) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const commitName = async () => {
    setEditing(null);
    const next = draftName.trim();
    if (!next || next === step.name) { setDraftName(step.name); return; }
    await commit({ name: next });
  };

  const commitPrompt = async () => {
    setEditing(null);
    if (draftPrompt === step.prompt) return;
    await commit({ prompt: draftPrompt });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-step-title"
        className="relative flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border-default bg-surface-secondary shadow-2xl"
        data-testid="workflow-step-modal"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border-default/50 px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-medium uppercase tracking-wider text-fg-muted">
              {t('work:task.workflowStepOf', '步骤 {{index}} / {{total}}', { index: index + 1, total })}
            </p>

            {editing === 'name' ? (
              <input
                autoFocus
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onBlur={() => void commitName()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void commitName();
                }}
                aria-label={t('work:task.workflowStepName', '步骤名称')}
                className="input-field mt-0.5 w-full text-sm"
              />
            ) : (
              <h2
                id="workflow-step-title"
                onClick={() => setEditing('name')}
                title={t('work:task.workflowClickToEdit', '点击编辑')}
                className="mt-0.5 cursor-text truncate rounded px-1 -mx-1 text-sm font-semibold text-fg-primary hover:bg-surface-elevated/60"
                data-testid="workflow-step-name"
              >
                {step.name}
              </h2>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-tertiary">
              {/* 角色是枚举式字段：手打错一个字母，运行时角色映射就落空 */}
              <select
                value={step.role}
                onChange={(event) => void commit({ role: event.target.value })}
                aria-label={t('work:task.workflowStepRole', '角色')}
                data-testid="workflow-step-role"
                className="rounded border border-border-default/60 bg-surface px-1.5 py-0.5 text-[11px] text-fg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60"
              >
                {[...new Set([step.role, ...roleOptions])].filter(Boolean).map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
              {dependsOnNames.length > 0 ? (
                <span>
                  {t('work:task.workflowDependsOn', '依赖 {{steps}}', { steps: dependsOnNames.join('、') })}
                </span>
              ) : null}
              {saving ? (
                <span className="text-fg-muted">{t('work:task.workflowSaving', '保存中…')}</span>
              ) : null}
            </div>
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

        <div className="flex-1 space-y-2 overflow-y-auto px-5 py-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-fg-muted">
            {t('work:task.workflowStepPrompt', '提示词')}
          </p>

          {editing === 'prompt' ? (
            <textarea
              autoFocus
              value={draftPrompt}
              onChange={(event) => setDraftPrompt(event.target.value)}
              onBlur={() => void commitPrompt()}
              aria-label={t('work:task.workflowStepPrompt', '提示词')}
              spellCheck={false}
              rows={14}
              className="input-field w-full resize-y font-mono text-[11px] leading-relaxed"
            />
          ) : (
            <pre
              onClick={() => setEditing('prompt')}
              title={t('work:task.workflowClickToEdit', '点击编辑')}
              data-testid="workflow-step-prompt"
              className="max-h-[45vh] cursor-text overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface px-3 py-2.5 font-mono text-[11px] leading-relaxed text-fg-secondary hover:bg-surface-elevated/40"
            >
              {step.prompt || '—'}
            </pre>
          )}

          <p className="text-[10px] text-fg-muted">
            {t('work:task.workflowStepPromptHint', '失焦即保存，Esc 放弃本次编辑；保存时服务端会重新校验模板。')}
          </p>
          {error ? <p className="text-[11px] text-red-500">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}

export default WorkflowStepModal;
