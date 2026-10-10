/**
 * Feishu extras — the capabilities that are genuinely Feishu-specific and do
 * NOT belong in a generic form: scan-to-register an app (QR), the bot chat
 * picker, the notification-forwarding preferences, and "send a test message".
 *
 * It renders *inside* the generic `<PlatformCard>` and edits the card's draft
 * through `ctx.setValue`; it never saves on its own, so the card remains the
 * single writer of the platform config.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { api } from '../../api.ts';
import type { PlatformExtrasContext, PlatformField } from '../../lib/platformIntegrations.ts';
import { FieldInput } from './PlatformCard.tsx';

type RegisterState = 'idle' | 'waiting_qr' | 'scanning' | 'done' | 'error';

interface BotChat {
  chatId: string;
  name: string;
  description?: string;
}

function panel(title: string, children: React.ReactNode) {
  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  );
}

export function FeishuExtras({ ctx }: { ctx: PlatformExtrasContext }) {
  const { t } = useTranslation(['settings', 'common']);
  const { status, values, setValue, reload } = ctx;

  const fieldOf = useCallback(
    (key: string): PlatformField | undefined => status.fields.find((f) => f.key === key),
    [status.fields],
  );

  const [chats, setChats] = useState<BotChat[]>([]);
  const [loadingChats, setLoadingChats] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  const [registerState, setRegisterState] = useState<RegisterState>('idle');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const credentialsStored = status.secrets['appSecret']?.hasValue === true || status.hasConfig;
  const configured = credentialsStored && !!values['appId'];

  useEffect(() => () => { if (pollTimer.current) clearInterval(pollTimer.current); }, []);

  const loadChats = useCallback(async () => {
    setLoadingChats(true);
    try {
      const data = await api.settings.listFeishuChats();
      setChats((data.chats ?? []) as BotChat[]);
    } catch { /* not configured / offline — leave the list as-is */ }
    finally { setLoadingChats(false); }
  }, []);

  useEffect(() => {
    if (credentialsStored) void loadChats();
  }, [credentialsStored, loadChats]);

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
      const result = await api.settings.registerFeishuApp();
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
      if (result.success && result.appId) {
        setRegisterState('done');
        setMsg({ type: 'ok', text: t('settings:feishu.registerSuccess', { defaultValue: 'App created successfully! Integration is now active.' }) });
        await reload();
        await loadChats();
      } else {
        setRegisterState('error');
        setMsg({ type: 'err', text: result.message ?? t('settings:feishu.registerFailed', { defaultValue: 'Registration failed' }) });
      }
    } catch (err) {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
      setRegisterState('error');
      setMsg({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    }
  }, [reload, loadChats, t]);

  const cancelRegister = useCallback(() => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    setRegisterState('idle');
    setQrDataUrl(null);
  }, []);

  const sendTest = useCallback(async () => {
    const chatId = String(values['notifyChatId'] ?? '').trim();
    if (!chatId) {
      setMsg({ type: 'err', text: t('settings:feishu.chatIdRequired', { defaultValue: 'Please select a group chat first' }) });
      return;
    }
    setSending(true);
    setMsg(null);
    try {
      const result = await api.settings.sendFeishuTestMessage({ chatId });
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
  }, [values, t]);

  const notifyChatId = fieldOf('notifyChatId');
  const toggleFields = ['notifyOnApproval', 'notifyOnNotification']
    .map(fieldOf)
    .filter((f): f is PlatformField => !!f);

  return (
    <div className="space-y-5" data-testid="feishu-extras">
      {/* Scan-to-register — only useful before credentials exist. */}
      {!credentialsStored && (
        <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-3" data-testid="feishu-register">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-fg-primary">
                {t('settings:feishu.oneClickTitle', { defaultValue: 'One-Click Feishu Integration' })}
              </div>
              <p className="text-xs text-fg-tertiary mt-0.5 max-w-md">
                {t('settings:feishu.oneClickDesc', { defaultValue: 'Scan a QR code with Feishu to create and configure the app automatically. Or fill in the credentials above.' })}
              </p>
            </div>
            <button
              type="button"
              onClick={startRegister}
              disabled={registerState === 'waiting_qr' || registerState === 'scanning' || registerState === 'done'}
              data-testid="feishu-register-start"
              className="shrink-0 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {t('settings:feishu.scanToCreate', { defaultValue: 'Scan QR Code' })}
            </button>
          </div>
          {qrDataUrl && (
            <div className="text-center space-y-2" data-testid="feishu-qr">
              <div className="inline-block p-3 bg-white rounded-xl shadow-sm border border-gray-200">
                <img src={qrDataUrl} alt="Feishu QR Code" className="w-48 h-48" />
              </div>
              <p className="text-xs text-fg-tertiary">
                {t('settings:feishu.scanWithFeishu', { defaultValue: 'Scan with the Feishu app to authorize.' })}
              </p>
              <button type="button" onClick={cancelRegister} className="text-xs text-fg-tertiary hover:text-fg-secondary">
                {t('common:cancel', { defaultValue: 'Cancel' })}
              </button>
            </div>
          )}
          {registerState === 'scanning' && !qrDataUrl && (
            <div className="flex items-center justify-center py-4">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>
      )}

      {/* Notification forwarding — target + filters, rendered together.
          Hidden until credentials exist: without them the chat list cannot be
          fetched and the panel would be dead weight above the credentials. */}
      {credentialsStored && notifyChatId && panel(
        t('settings:feishu.notificationForwarding', { defaultValue: 'Notification forwarding' }),
        <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
          <div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <FieldInput
                  field={notifyChatId}
                  platformId="feishu"
                  value={values['notifyChatId']}
                  hasStored={false}
                  onChange={setValue}
                />
              </div>
              <button
                type="button"
                onClick={() => void loadChats()}
                disabled={loadingChats || !credentialsStored}
                data-testid="feishu-refresh-chats"
                className="mb-0.5 shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-surface-primary border border-border-default rounded-lg text-fg-secondary hover:bg-surface-overlay disabled:opacity-50 transition-colors"
              >
                {loadingChats ? <div className="w-3.5 h-3.5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" /> : null}
                {t('settings:integrations.loadGroups', { defaultValue: 'Load groups' })}
              </button>
            </div>
            {chats.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5" data-testid="feishu-chat-list">
                {chats.map((c) => (
                  <button
                    key={c.chatId}
                    type="button"
                    data-chat-id={c.chatId}
                    onClick={() => setValue('notifyChatId', c.chatId)}
                    className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                      values['notifyChatId'] === c.chatId
                        ? 'bg-brand-500/10 border-brand-500/30 text-brand-600'
                        : 'bg-surface-primary border-border-default text-fg-tertiary hover:border-fg-tertiary'
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {toggleFields.map((f) => (
            <FieldInput key={f.key} field={f} platformId="feishu" value={values[f.key]} hasStored={false} onChange={setValue} />
          ))}

          <div className="pt-1">
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
          </div>
        </div>,
      )}

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

      {configured && !notifyChatId && (
        <p className="text-xs text-fg-tertiary" data-testid="feishu-tip">
          {t('settings:integrations.configuredTip', { defaultValue: 'Feishu is configured. Set a default chat above to receive notifications.' })}
        </p>
      )}
    </div>
  );
}
