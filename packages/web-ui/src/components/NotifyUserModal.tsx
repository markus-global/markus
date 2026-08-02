import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { NotificationInfo } from '../api.ts';
import { useNativeBrowserOverlay } from '../hooks/useNativeBrowserOverlay.ts';
import { MarkdownMessage } from './MarkdownMessage.tsx';

interface Props {
  notification: NotificationInfo;
  agentName?: string;
  acknowledging?: boolean;
  onClose: () => void;
  onAcknowledge: () => void | Promise<void>;
}

const PRIORITY_BADGE: Record<string, string> = {
  urgent: 'bg-red-500/15 text-red-500',
  high: 'bg-amber-500/15 text-amber-600',
  normal: 'bg-blue-500/15 text-blue-500',
  low: 'bg-surface-overlay text-fg-tertiary',
};

export function NotifyUserModal({ notification, agentName, acknowledging, onClose, onAcknowledge }: Props) {
  const { t } = useTranslation(['team', 'common']);
  useNativeBrowserOverlay(true);
  const priority = notification.priority || 'normal';
  const meta = notification.metadata ?? {};
  const displayAgent = agentName || (typeof meta.agentName === 'string' ? meta.agentName : undefined);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-surface-secondary border border-border-default rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-start gap-3 px-6 py-4 border-b border-border-default shrink-0">
          <div className="w-9 h-9 rounded-lg bg-blue-500/15 text-blue-500 flex items-center justify-center shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.73 21a2 2 0 0 1-3.46 0" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-semibold text-fg-primary leading-snug">{notification.title}</h2>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {displayAgent && <p className="text-xs text-fg-tertiary">{displayAgent}</p>}
              {priority !== 'normal' && (
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${PRIORITY_BADGE[priority] ?? PRIORITY_BADGE.normal}`}>
                  {priority}
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

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="text-sm text-fg-primary leading-relaxed">
            <MarkdownMessage content={notification.body || ''} />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border-default shrink-0">
          <button
            onClick={onClose}
            className="px-3.5 py-2 text-sm text-fg-secondary hover:text-fg-primary rounded-lg hover:bg-surface-overlay transition-colors"
          >
            {t('common:close')}
          </button>
          <button
            onClick={() => void onAcknowledge()}
            disabled={acknowledging}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
          >
            {acknowledging
              ? t('common:loading')
              : t('page.notifyUserGotIt', { ns: 'team', defaultValue: 'Got it' })}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
