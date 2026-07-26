import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNativeBrowserOverlay } from '../hooks/useNativeBrowserOverlay.ts';

interface CheckboxOption {
  id: string;
  label: string;
  defaultChecked?: boolean;
}

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` (default) for destructive actions; `primary` for confirmed but non-destructive ones. */
  variant?: 'danger' | 'primary';
  /** Show only the confirm/OK button (no cancel) — use for success/error notices. */
  alertOnly?: boolean;
  checkboxes?: CheckboxOption[];
  onConfirm: (checked?: Record<string, boolean>) => void;
  /** Backdrop / dismiss. */
  onCancel: () => void;
  /**
   * Cancel-button handler. Defaults to `onCancel`.
   * Use when the cancel button means a secondary action (e.g. navigate)
   * while backdrop should only dismiss. Receives checkbox state when present.
   */
  onCancelClick?: (checked?: Record<string, boolean>) => void;
}

export function ConfirmModal({
  title,
  message,
  confirmLabel,
  cancelLabel,
  variant = 'danger',
  alertOnly = false,
  checkboxes,
  onConfirm,
  onCancel,
  onCancelClick,
}: Props) {
  const { t } = useTranslation('common');
  useNativeBrowserOverlay(true);
  const [checks, setChecks] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const cb of checkboxes ?? []) init[cb.id] = cb.defaultChecked ?? false;
    return init;
  });

  const isPrimary = variant === 'primary';
  const confirmBtnClass = isPrimary
    ? 'px-4 py-1.5 text-sm bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors'
    : 'px-4 py-1.5 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors';

  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[10050] p-4" onClick={onCancel}>
      <div
        className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[360px] max-w-[calc(100vw-2rem)] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${isPrimary ? 'bg-brand-500/15' : 'bg-red-500/15'}`}>
            {isPrimary ? (
              <svg className="w-5 h-5 text-brand-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
              </svg>
            ) : (
              <svg className="w-5 h-5 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
              </svg>
            )}
          </div>
          <div className="min-w-0 pt-0.5">
            <h3 className="font-semibold text-base text-fg-primary">{title}</h3>
            <p className="text-sm text-fg-secondary mt-1 leading-relaxed">{message}</p>
          </div>
        </div>
        {checkboxes && checkboxes.length > 0 && (
          <div className="mb-4 space-y-2">
            {checkboxes.map(cb => (
              <label key={cb.id} className="flex items-center gap-2 text-sm text-fg-secondary cursor-pointer">
                <input
                  type="checkbox"
                  checked={checks[cb.id] ?? false}
                  onChange={e => setChecks(prev => ({ ...prev, [cb.id]: e.target.checked }))}
                  className="rounded bg-surface-elevated border-border-default"
                />
                {cb.label}
              </label>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          {!alertOnly && (
            <button
              type="button"
              onClick={() => {
                const payload = checkboxes ? checks : undefined;
                if (onCancelClick) onCancelClick(payload);
                else onCancel();
              }}
              className="px-4 py-1.5 text-sm border border-border-default rounded-lg text-fg-primary hover:bg-surface-elevated transition-colors"
            >
              {cancelLabel ?? t('cancel')}
            </button>
          )}
          <button
            type="button"
            onClick={() => onConfirm(checkboxes ? checks : undefined)}
            className={confirmBtnClass}
          >
            {confirmLabel ?? (alertOnly ? t('ok') : t('confirm'))}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
