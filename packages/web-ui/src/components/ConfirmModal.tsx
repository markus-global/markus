import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface CheckboxOption {
  id: string;
  label: string;
  defaultChecked?: boolean;
}

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  checkboxes?: CheckboxOption[];
  onConfirm: (checked?: Record<string, boolean>) => void;
  onCancel: () => void;
}

export function ConfirmModal({ title, message, confirmLabel = 'Confirm', checkboxes, onConfirm, onCancel }: Props) {
  const [checks, setChecks] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const cb of checkboxes ?? []) init[cb.id] = cb.defaultChecked ?? false;
    return init;
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={onCancel}>
      <div
        className="bg-surface-secondary border border-border-default rounded-xl p-6 w-[360px] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-semibold text-base mb-2">{title}</h3>
        <p className="text-sm text-fg-secondary mb-4 leading-relaxed">{message}</p>
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
          <button
            onClick={onCancel}
            className="px-4 py-1.5 text-sm border border-border-default rounded-lg hover:bg-surface-elevated transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(checkboxes ? checks : undefined)}
            className="px-4 py-1.5 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
