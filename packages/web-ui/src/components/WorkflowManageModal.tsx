/**
 * Management modals for a workflow template: edit YAML / duplicate / delete.
 *
 * The APIs (`PUT`/`DELETE /teams/:id/workflows/:name`) have existed all along —
 * only the UI never called them, so the workflow view was read-only in practice
 * and every change had to be routed through an agent conversation. These three
 * surfaces close that gap. YAML is the template's own format (it is what the
 * server stores and validates), so editing it here cannot drift from what the
 * agent writes.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowInfo } from '../api.ts';

export type WorkflowManageMode = 'edit' | 'duplicate' | 'delete';

export interface WorkflowManageModalProps {
  mode: WorkflowManageMode;
  workflow: WorkflowInfo;
  /** Raw template YAML; loaded by the parent for edit/duplicate. */
  yaml?: string;
  yamlLoading?: boolean;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (payload: { name?: string; yaml?: string }) => void;
}

export function WorkflowManageModal({
  mode,
  workflow,
  yaml,
  yamlLoading,
  busy,
  error,
  onClose,
  onSubmit,
}: WorkflowManageModalProps) {
  const { t } = useTranslation(['work', 'common']);
  const [name, setName] = useState(`${workflow.name}-copy`);
  const [text, setText] = useState(yaml ?? '');
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(yaml ?? '');
  }, [yaml]);

  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const title =
    mode === 'edit'
      ? t('work:task.workflowEditTitle', '编辑工作流')
      : mode === 'duplicate'
        ? t('work:task.workflowDuplicateTitle', '复制为新工作流')
        : t('work:task.workflowDeleteConfirmTitle', '删除工作流');

  const nameInvalid = mode === 'duplicate' && !/^[a-z0-9][a-z0-9-]*$/.test(name.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-manage-title"
        className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-xl border border-border-default bg-surface-secondary p-5 shadow-2xl"
        data-testid={`workflow-manage-${mode}`}
      >
        <h2 id="workflow-manage-title" className="text-sm font-semibold text-fg-primary">
          {title}
        </h2>
        <p className="mt-1 text-[11px] text-fg-tertiary">
          {mode === 'delete'
            ? t(
                'work:task.workflowDeleteConfirmDesc',
                '将删除「{{name}}」。已产生的运行记录与任务会保留，此操作不可撤销。',
                { name: workflow.displayName || workflow.name },
              )
            : mode === 'duplicate'
              ? t('work:task.workflowDuplicateDesc', '基于当前模板创建一份副本，之后可以独立编辑。')
              : t('work:task.workflowEditDesc', '直接编辑模板 YAML。保存时服务端会做校验。')}
        </p>

        {mode === 'delete' ? null : (
          <div className="mt-3 flex-1 space-y-3 overflow-y-auto">
            {mode === 'duplicate' ? (
              <div>
                <label className="mb-1 block text-[11px] font-medium text-fg-secondary" htmlFor="workflow-new-name">
                  {t('work:task.workflowNewName', '新工作流名称')}
                </label>
                <input
                  id="workflow-new-name"
                  ref={firstFieldRef}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('work:task.workflowNewNamePlaceholder', '例如 feature-development-v2')}
                  className="input-field w-full font-mono text-xs"
                />
                {nameInvalid ? (
                  <p className="mt-1 text-[10px] text-red-500">
                    {t('work:task.workflowNameInvalid', '只能使用小写字母、数字和连字符')}
                  </p>
                ) : null}
              </div>
            ) : null}
            <div>
              <label className="mb-1 block text-[11px] font-medium text-fg-secondary" htmlFor="workflow-yaml">
                {t('work:task.workflowYaml', 'YAML')}
              </label>
              {yamlLoading ? (
                <div className="space-y-1.5" aria-busy="true">
                  <div className="h-3 w-full animate-pulse rounded bg-surface-elevated" />
                  <div className="h-3 w-5/6 animate-pulse rounded bg-surface-elevated" />
                  <div className="h-3 w-2/3 animate-pulse rounded bg-surface-elevated" />
                </div>
              ) : (
                <textarea
                  id="workflow-yaml"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  spellCheck={false}
                  rows={16}
                  className="input-field w-full resize-y font-mono text-[11px] leading-relaxed"
                />
              )}
            </div>
          </div>
        )}

        {error ? <p className="mt-2 text-[11px] text-red-500">{error}</p> : null}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary px-4 py-1.5 text-xs">
            {t('work:task.workflowCancel', '取消')}
          </button>
          <button
            type="button"
            disabled={busy || yamlLoading || (mode === 'duplicate' && nameInvalid)}
            onClick={() => onSubmit({ name: mode === 'duplicate' ? name.trim() : undefined, yaml: text })}
            className={`px-4 py-1.5 text-xs font-medium text-white transition-colors disabled:opacity-60 ${
              mode === 'delete'
                ? 'rounded-lg bg-red-600 hover:bg-red-500'
                : 'btn-primary'
            }`}
          >
            {busy
              ? t('work:task.workflowSaving', '保存中…')
              : mode === 'delete'
                ? t('work:task.workflowDelete', '删除工作流')
                : mode === 'duplicate'
                  ? t('work:task.workflowDuplicateBtn', '创建副本')
                  : t('work:task.workflowSave', '保存')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default WorkflowManageModal;
