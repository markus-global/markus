/**
 * Feishu extras — the guided, Feishu-specific way to *create* the app: scan a
 * QR code and the app is registered + configured in one step.
 *
 * ── Where this sits in the setup flow ───────────────────────────────────────
 * Feishu can establish its own credentials two ways — scan (this panel) or type
 * an app id + secret by hand. Those are alternatives, not a checklist, so the
 * card shows a method chooser and mounts exactly one of them (see
 * `PlatformExtras.guidedSetup`). This panel is the *guided* option only; the
 * manual credential inputs are rendered by the card. They are never on screen
 * together — which is also why this file no longer carries its own "or fill in
 * the credentials above" copy.
 *
 * ── The agent is part of what the QR creates ────────────────────────────────
 * The app is created server-side the instant the scan is confirmed, and it is
 * created *as* the chosen agent (the backend names the Feishu app after it and
 * binds the bot to it). So the agent is picked here, before the scan, and the
 * picker locks the moment the QR is minted: letting it change afterwards would
 * show one agent while the created bot answers as another. Cancelling the scan
 * unlocks it again.
 *
 * Rendered by `<InstanceCard>` (inside the credentials section, while the guided
 * method is selected) and edits the card's draft through `ctx`; it never saves on
 * its own, so the card remains the single writer of the bot's config.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { api } from '../../api.ts';
import type { PlatformExtrasContext } from '../../lib/platformIntegrations.ts';
import { chatDestinationField } from '../../lib/platformNotifications.ts';
import { AgentSelect } from './AgentSelect.tsx';

type RegisterState = 'idle' | 'waiting_qr' | 'scanning' | 'done' | 'error';

export function FeishuExtras({ ctx }: { ctx: PlatformExtrasContext }) {
  const { t } = useTranslation(['settings', 'common']);
  const { values, reload, onCreated, agents = [] } = ctx;

  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [registerState, setRegisterState] = useState<RegisterState>('idle');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  /**
   * Which agent answers for the bot being created. Chosen *before* the scan,
   * because the bot is created server-side the moment the QR is confirmed —
   * without an explicit pick it would silently fall back to the org Secretary,
   * which is almost never the bot the user meant to add.
   */
  const [agentId, setAgentId] = useState(() => String(values['agentId'] ?? ''));
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * Once the QR is minted the agent is committed — the app is created with its
   * identity the moment the scan is confirmed. Cancel unlocks it (back to
   * `idle`).
   */
  const agentLocked = registerState !== 'idle';

  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);

  const stopPoll = useCallback(() => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
  }, []);

  const startRegister = useCallback(async () => {
    setRegisterState('waiting_qr');
    setQrDataUrl(null);
    setMsg(null);
    pollTimer.current = setInterval(async () => {
      try {
        const st = await api.settings.getFeishuRegisterStatus();
        if (st.active && st.url) {
          setRegisterState('scanning');
          try {
            setQrDataUrl(await QRCode.toDataURL(st.url, { width: 192, margin: 2, color: { dark: '#000000', light: '#ffffff' } }));
          } catch { /* render error — leave the spinner */ }
        }
      } catch { /* keep polling */ }
    }, 1000);
    try {
      const result = await api.settings.registerFeishuApp({ agentId: agentId || undefined });
      stopPoll();
      if (result.success && result.appId) {
        setRegisterState('done');
        setMsg({ type: 'ok', text: t('settings:feishu.registerSuccess', { defaultValue: 'App created successfully! Integration is now active.' }) });
        await reload();
        // The scan created a real bot server-side: close this draft and open
        // its card, so the flow lands on "bind an agent" rather than leaving an
        // empty credential form on screen next to the bot it just made.
        if (result.instanceId) onCreated?.(result.instanceId);
      } else {
        setRegisterState('error');
        setMsg({ type: 'err', text: result.message ?? t('settings:feishu.registerFailed', { defaultValue: 'Registration failed' }) });
      }
    } catch (err) {
      stopPoll();
      setRegisterState('error');
      setMsg({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  }, [reload, onCreated, agentId, t, stopPoll]);

  const cancelRegister = useCallback(() => {
    stopPoll();
    setRegisterState('idle');
    setQrDataUrl(null);
    setMsg(null);
  }, [stopPoll]);

  return (
    <div className="space-y-4" data-testid="feishu-extras">
      <div
        className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4"
        data-testid="feishu-register"
      >
        {/* Bind the answering agent up front — the bot is created the instant
            the scan is confirmed, so this cannot wait until the card opens. It
            locks while a QR is live, because the app is minted with this agent. */}
        <div className="max-w-sm">
          <label className="block text-xs font-medium text-fg-secondary mb-1.5" htmlFor="feishu-register-agent">
            {t('settings:feishu.bindAgent', { defaultValue: 'Agent that answers for this bot' })}
            <span className="text-red-500 ml-0.5" aria-hidden="true">*</span>
          </label>
          <AgentSelect
            value={agentId}
            options={agents}
            onChange={(_key, next) => setAgentId(typeof next === 'string' ? next : '')}
            fieldKey="agentId"
            disabled={agentLocked}
            ariaLabel={t('settings:feishu.bindAgent', { defaultValue: 'Agent that answers for this bot' })}
          />
          <p className="text-[11px] text-fg-tertiary mt-1">
            {agentLocked
              ? t('settings:feishu.bindAgentLocked', { defaultValue: 'This agent is baked into the QR — cancel the scan to change it.' })
              : t('settings:feishu.bindAgentHint', { defaultValue: 'The Feishu app is created as this agent. Pick it now so the bot is never wired to the wrong one.' })}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={startRegister}
            disabled={!agentId || registerState !== 'idle'}
            data-testid="feishu-register-start"
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {t('settings:feishu.scanToCreate', { defaultValue: 'Scan QR Code' })}
          </button>
          {agentLocked && registerState !== 'done' && (
            <button
              type="button"
              onClick={cancelRegister}
              data-testid="feishu-register-cancel"
              className="text-xs text-fg-tertiary hover:text-fg-secondary"
            >
              {t('common:cancel', { defaultValue: 'Cancel' })}
            </button>
          )}
        </div>

        {qrDataUrl && (
          <div className="text-center space-y-2" data-testid="feishu-qr">
            <div className="inline-block p-3 bg-white rounded-xl shadow-sm border border-gray-200">
              <img src={qrDataUrl} alt={t('settings:feishu.qrAlt')} className="w-48 h-48" />
            </div>
            <p className="text-xs text-fg-tertiary">
              {t('settings:feishu.scanWithFeishu', { defaultValue: 'Scan with the Feishu app to authorize.' })}
            </p>
          </div>
        )}
        {registerState === 'scanning' && !qrDataUrl && (
          <div className="flex items-center justify-center py-4">
            <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {msg && (
        <div
          data-testid={msg.type === 'ok' ? 'feishu-msg-ok' : 'feishu-msg-err'}
          className={`px-3 py-2 rounded-lg text-xs ${
            msg.type === 'ok'
              ? 'bg-green-500/10 text-green-600 border border-green-500/30'
              : 'bg-red-500/10 text-red-600 border border-red-500/30'
          }`}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}

/**
 * The Feishu "send a test message" control.
 *
 * Injected into the generic `NotificationPanel` through
 * `PlatformExtras.sendTest`, so the panel itself stays platform-agnostic: only
 * the one call that needs Feishu's endpoint lives here. The chat it sends to is
 * read from the *manifest* (`chatDestinationField`) rather than a hard-coded
 * key, so a manifest rename cannot silently point the test at nothing.
 */
export function FeishuTestMessage({ ctx }: { ctx: PlatformExtrasContext }) {
  const { t } = useTranslation(['settings', 'common']);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const chatField = chatDestinationField(ctx.status.fields);
  const chatId = String(chatField ? ctx.values[chatField.key] ?? '' : '').trim();
  const instanceId = ctx.instanceId;

  const sendTest = useCallback(async () => {
    if (!chatId) {
      setMsg({ type: 'err', text: t('settings:feishu.chatIdRequired', { defaultValue: 'Please select a group chat first' }) });
      return;
    }
    setSending(true);
    setMsg(null);
    try {
      // The test goes out from *this* bot's own app, not whatever the legacy
      // platform row still holds — otherwise a test on bot B could be sent by
      // bot A's credentials.
      const result = await api.settings.sendFeishuTestMessage({ chatId, ...(instanceId ? { instanceId } : {}) });
      setMsg(
        result.success
          ? { type: 'ok', text: result.message ?? t('settings:feishu.testMsgSent', { defaultValue: 'Test message sent' }) }
          : { type: 'err', text: result.message ?? t('settings:feishu.testMsgFailed', { defaultValue: 'Failed to send test message' }) },
      );
    } catch (err) {
      setMsg({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSending(false);
    }
  }, [chatId, instanceId, t]);

  return (
    <div className="space-y-2" data-testid="feishu-test">
      <button
        type="button"
        onClick={sendTest}
        disabled={sending}
        data-testid="feishu-test-message"
        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-surface-primary border border-border-default rounded-lg text-fg-secondary hover:bg-surface-overlay disabled:opacity-50 transition-colors"
      >
        {sending ? <div className="w-3.5 h-3.5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" /> : null}
        {t('settings:feishu.sendTestMessage', { defaultValue: 'Send test message' })}
      </button>
      {msg && (
        <div
          data-testid={msg.type === 'ok' ? 'feishu-msg-ok' : 'feishu-msg-err'}
          className={`px-3 py-2 rounded-lg text-xs ${
            msg.type === 'ok'
              ? 'bg-green-500/10 text-green-600 border border-green-500/30'
              : 'bg-red-500/10 text-red-600 border border-red-500/30'
          }`}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}
