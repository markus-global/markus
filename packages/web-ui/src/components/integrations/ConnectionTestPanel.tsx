/**
 * The two legs of a connection verification, rendered for the Settings card.
 *
 * ── Why two rows and not one checkmark ──────────────────────────────────────
 *
 * "Connected ✓" hides the only failure that matters in practice: a bot that can
 * *receive* but not *send*. That is the common real-world misconfiguration (a
 * Feishu/Slack app without the message-send scope), it passes a credentials
 * probe, and it silently breaks every approval notification. Showing the legs
 * separately makes that failure self-diagnosing.
 *
 * Presented as a run, not a setting: the reply arrives out-of-band from the IM
 * client, so there is nothing to await synchronously. The card polls while the
 * run is live and this component just renders whatever the server last said —
 * the server remains the single source of truth for the run's state.
 */
import { useTranslation } from 'react-i18next';
import type {
  ConnectionTestLeg,
  ConnectionTestSnapshot,
} from '../../lib/instanceIntegrations.ts';
import { Msg } from './PlatformCard.tsx';

const DOT: Record<string, string> = {
  pending: 'bg-amber-400 animate-pulse',
  ok: 'bg-emerald-500',
  failed: 'bg-red-500',
};

function LegRow({
  label,
  hint,
  leg,
}: {
  label: string;
  hint: string;
  leg: ConnectionTestLeg;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="flex items-start gap-2.5" data-testid={`connection-test-leg`}>
      <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${DOT[leg.state] ?? DOT['pending']}`} />
      <div className="min-w-0">
        <div className="text-sm text-fg-primary">{label}</div>
        <div className="text-xs text-fg-tertiary mt-0.5 break-words">
          {leg.state === 'ok'
            ? leg.detail ?? t('integrations.connectionTest.legOk', { defaultValue: 'Verified' })
            : leg.state === 'failed'
              ? leg.detail ?? t('integrations.connectionTest.legFailed', { defaultValue: 'Failed' })
              : hint}
        </div>
      </div>
    </div>
  );
}

/**
 * One localised timestamp for the persisted "last verified" fact.
 *
 * Rendered with the viewer's locale so the panel reads the same as every other
 * date in the app, and guarded: a malformed value must degrade to "showing the
 * raw string" rather than throwing inside the Settings page.
 */
function formatVerifiedAt(value: string, locale: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export interface ConnectionTestPanelProps {
  test: ConnectionTestSnapshot | null;
  /** True while a (re)start request is in flight. */
  starting: boolean;
  onStart: () => void;
  /**
   * When the last *successful* handshake finished, or `null` if never.
   *
   * Persisted server-side, so the panel still tells the truth after a page
   * reload or an app restart — the run itself is deliberately transient.
   */
  lastVerifiedAt?: string | null;
}

export function ConnectionTestPanel({ test, starting, onStart, lastVerifiedAt = null }: ConnectionTestPanelProps) {
  const { t, i18n } = useTranslation('settings');

  const statusHint = (() => {
    if (!test) return null;
    switch (test.status) {
      case 'awaiting_reply':
        return t('integrations.connectionTest.awaitingReply', {
          defaultValue:
            'A test message was sent to {{target}}. Reply to it in {{platform}} to finish — include {{code}} if you can.',
          target: test.targetChannelName ?? test.targetChannelId ?? '',
          platform: test.platform,
          code: test.code ?? '',
        });
      case 'awaiting_inbound':
        return t('integrations.connectionTest.awaitingInbound', {
          defaultValue:
            'Send any message to this bot in {{platform}} — we will answer it to confirm both directions.',
          platform: test.platform,
        });
      case 'verified':
        return t('integrations.connectionTest.verified', {
          defaultValue: 'Both directions work — Markus can send to and receive from this bot.',
        });
      case 'expired':
        return t('integrations.connectionTest.expired', {
          defaultValue: 'No reply arrived in time. Check the bot is in the conversation, then try again.',
        });
      default:
        return null;
    }
  })();

  return (
    <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
      <div>
        <div className="text-sm font-medium text-fg-primary">
          {t('integrations.connectionTest.title', { defaultValue: 'Connection verification' })}
        </div>
        <div className="text-xs text-fg-tertiary mt-0.5">
          {t('integrations.connectionTest.subtitle', {
            defaultValue: 'Sends a real message and waits for your reply — proves both directions.',
          })}
        </div>
      </div>

      {test ? (
        <>
          <div className="space-y-3">
            <LegRow
              label={t('integrations.connectionTest.outbound', { defaultValue: 'Outbound (bot → IM)' })}
              hint={t('integrations.connectionTest.outboundPending', { defaultValue: 'Not sent yet' })}
              leg={test.outbound}
            />
            <LegRow
              label={t('integrations.connectionTest.inbound', { defaultValue: 'Inbound (IM → bot)' })}
              hint={t('integrations.connectionTest.inboundPending', { defaultValue: 'Waiting for your reply' })}
              leg={test.inbound}
            />
          </div>
          {statusHint &&
            (test.status === 'verified' || test.status === 'expired' ? (
              <Msg type={test.status === 'verified' ? 'ok' : 'err'} text={statusHint} />
            ) : (
              <div className="px-3 py-2 rounded-lg text-xs bg-surface-tertiary text-fg-secondary">
                {statusHint}
              </div>
            ))}
        </>
      ) : lastVerifiedAt ? (
        // No live run, but this bot has passed the handshake before. Telling the
        // user "not verified yet" here would be false, and would train them to
        // re-run a test that already succeeded.
        <Msg
          type="ok"
          text={t('integrations.connectionTest.lastVerified', {
            defaultValue: 'Verified {{when}}.',
            when: formatVerifiedAt(lastVerifiedAt, i18n.language),
          })}
        />
      ) : (
        <div className="text-xs text-fg-tertiary">
          {t('integrations.connectionTest.idle', {
            defaultValue:
              'Not verified yet. Verify to send a real message to the bot and confirm the round trip.',
          })}
        </div>
      )}

      <button
        type="button"
        onClick={onStart}
        disabled={starting}
        data-testid="connection-test-start"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-fg-primary border border-border-default rounded-lg hover:bg-surface-tertiary disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {starting ? (
          <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
        ) : null}
        {test
          ? t('integrations.connectionTest.retry', { defaultValue: 'Verify again' })
          : t('integrations.connectionTest.start', { defaultValue: 'Verify connection' })}      </button>
    </div>
  );
}
