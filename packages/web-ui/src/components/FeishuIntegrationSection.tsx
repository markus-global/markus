import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import QRCode from 'qrcode';
import { api } from '../api.ts';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  enabled: boolean;
  connected: boolean;
  notifyChatId: string;
  notifyOnApproval: boolean;
  notifyOnNotification: boolean;
  notifyPriority: string[];
}

const DEFAULT_CONFIG: FeishuConfig = {
  appId: '',
  appSecret: '',
  enabled: false,
  connected: false,
  notifyChatId: '',
  notifyOnApproval: true,
  notifyOnNotification: false,
  notifyPriority: ['high', 'urgent'],
};

const PRIORITY_OPTIONS = [
  { value: 'normal', color: 'bg-green-400' },
  { value: 'low', color: 'bg-gray-400' },
  { value: 'medium', color: 'bg-blue-400' },
  { value: 'high', color: 'bg-amber-400' },
  { value: 'urgent', color: 'bg-red-400' },
] as const;

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
        connected
          ? 'bg-green-500/10 text-green-600 border border-green-500/30'
          : 'bg-gray-500/10 text-gray-500 border border-gray-500/30'
      }`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          connected ? 'bg-green-500 animate-pulse' : 'bg-gray-400'
        }`}
      />
      {connected ? 'Connected' : 'Disconnected'}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-fg-primary uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  );
}

function Msg({ type, text }: { type: 'ok' | 'err'; text: string }) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
        type === 'ok'
          ? 'bg-green-500/10 text-green-600 border border-green-500/30'
          : 'bg-red-500/10 text-red-600 border border-red-500/30'
      }`}
    >
      {type === 'ok' ? (
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
      ) : (
        <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
      )}
      {text}
    </div>
  );
}

type RegisterState = 'idle' | 'waiting_qr' | 'scanning' | 'done' | 'error';

export function FeishuIntegrationSection() {
  const { t } = useTranslation(['settings', 'common']);

  const [config, setConfig] = useState<FeishuConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sendingMsg, setSendingMsg] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [testChatId, setTestChatId] = useState('');

  // Bot chat list for chat selector
  const [botChats, setBotChats] = useState<Array<{ chatId: string; name: string; description?: string; avatar?: string }>>([]);
  const [loadingChats, setLoadingChats] = useState(false);

  // QR code registration state
  const [registerState, setRegisterState] = useState<RegisterState>('idle');
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrExpireIn, setQrExpireIn] = useState(0);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const registerAbort = useRef<AbortController | null>(null);

  // Manual config toggle (advanced)
  const [showManualConfig, setShowManualConfig] = useState(false);
  const [showAppSecret, setShowAppSecret] = useState(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const initialLoadDone = useRef(false);

  const loadBotChats = useCallback(async () => {
    setLoadingChats(true);
    try {
      const data = await api.settings.listFeishuChats();
      setBotChats(data.chats ?? []);
    } catch { /* ignore */ }
    finally { setLoadingChats(false); }
  }, []);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.settings.getFeishuIntegration();
      if (data) {
        setConfig({
          appId: data.appId ?? '',
          appSecret: data.appSecret ?? '',
          enabled: data.enabled ?? false,
          connected: data.connected ?? false,
          notifyChatId: data.notifyChatId ?? '',
          notifyOnApproval: data.notifyOnApproval ?? true,
          notifyOnNotification: data.notifyOnNotification ?? false,
          notifyPriority: data.notifyPriority ?? ['high', 'urgent'],
        });
        if (data.appId && data.appSecret) {
          loadBotChats();
        }
      }
    } catch {
      // Not configured yet
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // Cleanup poll timer on unmount
  useEffect(() => {
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, []);

  const doSave = useCallback(async (cfg: FeishuConfig) => {
    if (!cfg.appId || !cfg.appSecret) return;
    setSaving(true);
    try {
      const result = await api.settings.saveFeishuIntegration({
        appId: cfg.appId,
        appSecret: cfg.appSecret,
        enabled: cfg.enabled,
        notifyChatId: cfg.notifyChatId || undefined,
        notifyOnApproval: cfg.notifyOnApproval,
        notifyOnNotification: cfg.notifyOnNotification,
        notifyPriority: cfg.notifyPriority,
      });
      if (result.connected !== undefined) {
        setConfig(prev => ({ ...prev, connected: result.connected }));
      }
      setMsg({ type: 'ok', text: t('settings:feishu.saved', { defaultValue: 'Saved' }) });
      setTimeout(() => setMsg(prev => prev?.type === 'ok' ? null : prev), 2000);
    } catch (err) {
      setMsg({ type: 'err', text: String(err instanceof Error ? err.message : err) });
    } finally {
      setSaving(false);
    }
  }, [t]);

  const scheduleSave = useCallback(() => {
    if (!initialLoadDone.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      doSave(configRef.current);
    }, 600);
  }, [doSave]);

  const updateField = <K extends keyof FeishuConfig>(key: K, value: FeishuConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setMsg(null);
    scheduleSave();
  };

  const updateFieldImmediate = <K extends keyof FeishuConfig>(key: K, value: FeishuConfig[K]) => {
    setConfig(prev => {
      const next = { ...prev, [key]: value };
      configRef.current = next;
      return next;
    });
    setMsg(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    doSave({ ...configRef.current, [key]: value });
  };

  const togglePriority = (priority: string) => {
    setConfig(prev => {
      const current = prev.notifyPriority;
      const next = current.includes(priority)
        ? current.filter(p => p !== priority)
        : [...current, priority];
      const updated = { ...prev, notifyPriority: next };
      configRef.current = updated;
      return updated;
    });
    setMsg(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      doSave(configRef.current);
    }, 300);
  };

  // --- QR Code Registration Flow ---
  const startRegister = async () => {
    setRegisterState('waiting_qr');
    setQrUrl(null);
    setQrDataUrl(null);
    setMsg(null);

    // Start polling for QR code status
    pollTimer.current = setInterval(async () => {
      try {
        const status = await api.settings.getFeishuRegisterStatus();
        if (status.active && status.url) {
          setQrUrl(status.url);
          setQrExpireIn(status.expireIn ?? 300);
          setRegisterState('scanning');
          // Generate QR code data URL from the authorization URL
          try {
            const dataUrl = await QRCode.toDataURL(status.url, {
              width: 200,
              margin: 2,
              color: { dark: '#000000', light: '#ffffff' },
            });
            setQrDataUrl(dataUrl);
          } catch { /* QR generation error */ }
        }
      } catch { /* ignore poll errors */ }
    }, 1000);

    // Trigger the registration (this is a long-poll request that resolves when user scans)
    try {
      const result = await api.settings.registerFeishuApp();
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }

      if (result.success && result.appId) {
        setRegisterState('done');
        setMsg({ type: 'ok', text: t('settings:feishu.registerSuccess', { defaultValue: 'App created successfully! Integration is now active.' }) });
        // Reload config to get the new credentials
        await loadConfig();
      } else {
        setRegisterState('error');
        setMsg({ type: 'err', text: result.message || t('settings:feishu.registerFailed', { defaultValue: 'Registration failed' }) });
      }
    } catch (err) {
      if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
      setRegisterState('error');
      setMsg({ type: 'err', text: String(err instanceof Error ? err.message : err) });
    }
  };

  const cancelRegister = () => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    if (registerAbort.current) registerAbort.current.abort();
    setRegisterState('idle');
    setQrUrl(null);
    setQrDataUrl(null);
  };

  const handleTest = async () => {
    if (!config.appId || !config.appSecret) {
      setMsg({ type: 'err', text: t('settings:feishu.fillRequired', { defaultValue: 'Please fill in App ID and App Secret first' }) });
      return;
    }
    setTesting(true);
    setMsg(null);
    try {
      const result = await api.settings.testFeishuConnection({
        appId: config.appId,
        appSecret: config.appSecret,
      });
      if (result.success) {
        setConfig(prev => ({ ...prev, connected: true }));
        setMsg({ type: 'ok', text: result.message || t('settings:feishu.testSuccess', { defaultValue: 'Connection successful' }) });
      } else {
        setMsg({ type: 'err', text: result.message || t('settings:feishu.testFailed', { defaultValue: 'Connection failed' }) });
      }
    } catch (err) {
      setMsg({ type: 'err', text: String(err instanceof Error ? err.message : err) });
    } finally {
      setTesting(false);
    }
  };

  const handleSendTestMessage = async () => {
    if (!testChatId.trim()) {
      setMsg({ type: 'err', text: t('settings:feishu.chatIdRequired', { defaultValue: 'Please select a group chat' }) });
      return;
    }
    setSendingMsg(true);
    setMsg(null);
    try {
      const result = await api.settings.sendFeishuTestMessage({ chatId: testChatId.trim() });
      if (result.success) {
        setMsg({ type: 'ok', text: result.message || t('settings:feishu.testMsgSent', { defaultValue: 'Test message sent' }) });
      } else {
        setMsg({ type: 'err', text: result.message || t('settings:feishu.testMsgFailed', { defaultValue: 'Failed to send test message' }) });
      }
    } catch (err) {
      setMsg({ type: 'err', text: String(err instanceof Error ? err.message : err) });
    } finally {
      setSendingMsg(false);
    }
  };

  const handleDisconnect = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.settings.deleteFeishuIntegration();
      initialLoadDone.current = false;
      setConfig(DEFAULT_CONFIG);
      initialLoadDone.current = true;
      setShowManualConfig(false);
      setMsg({ type: 'ok', text: t('settings:feishu.disconnected', { defaultValue: 'Disconnected from Feishu' }) });
    } catch (err) {
      setMsg({ type: 'err', text: String(err instanceof Error ? err.message : err) });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-surface-elevated border border-border-default rounded-xl p-6">
        <div className="flex items-center justify-center py-8">
          <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
          <span className="ml-2 text-sm text-fg-tertiary">{t('common:loading', { defaultValue: 'Loading...' })}</span>
        </div>
      </div>
    );
  }

  const isConfigured = !!(config.appId && config.appSecret);

  return (
    <div className="bg-surface-elevated border border-border-default rounded-xl p-6 space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
            <svg className="w-6 h-6 text-blue-500" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6.3 10.5c-.8 0-1.5-.3-2-.9-.6-.6-.9-1.3-.9-2 0-.8.3-1.5.9-2 .6-.5 1.3-.8 2-.8.8 0 1.5.3 2 .9.6.6.9 1.3.9 2 0 .8-.3 1.5-.9 2-.5.5-1.2.8-2 .8zm12.4 0c-.8 0-1.5-.3-2-.9-.6-.6-.9-1.3-.9-2 0-.8.3-1.5.9-2 .6-.5 1.3-.8 2-.8.8 0 1.5.3 2 .9.6.6.9 1.3.9 2 0 .8-.3 1.5-.9 2-.5.5-1.2.8-2 .8zm-6.2 10c-.8 0-1.5-.3-2-.9-.6-.6-.9-1.3-.9-2 0-.8.3-1.5.9-2 .6-.5 1.3-.8 2-.8.8 0 1.5.3 2 .9.6.6.9 1.3.9 2 0 .8-.3 1.5-.9 2-.5.5-1.2.8-2 .8z"/>
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-fg-primary">飞书 (Feishu / Lark)</h2>
            <p className="text-xs text-fg-tertiary mt-0.5">{t('settings:feishu.description', { defaultValue: 'Configure Feishu integration for notifications and approvals' })}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {saving && <div className="w-3.5 h-3.5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />}
          <StatusBadge connected={config.connected && config.enabled} />
        </div>
      </div>

      {/* Connection mode indicator */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/5 border border-blue-500/20">
        <svg className="w-4 h-4 text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="text-xs text-fg-secondary">
          {t('settings:feishu.longConnectionMode', { defaultValue: 'Using long connection mode (WebSocket) — no public IP required' })}
        </span>
      </div>

      {/* One-Click Setup or Connected State */}
      {!isConfigured ? (
        <Section title={t('settings:feishu.quickSetup', { defaultValue: 'Quick Setup' })}>
          <div className="bg-surface-secondary border border-border-default rounded-xl p-6 space-y-5">
            {registerState === 'idle' || registerState === 'error' || registerState === 'done' ? (
              <>
                <div className="text-center space-y-3">
                  <div className="w-16 h-16 mx-auto rounded-2xl bg-gradient-to-br from-blue-500/20 to-indigo-500/20 border border-blue-500/30 flex items-center justify-center">
                    <svg className="w-8 h-8 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-fg-primary">
                      {t('settings:feishu.oneClickTitle', { defaultValue: 'One-Click Feishu Integration' })}
                    </h3>
                    <p className="text-xs text-fg-tertiary mt-1 max-w-sm mx-auto">
                      {t('settings:feishu.oneClickDesc', { defaultValue: 'Scan a QR code with Feishu to automatically create and configure the app. No manual setup needed.' })}
                    </p>
                  </div>
                  <button
                    onClick={startRegister}
                    disabled={registerState === 'done'}
                    className="inline-flex items-center gap-2 px-6 py-2.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                    </svg>
                    {t('settings:feishu.scanToCreate', { defaultValue: 'Scan QR Code to Create App' })}
                  </button>
                </div>

                <div className="border-t border-border-default pt-4">
                  <p className="text-[11px] text-fg-tertiary text-center">
                    {t('settings:feishu.oneClickPermissions', { defaultValue: 'The app will be created with permissions: bot messaging, message receiving, user info reading, and group chat management.' })}
                  </p>
                </div>
              </>
            ) : (
              /* QR Code Display */
              <div className="text-center space-y-4">
                {registerState === 'waiting_qr' && !qrUrl && (
                  <div className="flex flex-col items-center gap-3 py-6">
                    <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-fg-secondary">
                      {t('settings:feishu.generatingQR', { defaultValue: 'Generating QR code...' })}
                    </p>
                  </div>
                )}

                {qrUrl && (
                  <>
                    <div className="inline-block p-4 bg-white rounded-xl shadow-sm border border-gray-200">
                      {qrDataUrl ? (
                        <img src={qrDataUrl} alt="Feishu QR Code" className="w-48 h-48" />
                      ) : (
                        <div className="w-48 h-48 flex items-center justify-center">
                          <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                        </div>
                      )}
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-fg-primary">
                        {t('settings:feishu.scanWithFeishu', { defaultValue: 'Scan with Feishu app' })}
                      </p>
                      <p className="text-xs text-fg-tertiary">
                        {t('settings:feishu.scanHint', { defaultValue: 'Use your Feishu mobile app to scan and authorize. The app will be created in your organization.' })}
                      </p>
                      {qrExpireIn > 0 && (
                        <p className="text-[11px] text-fg-tertiary">
                          {t('settings:feishu.qrExpire', { defaultValue: `QR code expires in ${Math.floor(qrExpireIn / 60)} minutes`, minutes: Math.floor(qrExpireIn / 60) })}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={cancelRegister}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs text-fg-tertiary hover:text-fg-secondary border border-border-default rounded-lg hover:bg-surface-overlay transition-colors"
                    >
                      {t('common:cancel', { defaultValue: 'Cancel' })}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Manual Configuration Fallback */}
          <div className="mt-4">
            <button
              onClick={() => setShowManualConfig(!showManualConfig)}
              className="inline-flex items-center gap-1.5 text-xs text-fg-tertiary hover:text-fg-secondary transition-colors"
            >
              <svg className={`w-3 h-3 transition-transform ${showManualConfig ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {t('settings:feishu.manualConfig', { defaultValue: 'Manual configuration (advanced)' })}
            </button>

            {showManualConfig && (
              <div className="mt-3 bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-fg-secondary mb-1.5">
                    App ID <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={config.appId}
                    onChange={e => updateField('appId', e.target.value)}
                    onBlur={() => { if (config.appId && config.appSecret) { if (saveTimer.current) clearTimeout(saveTimer.current); doSave(configRef.current); } }}
                    placeholder="cli_xxxxxxxxxxxxxx"
                    className="w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-fg-secondary mb-1.5">
                    App Secret <span className="text-red-500">*</span>
                  </label>
                  <div className="relative">
                    <input
                      type={showAppSecret ? 'text' : 'password'}
                      value={config.appSecret}
                      onChange={e => updateField('appSecret', e.target.value)}
                      onBlur={() => { if (config.appId && config.appSecret) { if (saveTimer.current) clearTimeout(saveTimer.current); doSave(configRef.current); } }}
                      placeholder="Enter your Feishu app secret"
                      className="w-full px-3 py-2 pr-10 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowAppSecret(!showAppSecret)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-tertiary hover:text-fg-secondary transition-colors"
                    >
                      {showAppSecret ? (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </Section>
      ) : (
        /* Already Configured — show app info and actions */
        <>
          <Section title={t('settings:feishu.appInfo', { defaultValue: 'App Information' })}>
            <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-fg-secondary">App ID:</span>
                    <code className="text-xs font-mono text-fg-primary bg-surface-primary px-2 py-0.5 rounded">{config.appId}</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-fg-secondary">App Secret:</span>
                    <code className="text-xs font-mono text-fg-primary bg-surface-primary px-2 py-0.5 rounded">
                      {'•'.repeat(Math.min(config.appSecret.length, 20))}
                    </code>
                  </div>
                </div>
                <button
                  onClick={handleDisconnect}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  {t('settings:feishu.removeApp', { defaultValue: 'Remove' })}
                </button>
              </div>
            </div>
          </Section>

          {/* Enable / Disable Toggle */}
          <Section title={t('settings:feishu.integrationState', { defaultValue: 'Integration State' })}>
            <div className="bg-surface-secondary border border-border-default rounded-xl p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-fg-primary">
                    {t('settings:feishu.enableIntegration', { defaultValue: 'Enable Feishu Integration' })}
                  </div>
                  <div className="text-xs text-fg-tertiary mt-0.5">
                    {t('settings:feishu.enableHint', { defaultValue: 'When enabled, Markus will establish a long connection to Feishu and start processing events' })}
                  </div>
                </div>
                <button
                  onClick={() => updateFieldImmediate('enabled', !config.enabled)}
                  className={`relative w-12 h-6 rounded-full transition-colors duration-200 ${
                    config.enabled ? 'bg-brand-600' : 'bg-gray-300 dark:bg-gray-600'
                  } cursor-pointer`}
                >
                  <span className={`block w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200 ${
                    config.enabled ? 'translate-x-6' : 'translate-x-0.5'
                  }`} />
                </button>
              </div>
            </div>
          </Section>

          {/* Actions */}
          <Section title={t('settings:feishu.actions', { defaultValue: 'Actions' })}>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handleTest}
                disabled={testing}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-surface-primary border border-border-default rounded-lg text-fg-primary hover:bg-surface-overlay disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {testing ? (
                  <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                )}
                {t('settings:feishu.testConnection', { defaultValue: 'Test Connection' })}
              </button>
            </div>

            {/* Send Test Message */}
            {config.connected && config.enabled && (
              <div className="mt-4 p-4 bg-surface-secondary border border-border-default rounded-xl space-y-3">
                <label className="block text-xs font-medium text-fg-secondary">
                  {t('settings:feishu.sendTestMessage', { defaultValue: 'Send Test Message' })}
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <select
                      value={testChatId}
                      onChange={e => setTestChatId(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors appearance-none pr-8"
                    >
                      <option value="">{t('settings:feishu.selectTestChat', { defaultValue: '— Select a group chat —' })}</option>
                      {botChats.map(chat => (
                        <option key={chat.chatId} value={chat.chatId}>
                          {chat.name || chat.chatId}
                        </option>
                      ))}
                    </select>
                    <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-tertiary pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                  <button
                    onClick={handleSendTestMessage}
                    disabled={sendingMsg || !testChatId.trim()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-surface-primary border border-border-default rounded-lg text-fg-primary hover:bg-surface-overlay disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
                  >
                    {sendingMsg ? (
                      <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                    )}
                    {t('settings:feishu.send', { defaultValue: 'Send' })}
                  </button>
                </div>
              </div>
            )}

            {msg && <Msg type={msg.type} text={msg.text} />}
          </Section>

          {/* Notification Forwarding Settings */}
          <Section title={t('settings:feishu.notificationForwarding', { defaultValue: 'Notification Forwarding' })}>
            <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-5">
              {/* Target Chat ID */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-medium text-fg-secondary">
                    {t('settings:feishu.notifyChatId', { defaultValue: 'Notification Target Group' })}
                  </label>
                  <button
                    onClick={loadBotChats}
                    disabled={loadingChats}
                    className="inline-flex items-center gap-1 text-[11px] text-brand-600 hover:text-brand-700 disabled:opacity-50 transition-colors"
                  >
                    <svg className={`w-3 h-3 ${loadingChats ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    {t('settings:feishu.refreshChats', { defaultValue: 'Refresh' })}
                  </button>
                </div>
                <div className="relative">
                  <select
                    value={config.notifyChatId}
                    onChange={e => updateFieldImmediate('notifyChatId', e.target.value)}
                    className="w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors appearance-none pr-8"
                  >
                    <option value="">
                      {loadingChats
                        ? t('settings:feishu.loadingChats', { defaultValue: 'Loading groups...' })
                        : t('settings:feishu.selectChat', { defaultValue: '— Private message (default) —' })}
                    </option>
                    {botChats.map(chat => (
                      <option key={chat.chatId} value={chat.chatId}>
                        {chat.name || chat.chatId}
                      </option>
                    ))}
                  </select>
                  <svg className="absolute right-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-fg-tertiary pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </div>
                {!config.notifyChatId && !loadingChats && (
                  <p className="text-[11px] text-fg-tertiary mt-1">
                    {t('settings:feishu.noChatFallbackHint', { defaultValue: 'No group selected — notifications will be sent to you as private messages.' })}
                  </p>
                )}
                {botChats.length === 0 && !loadingChats && config.notifyChatId === '' && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                    {t('settings:feishu.noChatHint', { defaultValue: 'No groups found. Add the bot to a group chat to enable group notifications.' })}
                  </p>
                )}
                {config.notifyChatId && (
                  <p className="text-[11px] text-fg-tertiary mt-1 font-mono">ID: {config.notifyChatId}</p>
                )}
              </div>

              <div className="space-y-3">
                {/* Approval notifications */}
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm text-fg-primary">{t('settings:feishu.forwardApprovals', { defaultValue: 'Forward Approval Requests' })}</div>
                    <div className="text-xs text-fg-tertiary mt-0.5">{t('settings:feishu.forwardApprovalsHint', { defaultValue: 'Send approval requests to Feishu as interactive cards' })}</div>
                  </div>
                  <button
                    onClick={() => updateFieldImmediate('notifyOnApproval', !config.notifyOnApproval)}
                    className={`relative w-10 h-5 rounded-full transition-colors duration-200 ${
                      config.notifyOnApproval ? 'bg-brand-600' : 'bg-gray-300 dark:bg-gray-600'
                    } cursor-pointer`}
                  >
                    <span className={`block w-4 h-4 bg-white rounded-full shadow transform transition-transform duration-200 ${
                      config.notifyOnApproval ? 'translate-x-5' : 'translate-x-0.5'
                    }`} />
                  </button>
                </div>

                {/* General notifications */}
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm text-fg-primary">{t('settings:feishu.forwardNotifications', { defaultValue: 'Forward General Notifications' })}</div>
                    <div className="text-xs text-fg-tertiary mt-0.5">{t('settings:feishu.forwardNotificationsHint', { defaultValue: 'Send system notifications to Feishu chat' })}</div>
                  </div>
                  <button
                    onClick={() => updateFieldImmediate('notifyOnNotification', !config.notifyOnNotification)}
                    className={`relative w-10 h-5 rounded-full transition-colors duration-200 ${
                      config.notifyOnNotification ? 'bg-brand-600' : 'bg-gray-300 dark:bg-gray-600'
                    } cursor-pointer`}
                  >
                    <span className={`block w-4 h-4 bg-white rounded-full shadow transform transition-transform duration-200 ${
                      config.notifyOnNotification ? 'translate-x-5' : 'translate-x-0.5'
                    }`} />
                  </button>
                </div>
              </div>

              {/* Priority filter */}
              {(config.notifyOnApproval || config.notifyOnNotification) && (
                <div>
                  <label className="block text-xs font-medium text-fg-secondary mb-2">
                    {t('settings:feishu.notifyPriority', { defaultValue: 'Minimum Notification Priority' })}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {PRIORITY_OPTIONS.map(({ value, color }) => {
                      const selected = config.notifyPriority.includes(value);
                      return (
                        <button
                          key={value}
                          onClick={() => togglePriority(value)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                            selected
                              ? 'bg-brand-500/10 border-brand-500/30 text-brand-600'
                              : 'bg-surface-primary border-border-default text-fg-tertiary hover:border-fg-tertiary'
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
                          {value.charAt(0).toUpperCase() + value.slice(1)}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-fg-tertiary mt-1.5">
                    {t('settings:feishu.priorityHint', { defaultValue: 'Only notifications with the selected priority levels will be forwarded' })}
                  </p>
                </div>
              )}
            </div>
          </Section>
        </>
      )}

      {msg && !isConfigured && <Msg type={msg.type} text={msg.text} />}
    </div>
  );
}
