import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  webhookPath?: string;
  enabled: boolean;
  connected: boolean;
  notifyOnApproval: boolean;
  notifyOnNotification: boolean;
  notifyPriority: string[];
}

const DEFAULT_CONFIG: FeishuConfig = {
  appId: '',
  appSecret: '',
  verificationToken: '',
  encryptKey: '',
  webhookPath: '/webhook/feishu',
  enabled: false,
  connected: false,
  notifyOnApproval: true,
  notifyOnNotification: false,
  notifyPriority: ['high', 'urgent'],
};

const PRIORITY_OPTIONS = [
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

export function FeishuIntegrationSection() {
  const { t } = useTranslation(['settings', 'common']);

  const [config, setConfig] = useState<FeishuConfig>(DEFAULT_CONFIG);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Show/hide secret values
  const [showAppSecret, setShowAppSecret] = useState(false);
  const [showEncryptKey, setShowEncryptKey] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.settings.getFeishuIntegration();
      if (data) {
        setConfig({
          appId: data.appId ?? '',
          appSecret: data.appSecret ?? '',
          verificationToken: data.verificationToken ?? '',
          encryptKey: data.encryptKey ?? '',
          webhookPath: data.webhookPath ?? '/webhook/feishu',
          enabled: data.enabled ?? false,
          connected: data.connected ?? false,
          notifyOnApproval: data.notifyOnApproval ?? true,
          notifyOnNotification: data.notifyOnNotification ?? false,
          notifyPriority: data.notifyPriority ?? ['high', 'urgent'],
        });
      }
    } catch {
      // Not configured yet — use defaults
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const updateField = <K extends keyof FeishuConfig>(key: K, value: FeishuConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
    setDirty(true);
    setMsg(null);
  };

  const togglePriority = (priority: string) => {
    setConfig(prev => {
      const current = prev.notifyPriority;
      const next = current.includes(priority)
        ? current.filter(p => p !== priority)
        : [...current, priority];
      return { ...prev, notifyPriority: next };
    });
    setDirty(true);
    setMsg(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const result = await api.settings.saveFeishuIntegration({
        appId: config.appId,
        appSecret: config.appSecret,
        verificationToken: config.verificationToken || undefined,
        encryptKey: config.encryptKey || undefined,
        webhookPath: config.webhookPath || '/webhook/feishu',
        enabled: config.enabled,
        notifyOnApproval: config.notifyOnApproval,
        notifyOnNotification: config.notifyOnNotification,
        notifyPriority: config.notifyPriority,
      });
      if (result.connected !== undefined) {
        setConfig(prev => ({ ...prev, connected: result.connected }));
      }
      setDirty(false);
      setMsg({ type: 'ok', text: t('settings:feishu.saved', { defaultValue: 'Feishu configuration saved' }) });
    } catch (err) {
      setMsg({ type: 'err', text: String(err instanceof Error ? err.message : err) });
    } finally {
      setSaving(false);
    }
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

  const handleDisconnect = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.settings.deleteFeishuIntegration();
      setConfig(DEFAULT_CONFIG);
      setDirty(false);
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

  return (
    <div className="bg-surface-elevated border border-border-default rounded-xl p-6 space-y-8">
      {/* Header — Connection status + Feishu branding */}
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
        <StatusBadge connected={config.connected && config.enabled} />
      </div>

      {/* Connection Settings */}
      <Section title={t('settings:feishu.connectionSettings', { defaultValue: 'Connection Settings' })}>
        <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-4">
          {/* App ID */}
          <div>
            <label className="block text-xs font-medium text-fg-secondary mb-1.5">
              App ID <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={config.appId}
              onChange={e => updateField('appId', e.target.value)}
              placeholder="cli_xxxxxxxxxxxxxx"
              className="w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors font-mono"
            />
          </div>

          {/* App Secret */}
          <div>
            <label className="block text-xs font-medium text-fg-secondary mb-1.5">
              App Secret <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <input
                type={showAppSecret ? 'text' : 'password'}
                value={config.appSecret}
                onChange={e => updateField('appSecret', e.target.value)}
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

          {/* Verify Token */}
          <div>
            <label className="block text-xs font-medium text-fg-secondary mb-1.5">
              {t('settings:feishu.verificationToken', { defaultValue: 'Verify Token' })}
              <span className="text-fg-tertiary ml-1">({t('settings:feishu.optional', { defaultValue: 'optional' })})</span>
            </label>
            <input
              type="text"
              value={config.verificationToken ?? ''}
              onChange={e => updateField('verificationToken', e.target.value)}
              placeholder="Event verification token from Feishu"
              className="w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors font-mono"
            />
          </div>

          {/* Encrypt Key */}
          <div>
            <label className="block text-xs font-medium text-fg-secondary mb-1.5">
              {t('settings:feishu.encryptKey', { defaultValue: 'Encrypt Key' })}
              <span className="text-fg-tertiary ml-1">({t('settings:feishu.optional', { defaultValue: 'optional' })})</span>
            </label>
            <div className="relative">
              <input
                type={showEncryptKey ? 'text' : 'password'}
                value={config.encryptKey ?? ''}
                onChange={e => updateField('encryptKey', e.target.value)}
                placeholder="AES encryption key for event decryption"
                className="w-full px-3 py-2 pr-10 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors font-mono"
              />
              <button
                type="button"
                onClick={() => setShowEncryptKey(!showEncryptKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-fg-tertiary hover:text-fg-secondary transition-colors"
              >
                {showEncryptKey ? (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" /></svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                )}
              </button>
            </div>
          </div>

          {/* Webhook Path */}
          <div>
            <label className="block text-xs font-medium text-fg-secondary mb-1.5">
              {t('settings:feishu.webhookPath', { defaultValue: 'Webhook Path' })}
            </label>
            <input
              type="text"
              value={config.webhookPath ?? '/webhook/feishu'}
              onChange={e => updateField('webhookPath', e.target.value)}
              placeholder="/webhook/feishu"
              className="w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors font-mono"
            />
            <p className="text-[11px] text-fg-tertiary mt-1">
              {t('settings:feishu.webhookPathHint', { defaultValue: 'Set this path in your Feishu app event subscription' })}
            </p>
          </div>
        </div>
      </Section>

      {/* Test & Save Actions */}
      <Section title={t('settings:feishu.actions', { defaultValue: 'Actions' })}>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleTest}
            disabled={testing || !config.appId || !config.appSecret}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-surface-primary border border-border-default rounded-lg text-fg-primary hover:bg-surface-overlay disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {testing ? (
              <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            )}
            {t('settings:feishu.testConnection', { defaultValue: 'Test Connection' })}
          </button>

          <button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" /></svg>
            )}
            {t('common:save', { defaultValue: 'Save' })}
          </button>

          {config.connected && config.enabled && (
            <button
              onClick={handleDisconnect}
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-500 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29" /></svg>
              {t('settings:feishu.disconnect', { defaultValue: 'Disconnect' })}
            </button>
          )}
        </div>

        {msg && <Msg type={msg.type} text={msg.text} />}
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
                {t('settings:feishu.enableHint', { defaultValue: 'When enabled, Markus will connect to Feishu and start processing events' })}
              </div>
            </div>
            <button
              onClick={() => {
                updateField('enabled', !config.enabled);
                if (!config.enabled && config.appId && config.appSecret) {
                  // Auto-save when enabling with credentials
                  setDirty(true);
                }
              }}
              disabled={!config.appId || !config.appSecret}
              className={`relative w-12 h-6 rounded-full transition-colors duration-200 ${
                config.enabled ? 'bg-brand-600' : 'bg-gray-300 dark:bg-gray-600'
              } ${(!config.appId || !config.appSecret) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <span className={`block w-5 h-5 bg-white rounded-full shadow transform transition-transform duration-200 ${
                config.enabled ? 'translate-x-6' : 'translate-x-0.5'
              }`} />
            </button>
          </div>
        </div>
      </Section>

      {/* Notification Forwarding Settings */}
      <Section title={t('settings:feishu.notificationForwarding', { defaultValue: 'Notification Forwarding' })}>
        <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-5">
          {/* Toggle switches */}
          <div className="space-y-3">
            {/* Approval notifications */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-fg-primary">{t('settings:feishu.forwardApprovals', { defaultValue: 'Forward Approval Requests' })}</div>
                <div className="text-xs text-fg-tertiary mt-0.5">{t('settings:feishu.forwardApprovalsHint', { defaultValue: 'Send approval requests to Feishu as interactive cards' })}</div>
              </div>
              <button
                onClick={() => updateField('notifyOnApproval', !config.notifyOnApproval)}
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
                onClick={() => updateField('notifyOnNotification', !config.notifyOnNotification)}
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

      {/* Setup Guide */}
      <Section title={t('settings:feishu.setupGuide', { defaultValue: 'Setup Guide' })}>
        <div className="bg-surface-secondary border border-border-default rounded-xl p-5 space-y-3">
          <p className="text-xs text-fg-tertiary">
            {t('settings:feishu.setupGuideDesc', { defaultValue: 'Follow these steps to set up the Feishu integration:' })}
          </p>
          <ol className="text-xs text-fg-secondary space-y-2 list-decimal list-inside">
            <li>{t('settings:feishu.guideStep1', { defaultValue: 'Go to Feishu Open Platform (open.feishu.cn) and create a new app' })}</li>
            <li>{t('settings:feishu.guideStep2', { defaultValue: 'Enable bot capabilities and configure event subscriptions' })}</li>
            <li>{t('settings:feishu.guideStep3', { defaultValue: 'Copy the App ID and App Secret into the fields above' })}</li>
            <li>{t('settings:feishu.guideStep4', { defaultValue: 'Set the webhook URL in your Feishu app event subscription' })}</li>
            <li>{t('settings:feishu.guideStep5', { defaultValue: 'Click "Test Connection" to verify the setup' })}</li>
          </ol>
        </div>
      </Section>
    </div>
  );
}
