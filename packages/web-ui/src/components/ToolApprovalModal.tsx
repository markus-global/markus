import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ApprovalInfo } from '../api.ts';
import { useNativeBrowserOverlay } from '../hooks/useNativeBrowserOverlay.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';

interface Props {
  approval: ApprovalInfo;
  submitting?: boolean;
  /** When true the approval was already resolved elsewhere — show, don't re-submit. */
  readOnly?: boolean;
  onClose: () => void;
  onDecision: (approved: boolean, comment?: string) => void | Promise<void>;
}

/**
 * ToolApprovalModal — 工具执行审批（如 Git 写操作）的确认弹窗。
 *
 * 为什么单独一个弹窗、而不是复用 UserInputModal：工具审批的语义是**二元的**
 * （批准 / 拒绝），并且用户真正要看的是那**一条命令**。硬塞进通用问答弹窗会把它
 * 降级成「单选题」，命令还得靠 Markdown 正文里找。这里把标题、Agent、原因、
 * 命令原文（等宽、可换行）与备注一次摆清楚，按钮就是批准/拒绝。
 *
 * 该弹窗由两条路径唤起：
 *   1. 聊天输入区上方横幅被点击；
 *   2. 新审批到达时自动打开（让用户不至于「不知道 Agent 在等」）。
 */
export function ToolApprovalModal({ approval, submitting, readOnly, onClose, onDecision }: Props) {
  const { t } = useTranslation(['team', 'common']);
  useNativeBrowserOverlay(true);
  const [comment, setComment] = useState('');

  const command = typeof approval.details?.command === 'string' ? (approval.details.command as string) : '';
  const toolName = typeof approval.details?.toolName === 'string' ? (approval.details.toolName as string) : '';

  const fire = (approved: boolean) => {
    if (readOnly || submitting) return;
    void onDecision(approved, comment.trim() || undefined);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-surface-secondary border border-border-default rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start gap-3 px-6 py-4 border-b border-border-default shrink-0">
          <div className="w-9 h-9 rounded-lg bg-amber-500/15 text-amber-500 flex items-center justify-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <path d="M12 9v4" /><path d="M12 17h.01" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-fg-primary leading-snug break-words">
              {approval.title || t('team:toolApproval.defaultTitle', { defaultValue: 'Tool execution needs approval' })}
            </h2>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-xs text-fg-tertiary">
                {approval.agentName}
                {toolName ? ` · ${toolName}` : ''}
              </p>
              {readOnly && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-500/15 text-green-600">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
                  {t('team:toolApproval.resolved', { defaultValue: 'Resolved' })}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-fg-tertiary hover:text-fg-primary rounded-md hover:bg-surface-overlay transition-colors shrink-0"
            title={t('common:close')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" /><path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          <p className="text-sm text-fg-secondary leading-relaxed">
            {t('team:toolApproval.lead', {
              defaultValue: 'The agent is paused until you approve or reject this action.',
            })}
          </p>

          {approval.description && (
            <div className="text-xs text-fg-secondary leading-relaxed [&_p]:my-0 [&_p]:text-xs">
              <MarkdownMessage content={approval.description.replace(/\s*Command:[\s\S]*$/, '')} className="text-xs [&_p]:text-xs [&_li]:text-xs" />
            </div>
          )}

          {command && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-fg-tertiary uppercase tracking-wide">
                {t('team:toolApproval.commandLabel', { defaultValue: 'Command' })}
              </div>
              <pre className="text-xs text-fg-primary bg-surface-overlay border border-border-default rounded-xl px-3 py-2.5 overflow-x-auto whitespace-pre-wrap break-all font-mono leading-relaxed">{command}</pre>
            </div>
          )}

          {!readOnly && (
            <textarea
              rows={2}
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder={t('team:toolApproval.commentPlaceholder', { defaultValue: 'Optional note (e.g. why you reject)…' })}
              className="w-full px-3.5 py-2.5 text-sm bg-surface-overlay border border-border-default rounded-xl text-fg-primary placeholder:text-fg-tertiary focus:outline-none focus:ring-1 focus:ring-brand-500/50 resize-y"
            />
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border-default shrink-0">
          {readOnly ? (
            <button
              onClick={onClose}
              className="px-5 py-2 text-sm font-medium text-fg-secondary border border-border-default rounded-lg hover:bg-surface-overlay transition-colors"
            >
              {t('common:close', { defaultValue: 'Close' })}
            </button>
          ) : (
            <>
              <button
                disabled={submitting}
                onClick={() => fire(false)}
                className="px-5 py-2 text-sm font-medium bg-red-600/85 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors inline-flex items-center gap-1.5"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18" /><path d="M6 6l12 12" /></svg>
                {t('common:reject', { defaultValue: 'Reject' })}
              </button>
              <button
                disabled={submitting}
                onClick={() => fire(true)}
                className="px-5 py-2 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors inline-flex items-center gap-2"
              >
                {submitting && (
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {t('common:approve', { defaultValue: 'Approve' })}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
