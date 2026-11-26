/**
 * C10-F — Settings → Connections → External signals.
 *
 * ## Why the switch and the URL list are one screen
 *
 * An inbound URL that nobody can see is an unmanaged door; a kill switch with no
 * list of doors is a switch that manages nothing. Both halves answer the same
 * question ("what can reach my agents from outside?"), so splitting them across
 * two tabs would guarantee someone sees only one of them.
 *
 * ## Why the policy comes from the same response as the sources
 *
 * `GET /api/external-sources` returns `{ policy, sources }` together. Two
 * requests could interleave — the list rendered after a toggle that already
 * changed the policy — and the screen would then show "running" sources under a
 * switch that has already shut them. One response, one consistent frame.
 *
 * ## Why the URL is allowed to look wrong
 *
 * `externalIngressUrl()` returns `external: false` when no tunnel is configured.
 * We then print the path **and say it is local-only**, because a copyable
 * `localhost` URL is indistinguishable from a working one until the first
 * delivery silently fails.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api.ts';
import { Badge, BTN_PRIMARY, BTN_SECONDARY, FIELD_INPUT, Section, SettingRow } from '../lib/settings-primitives.tsx';
import { Switch } from './Switch.tsx';
import {
  EXTERNAL_INGRESS_POLICIES,
  externalIngressUrl,
  isExternalIngressPolicy,
  sourceDeliveryState,
  type ExternalIngressPolicy,
  type ExternalSourceView,
} from '../lib/externalSources.ts';

interface AgentOption { id: string; name: string }

export function ExternalSourcesSection() {
  const { t } = useTranslation('settings');
  const [orgId, setOrgId] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState('');
  const [policy, setPolicy] = useState<ExternalIngressPolicy>('off');
  const [sources, setSources] = useState<ExternalSourceView[]>([]);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [busyPolicy, setBusyPolicy] = useState<ExternalIngressPolicy | null>(null);
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A rotated secret is shown exactly once, then gone from state on the next action. */
  const [mintedSecret, setMintedSecret] = useState<{ sourceId: string; value: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [{ org }, list] = await Promise.all([api.settings.getOrg(), api.agents.list({ lean: true })]);
        if (cancelled) return;
        setOrgId(org.id);
        setAgents(list.agents.map((a) => ({ id: a.id, name: a.name })));
        setAgentId((prev) => prev || (list.agents[0]?.id ?? ''));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
      // The tunnel address is optional: without it every URL is local-only, which
      // the UI states explicitly rather than hiding.
      try {
        const remote = await api.settings.getRemoteV2();
        if (!cancelled) setPublicUrl(remote?.publicUrl ?? null);
      } catch {
        if (!cancelled) setPublicUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadSources = useCallback(async (nextAgentId: string) => {
    if (!nextAgentId) return;
    try {
      const out = await api.externalSignals.list(nextAgentId);
      setPolicy(isExternalIngressPolicy(out.policy) ? out.policy : 'off');
      setSources(out.sources);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void loadSources(agentId); }, [agentId, loadSources]);

  const changePolicy = useCallback(async (next: ExternalIngressPolicy) => {
    if (!orgId || next === policy) return;
    setBusyPolicy(next);
    setError(null);
    try {
      await api.externalSignals.setIngress(orgId, next);
      setPolicy(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPolicy(null);
    }
  }, [orgId, policy]);

  const toggleSource = useCallback(async (source: ExternalSourceView, enabled: boolean) => {
    setBusySourceId(source.id);
    setError(null);
    try {
      const out = await api.externalSignals.setEnabled(agentId, source.id, enabled);
      if (out.status !== 'toggled') {
        setError(out.hint ?? out.status);
      } else {
        setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, enabled } : s)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySourceId(null);
    }
  }, [agentId]);

  const rotateSecret = useCallback(async (source: ExternalSourceView) => {
    setBusySourceId(source.id);
    setError(null);
    try {
      const out = await api.externalSignals.rotateSecret(agentId, source.id);
      if (out.status === 'rotated' && out.secret) {
        setMintedSecret({ sourceId: source.id, value: out.secret });
        setSources((prev) => prev.map((s) => (s.id === source.id ? { ...s, hasSecret: true } : s)));
      } else {
        setError(out.hint ?? out.status);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySourceId(null);
    }
  }, [agentId]);

  const copy = useCallback(async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((prev) => (prev === key ? null : prev)), 1500);
    } catch {
      setError(t('externalSignals.copyFailed'));
    }
  }, [t]);

  const noTunnel = useMemo(() => publicUrl === null, [publicUrl]);

  return (
    <div className="space-y-5">
      <Section title={t('externalSignals.title')} description={t('externalSignals.intro')}>
        <div className="space-y-1">
          {EXTERNAL_INGRESS_POLICIES.map((option) => {
            const active = policy === option;
            return (
              <button
                key={option}
                type="button"
                onClick={() => void changePolicy(option)}
                disabled={busyPolicy !== null || !orgId}
                data-testid={`external-ingress-${option}`}
                aria-pressed={active}
                className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${
                  active
                    ? 'border-brand-500 bg-brand-600/10'
                    : 'border-border-default hover:bg-surface-overlay'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-fg-primary">{t(`externalSignals.policy.${option}.label`)}</span>
                  {active && <Badge tone="ok">{t('externalSignals.policy.current')}</Badge>}
                  {busyPolicy === option && <span className="text-[12px] text-fg-tertiary">{t('externalSignals.saving')}</span>}
                </div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-fg-tertiary">
                  {t(`externalSignals.policy.${option}.detail`)}
                </div>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-fg-tertiary">{t('externalSignals.agentCaveat')}</p>
      </Section>

      <Section title={t('externalSignals.sourcesTitle')} description={t('externalSignals.sourcesIntro')}>
        <SettingRow label={t('externalSignals.agentFilter')} hint={t('externalSignals.agentFilterHint')}>
          <select
            className={FIELD_INPUT}
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            data-testid="external-sources-agent"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </SettingRow>

        {noTunnel && (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[12px] leading-relaxed text-fg-secondary" data-testid="external-sources-no-tunnel">
            {t('externalSignals.noTunnel')}
          </p>
        )}

        {sources.length === 0 ? (
          <p className="mt-3 text-[12px] leading-relaxed text-fg-tertiary" data-testid="external-sources-empty">
            {t('externalSignals.empty')}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {sources.map((source) => {
              const state = sourceDeliveryState(source, policy);
              const link = source.urlPath ? externalIngressUrl(publicUrl, source.urlPath) : null;
              return (
                <li key={source.id} className="rounded-lg border border-border-default/60 px-3 py-3" data-testid={`external-source-${source.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={source.kind === 'webhook' ? 'brand' : 'neutral'}>{source.kind}</Badge>
                    <code className="font-mono text-[12px] text-fg-primary">{source.address}</code>
                    <Badge tone={state === 'delivering' ? 'ok' : state === 'paused' ? 'warn' : 'neutral'}>
                      {t(`externalSignals.state.${state}`)}
                    </Badge>
                    <div className="ml-auto flex items-center gap-2">
                      <Switch
                        checked={source.enabled}
                        onChange={(next) => void toggleSource(source, next)}
                        disabled={busySourceId === source.id}
                        testId={`external-source-toggle-${source.id}`}
                        label={t('externalSignals.toggleSource')}
                      />
                    </div>
                  </div>

                  {link && (
                    <div className="mt-2 flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded bg-surface-primary px-2 py-1 font-mono text-[12px] text-fg-secondary">
                        {link.url}
                      </code>
                      <button type="button" className={BTN_SECONDARY} onClick={() => void copy(`url-${source.id}`, link.url)}>
                        {copied === `url-${source.id}` ? t('externalSignals.copied') : t('externalSignals.copy')}
                      </button>
                    </div>
                  )}
                  {source.feedUrl && (
                    <div className="mt-2 flex items-center gap-2">
                      <code className="min-w-0 flex-1 truncate rounded bg-surface-primary px-2 py-1 font-mono text-[12px] text-fg-secondary">
                        {source.feedUrl}
                      </code>
                      <button type="button" className={BTN_SECONDARY} onClick={() => void copy(`feed-${source.id}`, source.feedUrl ?? '')}>
                        {copied === `feed-${source.id}` ? t('externalSignals.copied') : t('externalSignals.copy')}
                      </button>
                    </div>
                  )}

                  {source.kind === 'webhook' && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[12px] text-fg-tertiary">
                        {source.hasSecret
                          ? t('externalSignals.secretSet', { preview: source.secretPreview ?? '••••' })
                          : t('externalSignals.secretMissing')}
                      </span>
                      <button
                        type="button"
                        className={BTN_SECONDARY}
                        disabled={busySourceId === source.id}
                        onClick={() => void rotateSecret(source)}
                        data-testid={`external-source-rotate-${source.id}`}
                      >
                        {t('externalSignals.rotate')}
                      </button>
                    </div>
                  )}

                  {mintedSecret?.sourceId === source.id && (
                    <div className="mt-2 rounded-lg border border-brand-500/40 bg-brand-600/[0.08] px-3 py-2">
                      <p className="text-[12px] text-fg-secondary">{t('externalSignals.secretOnce')}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-primary" data-testid="external-source-minted-secret">
                          {mintedSecret.value}
                        </code>
                        <button type="button" className={BTN_PRIMARY} onClick={() => void copy(`secret-${source.id}`, mintedSecret.value)}>
                          {copied === `secret-${source.id}` ? t('externalSignals.copied') : t('externalSignals.copy')}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="mt-2 text-[12px] text-fg-tertiary">
                    {source.lastEventAt
                      ? t('externalSignals.lastEvent', { at: new Date(source.lastEventAt).toLocaleString() })
                      : t('externalSignals.noEventYet')}
                    {source.lastError && <span className="ml-2 text-amber-500">{source.lastError}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {error && (
          <p className="mt-3 text-[12px] text-red-500" data-testid="external-sources-error">{error}</p>
        )}
      </Section>
    </div>
  );
}
