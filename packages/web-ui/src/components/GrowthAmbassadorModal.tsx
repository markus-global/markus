import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { hubApi } from '../api.ts';
import { useNativeBrowserOverlay } from '../hooks/useNativeBrowserOverlay.ts';
import { openExternal } from '../hooks/useElectron.ts';

export interface ReferralStats {
  code: string;
  shareUrl: string;
  invitedCount: number;
  paidCount: number;
  rewardCuTotal: number;
  rewardCuPerPaid: number;
  claimBonusCu: number;
}

interface Props {
  onClose: () => void;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg px-2 py-2.5 text-center bg-surface-elevated">
      <div className="text-lg font-semibold tabular-nums text-fg-primary">{value.toLocaleString()}</div>
      <div className="text-[10px] uppercase tracking-wider mt-0.5 text-fg-muted">{label}</div>
    </div>
  );
}

/**
 * 成长大使弹窗：邀请码 + 已邀请 / 已付费 / 已获得积分。
 *
 * 与 Hub 设置页「邀请奖励」卡片同源（`GET /api/user/referral`），
 * 奖励数值由服务端下发，前端只负责展示——避免两处各写死一份规则。
 */
export function GrowthAmbassadorModal({ onClose }: Props) {
  const { t } = useTranslation('common');
  useNativeBrowserOverlay(true);

  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  const connected = hubApi.isAuthenticated();

  const load = useCallback(async () => {
    if (!connected) { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const data = await hubApi.user.referral();
      setStats({
        code: data.code,
        shareUrl: data.shareUrl,
        invitedCount: data.invitedCount,
        paidCount: data.paidCount,
        rewardCuTotal: data.rewardCuTotal,
        rewardCuPerPaid: data.rewardCuPerPaid,
        claimBonusCu: data.claimBonusCu,
      });
    } catch (err) {
      setError((err as { status?: number }).status === 404 ? t('ambassador.unsupported') : t('ambassador.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [connected, t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async (kind: 'code' | 'link') => {
    if (!stats) return;
    try {
      await navigator.clipboard.writeText(kind === 'code' ? stats.code : stats.shareUrl);
      setCopied(kind);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* clipboard unavailable — user can still select the code manually */
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[10000] p-4" onClick={onClose}>
      <div
        className="bg-surface-secondary border border-border-default rounded-xl w-[460px] max-w-full max-h-[calc(100vh-2rem)] overflow-y-auto shadow-2xl p-6"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-2 mb-4">
          <span className="text-xl leading-none">🎁</span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-fg-primary">{t('ambassador.title')}</h3>
            <p className="text-xs text-fg-tertiary mt-1 leading-relaxed">
              {stats
                ? t('ambassador.desc', {
                  claimAmount: stats.claimBonusCu.toLocaleString(),
                  rewardAmount: stats.rewardCuPerPaid.toLocaleString(),
                })
                : t('ambassador.descGeneric')}
            </p>
          </div>
        </div>

        {!connected ? (
          <div className="rounded-lg border border-border-default p-4 text-center">
            <p className="text-sm text-fg-secondary mb-3">{t('ambassador.loginPrompt')}</p>
            <button
              type="button"
              onClick={() => { hubApi.ensureAuth().then(() => load()).catch(() => {}); }}
              className="px-4 py-2 text-sm bg-brand-600 hover:bg-brand-500 text-white rounded-lg"
            >
              {t('ambassador.login')}
            </button>
          </div>
        ) : loading ? (
          <p className="text-sm text-fg-tertiary py-6 text-center">{t('ambassador.loading')}</p>
        ) : error ? (
          <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">{error}</p>
        ) : stats ? (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-fg-tertiary font-medium mb-1">{t('ambassador.codeLabel')}</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 rounded-lg text-sm font-mono tracking-widest bg-surface-elevated text-fg-primary select-all">
                  {stats.code}
                </code>
                <button
                  type="button"
                  onClick={() => void copy('code')}
                  className="px-3 py-2 text-xs font-medium rounded-lg bg-brand-600 hover:bg-brand-500 text-white shrink-0"
                >
                  {copied === 'code' ? t('ambassador.copied') : t('ambassador.copyCode')}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Stat label={t('ambassador.statInvited')} value={stats.invitedCount} />
              <Stat label={t('ambassador.statPaid')} value={stats.paidCount} />
              <Stat label={t('ambassador.statReward')} value={stats.rewardCuTotal} />
            </div>

            <button
              type="button"
              onClick={() => void copy('link')}
              className="w-full px-3 py-2 text-xs border border-border-default rounded-lg hover:bg-surface-elevated text-fg-secondary"
            >
              {copied === 'link' ? t('ambassador.copied') : t('ambassador.copyLink')}
            </button>
          </div>
        ) : null}

        <div className="flex justify-end gap-3 mt-5">
          {connected && stats && (
            <button
              type="button"
              onClick={() => {
                const base = hubApi.getUrl().replace(/\/$/, '');
                openExternal(`${base}/settings?tab=billing`);
              }}
              className="px-3 py-2 text-xs border border-border-default rounded-lg hover:bg-surface-elevated text-fg-secondary"
            >
              {t('ambassador.openHub')}
            </button>
          )}
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm border border-border-default rounded-lg hover:bg-surface-elevated">
            {t('close')}
          </button>
        </div>
      </div>
    </div>
  );
}
