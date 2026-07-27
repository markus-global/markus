import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hubApi, ensureHubAuth, getHubToken } from '../api.ts';
import { useNativeBrowserOverlay } from '../hooks/useNativeBrowserOverlay.ts';
import { isElectron, openExternal } from '../hooks/useElectron.ts';

interface Props {
  onClose: () => void;
  onClaimed: () => void;
}

type Phase = 'loading' | 'open_hub' | 'already' | 'error';

/** Desktop claim entry: opens Hub Settings claim flow (no local invite/survey UI). */
export function ClaimFreeCreditsModal({ onClose, onClaimed }: Props) {
  const { t } = useTranslation(['home', 'common']);
  useNativeBrowserOverlay(true);
  const [phase, setPhase] = useState<Phase>('loading');
  const [amountCu, setAmountCu] = useState(1000);
  const [error, setError] = useState('');

  // Parent often passes an inline onClaimed — keep a ref so status loading
  // does not re-run (and flicker loading ↔ open_hub) on every Home refresh.
  const onClaimedRef = useRef(onClaimed);
  onClaimedRef.current = onClaimed;
  const ranRef = useRef(false);

  const claimUrl = () => {
    const base = hubApi.getUrl().replace(/\/$/, '');
    return `${base}/settings?tab=overview&claim=1`;
  };

  const loadStatus = useCallback(async () => {
    setPhase('loading');
    setError('');
    try {
      if (!getHubToken()) {
        await ensureHubAuth();
      }
      const status = await hubApi.user.claimFreeCreditsStatus();
      if (typeof status.amountCu === 'number' && status.amountCu > 0) {
        setAmountCu(status.amountCu);
      }
      if (status.claimed) {
        setPhase('already');
        onClaimedRef.current();
        return;
      }
      setPhase('open_hub');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('claim.loadFailed'));
      setPhase('error');
    }
  }, [t]);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    void loadStatus();
  }, [loadStatus]);

  const openHubClaim = () => {
    const url = claimUrl();
    if (isElectron()) openExternal(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4" onClick={onClose}>
      <div
        className="bg-surface-secondary border border-border-default rounded-2xl p-6 w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="font-semibold text-lg text-fg-primary">{t('claim.title')}</h3>
            <p className="text-sm text-fg-secondary mt-1 leading-relaxed">{t('claim.subtitle')}</p>
          </div>
          <button type="button" onClick={onClose} className="text-fg-tertiary hover:text-fg-primary text-lg leading-none">&times;</button>
        </div>

        {phase === 'loading' && (
          <p className="text-sm text-fg-tertiary mb-5">{t('claim.loading')}</p>
        )}

        {phase === 'already' && (
          <div className="space-y-4">
            <p className="text-sm text-emerald-400">
              {t('claim.success', { amount: amountCu.toLocaleString() })}
            </p>
            <p className="text-sm text-fg-secondary">{t('claim.startUsing')}</p>
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2.5 text-sm font-medium rounded-xl bg-brand-500 text-white hover:bg-brand-600"
            >
              {t('common:close')}
            </button>
          </div>
        )}

        {phase === 'open_hub' && (
          <div className="space-y-4">
            <p className="text-sm text-fg-secondary leading-relaxed">
              {t('claim.openHubHint', { amount: amountCu.toLocaleString() })}
            </p>
            <button
              type="button"
              onClick={openHubClaim}
              className="w-full py-2.5 text-sm font-medium rounded-xl bg-brand-500 text-white hover:bg-brand-600"
            >
              {t('claim.openHub')}
            </button>
          </div>
        )}

        {phase === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-red-400">{error}</p>
            <button type="button" onClick={() => void loadStatus()} className="w-full py-2 text-sm rounded-xl border border-border-default">
              {t('claim.retry')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
