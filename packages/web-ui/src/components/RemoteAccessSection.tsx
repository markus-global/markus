/**
 * Remote Access — tunnel-based onboarding wizard (T9).
 *
 * Replaces the old WebRTC-relay section. The user brings their own tunnel
 * (Cloudflare quick/named, Tailscale Funnel/Serve, or a custom proxy); Markus
 * Hub only acts as entry domain + endpoint registry + login gate.
 *
 * Shape of the UX (see the brief):
 *   • connection-method chooser with 门槛/稳定性/账号/域名 badges + binary ✓
 *   • two setup paths — (A) run it yourself, (B) hand installation to an Agent
 *   • six-step progress wizard: install → start → resolve → register → verify → ready
 *   • ready panel — shareable entry + copy + QR, the real tunnel address, liveness
 *     (● online · latency) and [restart] [rotate] [close]
 *   • abnormal states — reconnecting (never silent), verify failure (retry / manual
 *     re-entry), blocked (suggest switching method)
 *   • honest tips — the address bar jumps to the tunnel domain, free-tier limits,
 *     quick-tunnel hostnames change, mainland-China caveat, security hardening
 *
 * All state-machine logic lives in `lib/remoteAccess.ts` (pure + unit-tested); this
 * file is the presentation layer only.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api, ensureHubAuth, getHubUser, hubApi, wsClient } from '../api.ts';
import { navBus } from '../navBus.ts';
import { PAGE } from '../routes.ts';
import {
  CONNECTION_METHODS,
  SETUP_STEPS,
  adaptRemoteStatus,
  afterSelfRun,
  connectionMethod,
  detectPlatform,
  entryUrlFor,
  initialWizardState,
  setupCommands,
  stepIndex,
  wizardReducer,
  type Barrier,
  type Platform,
  type RemoteEndpointKind,
  type RemoteSetupTargets,
  type SetupPath,
  type SetupStep,
  type Stability,
  type VerifyFailureReason,
  type WizardPhase,
} from '../lib/remoteAccess.ts';

const PLATFORMS: Platform[] = ['macos', 'linux', 'windows'];

export function RemoteAccessSection() {
  const { t } = useTranslation(['settings', 'common']);
  const [wizard, dispatch] = useReducer(wizardReducer, initialWizardState);
  const [detected, setDetected] = useState<{ cloudflared: boolean; tailscale: boolean } | null>(null);
  const [platform, setPlatform] = useState<Platform>('linux');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState('');
  const [showManual, setShowManual] = useState(false);
  /** Path B — candidate recipient Agents + the user's pick. */
  const [targets, setTargets] = useState<RemoteSetupTargets | null>(null);
  const [agentChoice, setAgentChoice] = useState<string>('');
  const mounted = useRef(true);

  const isAuthed = hubApi.isAuthenticated();
  const hubUser = getHubUser();
  const { kind, phase } = wizard;
  const meta = kind ? connectionMethod(kind) : null;

  useEffect(() => {
    setPlatform(detectPlatform(typeof navigator === 'undefined' ? '' : navigator.userAgent));
  }, []);

  useEffect(() => {
    mounted.current = true;
    // Initial status + binary detection. Both degrade gracefully: if the local
    // route is not wired yet (T8) the wizard simply starts from the chooser.
    api.settings
      .getRemoteV2()
      .then((s) => {
        if (mounted.current && s) dispatch({ type: 'status', status: s });
      })
      .catch(() => {});
    api.settings
      .remoteDetect()
      .then((d) => {
        if (mounted.current) setDetected(d);
      })
      .catch(() => {
        if (mounted.current) setDetected(null);
      });
    // Path B — who can run the setup. Degrades to "no picker" when the local
    // route is not wired (older runtime), the dispatch button then reports it.
    api.settings
      .remoteSetupTargets()
      .then((tgt) => {
        if (!mounted.current) return;
        setTargets(tgt);
        setAgentChoice((prev) => prev || tgt.recommendedId || tgt.agents[0]?.id || '');
      })
      .catch(() => {
        if (mounted.current) setTargets(null);
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(
    () =>
      wsClient.on('remote:status', (event) => {
        const s = adaptRemoteStatus(event.payload);
        if (s) dispatch({ type: 'status', status: s });
      }),
    [],
  );

  const copy = useCallback((text: string, key: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.settings.getRemoteV2();
      if (s) dispatch({ type: 'status', status: s });
      return s;
    } catch {
      return null;
    }
  }, []);

  const handleLogin = useCallback(async () => {
    try {
      await ensureHubAuth();
    } catch {
      /* user cancelled */
    }
  }, []);

  const selectKind = (k: RemoteEndpointKind) => {
    setActionError(null);
    setShowManual(false);
    dispatch({ type: 'selectKind', kind: k });
  };

  /** Path A — the user ran the commands themselves and reports it. */
  const handleIHaveRun = async () => {
    setActionError(null);
    dispatch({ type: 'choosePath', path: 'self' });
    dispatch({ type: 'beginInstall' });
    dispatch({ type: 'installSucceeded' });
    const s = await refreshStatus();
    // Never a silent stall: if the local supervisor already knows an address we
    // go straight to register; otherwise we land on the `resolve` step and ask
    // for the address the tunnel printed. (A tunnel the USER started is invisible
    // to us — only their terminal ever saw the quick-tunnel hostname, so asking
    // is the only correct handoff. This replaces a branch that did NOTHING.)
    dispatch(afterSelfRun(s));
  };

  /** Manual address re-entry — the recovery path when auto-verification fails. */
  const handleManualSubmit = async () => {
    const url = manualUrl.trim();
    if (!url) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.settings.remoteTunnelRegister({ kind: kind ?? 'custom', publicUrl: url });
      dispatch({ type: 'addressResolved', publicUrl: url });
      await refreshStatus();
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      setActionError(message);
      dispatch({ type: 'userError', message });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Path B — hand the setup to an Agent, WITHOUT running it behind the user's back.
   *
   * The plan is built on the SERVER (single source for exactly what will run) and
   * comes back with the response. We then open a chat with the chosen Agent and
   * prefill its composer with the plan's prompt — the user watches the whole run
   * and decides whether to send. Nothing is dispatched from this panel.
   */
  /** Path B step 1 — reveal the Agent picker. Nothing is built yet. */
  const selectAgentPath = () => {
    setActionError(null);
    dispatch({ type: 'choosePath', path: 'agent' });
  };

  /** Path B step 2 — open the Agent's chat with the plan prefilled in the composer. */
  const handOffToAgentChat = async () => {
    setActionError(null);
    if (!kind) {
      setActionError(t('settings:remoteAccess.path.agent.pickFirst'));
      return;
    }
    setBusy(true);
    try {
      const r = await api.settings.remoteAgentSetup({
        kind,
        platform,
        ...(agentChoice ? { agentId: agentChoice } : {}),
        ...(hubUser?.username ? { username: hubUser.username } : {}),
      });
      if (r.ok && r.agentId && r.prompt) {
        dispatch({ type: 'handedToChat', contract: r.contract ?? null });
        navBus.navigate(PAGE.TEAM, { agentId: r.agentId, prefillMessage: r.prompt });
      } else {
        setActionError(r.error ?? t('settings:remoteAccess.path.agent.unavailable'));
      }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      setActionError(message || t('settings:remoteAccess.path.agent.unavailable'));
    } finally {
      setBusy(false);
    }
  };

  const runTunnelAction = async (action: 'restart' | 'rotate' | 'stop') => {
    setBusy(true);
    setActionError(null);
    try {
      if (action === 'restart') await api.settings.remoteTunnelRestart();
      else if (action === 'rotate') await api.settings.remoteTunnelRotate();
      else {
        await api.settings.remoteTunnelStop().catch(() => {});
        await api.settings.disableRemote().catch(() => {});
      }
      if (action === 'stop') {
        dispatch({ type: 'reset' });
      } else {
        await refreshStatus();
      }
    } catch (err) {
      setActionError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };

  const handleClose = () => {
    void runTunnelAction('stop');
  };

  const entryUrl = wizard.entryUrl ?? entryUrlFor(hubUser?.username ?? null);
  const isReady = phase === 'ready' || phase === 'reconnecting';
  const selfCommands = kind ? setupCommands(kind, platform) : null;

  return (
    <Section title={t('settings:remoteAccess.title')}>
      <div className="space-y-5">
        <p className="text-sm text-fg-secondary">{t('settings:remoteAccess.description')}</p>

        {!isAuthed ? (
          <div className="flex items-center gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <WarningIcon />
            <span className="text-sm text-amber-600 dark:text-amber-400">
              {t('settings:remoteAccess.loginRequired')}
            </span>
            <button
              onClick={() => void handleLogin()}
              className="ml-auto px-3 py-1.5 text-xs font-medium bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors"
            >
              {t('settings:remoteAccess.signIn')}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-fg-secondary">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            {t('settings:remoteAccess.signedInAs')}{' '}
            <strong>{hubUser?.username ?? hubUser?.displayName}</strong>
          </div>
        )}

        {isAuthed && (
          <>
            {isReady && meta ? (
              <ReadyPanel
                t={t}
                phase={phase}
                meta={meta}
                entryUrl={entryUrl}
                publicUrl={wizard.publicUrl}
                health={wizard.health}
                latencyMs={wizard.latencyMs}
                message={wizard.message}
                busy={busy}
                copied={copied}
                onCopy={copy}
                onRestart={() => void runTunnelAction('restart')}
                onRotate={() => void runTunnelAction('rotate')}
                onClose={handleClose}
              />
            ) : (
              <>
                <MethodChooser t={t} detected={detected} selected={kind} onSelect={selectKind} />

                {kind && meta && (
                  <div className="space-y-4">
                    <WizardProgress t={t} phase={phase} />

                    {phase === 'error' && (
                      <ErrorNotice
                        t={t}
                        message={wizard.message}
                        verifyFailure={wizard.verifyFailure}
                        showManual={showManual}
                        manualUrl={manualUrl}
                        busy={busy}
                        onToggleManual={() => setShowManual((v) => !v)}
                        onManualChange={setManualUrl}
                        onManualSubmit={() => void handleManualSubmit()}
                        onRetry={() => {
                          setActionError(null);
                          dispatch({ type: 'verifyStarted' });
                          void refreshStatus();
                        }}
                        onStartOver={() => {
                          setActionError(null);
                          setShowManual(false);
                          dispatch({ type: 'reset' });
                        }}
                      />
                    )}

                    {phase === 'reconnecting' && (
                      <div className="flex items-center gap-3 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 text-sm text-blue-600 dark:text-blue-400">
                        <Spinner />
                        <span>{t('settings:remoteAccess.wizard.reconnecting')}</span>
                      </div>
                    )}

                    <PathPicker
                      t={t}
                      setupPath={wizard.path}
                      busy={busy}
                      onSelf={() => dispatch({ type: 'choosePath', path: 'self' })}
                      onAgent={() => selectAgentPath()}
                    />

                    {wizard.path === 'self' && selfCommands && (
                      <CommandsPanel
                        t={t}
                        platform={platform}
                        onPlatform={setPlatform}
                        commands={selfCommands}
                        meta={meta}
                        detected={detected}
                        copied={copied}
                        onCopy={copy}
                        onDone={() => void handleIHaveRun()}
                        busy={busy}
                      />
                    )}

                    {wizard.path === 'self' && phase === 'resolve' && (
                      <AddressPrompt
                        t={t}
                        value={manualUrl}
                        busy={busy}
                        onChange={setManualUrl}
                        onSubmit={() => void handleManualSubmit()}
                      />
                    )}

                    {wizard.path === 'agent' && (
                      <div className="space-y-3">
                        {targets && targets.agents.length > 0 ? (
                          <label className="block text-sm">
                            <span className="text-fg-secondary">
                              {t('settings:remoteAccess.path.agent.pickAgent')}
                            </span>
                            <select
                              className="mt-1 w-full rounded-lg border border-border-default bg-surface-primary px-3 py-2 text-sm"
                              value={agentChoice}
                              onChange={(e) => {
                                setAgentChoice(e.target.value);
                                dispatch({ type: 'selectAgent', agentId: e.target.value });
                              }}
                            >
                              {targets.agents.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                  {a.id === targets.recommendedId
                                    ? ` — ${t('settings:remoteAccess.path.agent.recommended')}`
                                    : ''}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : (
                          <div className="p-3 rounded-xl bg-surface-secondary border border-border-default text-sm text-fg-secondary">
                            {t('settings:remoteAccess.path.agent.noTargets')}
                          </div>
                        )}

                        <div className="p-3 rounded-xl bg-surface-secondary border border-border-default text-sm text-fg-secondary">
                          {wizard.handedToChat
                            ? t('settings:remoteAccess.path.agent.handed')
                            : t('settings:remoteAccess.path.agent.desc')}
                        </div>

                        {wizard.agentContract && (
                          <div className="p-3 rounded-xl bg-surface-secondary border border-border-default text-xs space-y-2">
                            <div className="font-semibold text-fg-secondary">
                              {t('settings:remoteAccess.path.agent.willRun')}
                            </div>
                            <ul className="space-y-1">
                              {wizard.agentContract.commands.map((cmd) => (
                                <li key={cmd.id} className="flex items-start gap-2">
                                  <span className="shrink-0">
                                    {cmd.sensitive ? t('settings:remoteAccess.path.agent.sensitive') : '›'}
                                  </span>
                                  <code className="break-all text-fg-primary">{cmd.run}</code>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {kind && (
                          <button
                            type="button"
                            className="w-full rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500 disabled:opacity-50"
                            disabled={busy || !targets || targets.agents.length === 0}
                            onClick={() => void handOffToAgentChat()}
                          >
                            {t('settings:remoteAccess.path.agent.handOff')}
                          </button>
                        )}
                      </div>
                    )}

                    {actionError && (
                      <div className="p-2 rounded-lg bg-red-500/10 text-red-500 text-sm">{actionError}</div>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}

        <HonestTips t={t} />
      </div>
    </Section>
  );
}

/* ── Small shared bits ─────────────────────────────────────────────────────── */

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-fg-secondary uppercase tracking-wider mb-4">{title}</h3>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

function WarningIcon() {
  return (
    <svg className="w-5 h-5 text-amber-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin text-fg-secondary" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function QRCode({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setError(false);

    import('qrcode')
      .then((QRLib) => {
        void QRLib.toCanvas(canvas, url, {
          width: 200,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
          errorCorrectionLevel: 'M',
        });
      })
      .catch(() => setError(true));
  }, [url]);

  if (error) {
    return (
      <a href={url} target="_blank" rel="noopener" className="text-sm text-brand-500 underline">
        {url}
      </a>
    );
  }

  return (
    <div className="inline-block p-2 bg-white rounded-lg">
      <canvas ref={canvasRef} className="block" style={{ width: 160, height: 160 }} />
    </div>
  );
}

/* ── Localized-label maps ──────────────────────────────────────────────────────
 * Keys are written out in full (never string-concatenated) so the i18n coverage
 * probe in `test/remoteAccessWizard.test.ts` can prove they all exist — a
 * dynamically built key would slip past it.
 */
type TFn = ReturnType<typeof useTranslation>['t'];

const STEP_LABEL: Record<SetupStep, string> = {
  install: 'settings:remoteAccess.stepInstall',
  start: 'settings:remoteAccess.stepStart',
  resolve: 'settings:remoteAccess.stepResolve',
  register: 'settings:remoteAccess.stepRegister',
  verify: 'settings:remoteAccess.stepVerify',
  ready: 'settings:remoteAccess.stepReady',
};

const METHOD_LABEL: Record<RemoteEndpointKind, { name: string; desc: string }> = {
  cloudflare_quick: {
    name: 'settings:remoteAccess.methodCloudflareQuick',
    desc: 'settings:remoteAccess.methodCloudflareQuickDesc',
  },
  cloudflare_named: {
    name: 'settings:remoteAccess.methodCloudflareNamed',
    desc: 'settings:remoteAccess.methodCloudflareNamedDesc',
  },
  tailscale_funnel: {
    name: 'settings:remoteAccess.methodTailscaleFunnel',
    desc: 'settings:remoteAccess.methodTailscaleFunnelDesc',
  },
  tailscale_serve: {
    name: 'settings:remoteAccess.methodTailscaleServe',
    desc: 'settings:remoteAccess.methodTailscaleServeDesc',
  },
  custom: {
    name: 'settings:remoteAccess.methodCustom',
    desc: 'settings:remoteAccess.methodCustomDesc',
  },
};

const BARRIER_LABEL: Record<Barrier, string> = {
  low: 'settings:remoteAccess.barrierLow',
  medium: 'settings:remoteAccess.barrierMedium',
  high: 'settings:remoteAccess.barrierHigh',
};

const STABILITY_LABEL: Record<Stability, string> = {
  high: 'settings:remoteAccess.stabilityHigh',
  medium: 'settings:remoteAccess.stabilityMedium',
  low: 'settings:remoteAccess.stabilityLow',
};

const PLATFORM_LABEL: Record<Platform, string> = {
  macos: 'settings:remoteAccess.platformMacos',
  linux: 'settings:remoteAccess.platformLinux',
  windows: 'settings:remoteAccess.platformWindows',
};

const VERIFY_REASON_LABEL: Record<VerifyFailureReason, string> = {
  unreachable: 'settings:remoteAccess.verifyReasonUnreachable',
  non_https: 'settings:remoteAccess.verifyReasonNonHttps',
  blocked_target: 'settings:remoteAccess.verifyReasonBlockedTarget',
  too_many_redirects: 'settings:remoteAccess.verifyReasonTooManyRedirects',
  response_too_large: 'settings:remoteAccess.verifyReasonResponseTooLarge',
  token_mismatch: 'settings:remoteAccess.verifyReasonTokenMismatch',
  malformed_response: 'settings:remoteAccess.verifyReasonMalformedResponse',
};

/* ── 1. Connection-method chooser ───────────────────────────────────────────── */

function MethodChooser({
  t,
  detected,
  selected,
  onSelect,
}: {
  t: TFn;
  detected: { cloudflared: boolean; tailscale: boolean } | null;
  selected: RemoteEndpointKind | null;
  onSelect: (kind: RemoteEndpointKind) => void;
}) {
  return (
    <div>
      <div className="text-xs text-fg-tertiary uppercase tracking-wider mb-2">
        {t('settings:remoteAccess.methodTitle')}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {CONNECTION_METHODS.map((m) => {
          const active = selected === m.kind;
          const ok = detected && m.binary ? detected[m.binary] : null;
          return (
            <button
              key={m.kind}
              type="button"
              onClick={() => onSelect(m.kind)}
              className={`text-left p-3 rounded-xl border transition-colors ${
                active
                  ? 'border-brand-500 bg-brand-500/5'
                  : 'border-border-default bg-surface-secondary hover:border-brand-400/60'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-fg-primary">
                  {t(METHOD_LABEL[m.kind].name)}
                </span>
                {m.recommended && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-brand-500/15 text-brand-500">
                    ★ {t('settings:remoteAccess.badgeRecommended')}
                  </span>
                )}
              </div>
              <p className="text-xs text-fg-tertiary mt-1 leading-snug">
                {t(METHOD_LABEL[m.kind].desc)}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                <Chip>{t(BARRIER_LABEL[m.barrier])}</Chip>
                <Chip>{t(STABILITY_LABEL[m.stability])}</Chip>
                <Chip>
                  {m.needsAccount
                    ? t('settings:remoteAccess.badgeNeedsAccount')
                    : t('settings:remoteAccess.badgeNoAccount')}
                </Chip>
                <Chip>
                  {m.needsDomain
                    ? t('settings:remoteAccess.badgeNeedsDomain')
                    : t('settings:remoteAccess.badgeNoDomain')}
                </Chip>
                {ok !== null && (
                  <Chip tone={ok ? 'good' : 'warn'}>
                    {ok ? '✓ ' : '✕ '}
                    {m.binary} {ok ? t('settings:remoteAccess.badgeDetected') : t('settings:remoteAccess.badgeNotDetected')}
                  </Chip>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Chip({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'good' | 'warn' }) {
  const toneClass =
    tone === 'good'
      ? 'bg-green-500/10 text-green-600 dark:text-green-400'
      : tone === 'warn'
        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
        : 'bg-surface-secondary text-fg-tertiary';
  return <span className={`px-1.5 py-0.5 text-[10px] rounded ${toneClass}`}>{children}</span>;
}

/* ── 2. Progress wizard (six steps) ─────────────────────────────────────────── */

function WizardProgress({ t, phase }: { t: TFn; phase: WizardPhase }) {
  const current = stepIndex(phase);
  const failed = phase === 'error';
  return (
    <div className="flex items-center gap-1">
      {SETUP_STEPS.map((step, i) => {
        const done = current >= 0 && i < current;
        const active = current >= 0 && i === current;
        const isError = failed && i === Math.max(0, current);
        return (
          <div key={step} className="flex items-center gap-1 flex-1 min-w-0">
            <div className="flex flex-col items-center gap-1 min-w-0">
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-medium shrink-0 ${
                  isError
                    ? 'bg-red-500 text-white'
                    : done
                      ? 'bg-green-500 text-white'
                      : active
                        ? 'bg-brand-600 text-white'
                        : 'bg-surface-secondary text-fg-tertiary'
                }`}
              >
                {done ? '✓' : isError ? '!' : i + 1}
              </span>
              <span
                className={`text-[10px] leading-tight text-center truncate ${
                  active || isError ? 'text-fg-primary' : 'text-fg-tertiary'
                }`}
              >
                {t(STEP_LABEL[step])}
              </span>
            </div>
            {i < SETUP_STEPS.length - 1 && (
              <span className={`h-px flex-1 ${done ? 'bg-green-500/50' : 'bg-border-default'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ── 3. Two setup paths ─────────────────────────────────────────────────────── */

function PathPicker({
  t,
  setupPath,
  busy,
  onSelf,
  onAgent,
}: {
  t: TFn;
  setupPath: SetupPath | null;
  busy: boolean;
  onSelf: () => void;
  onAgent: () => void;
}) {
  return (
    <div>
      <div className="text-xs text-fg-tertiary uppercase tracking-wider mb-2">
        {t('settings:remoteAccess.pathTitle')}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={onSelf}
          className={`text-left p-3 rounded-xl border transition-colors ${
            setupPath === 'self' ? 'border-brand-500 bg-brand-500/5' : 'border-border-default bg-surface-secondary hover:border-brand-400/60'
          }`}
        >
          <div className="text-sm font-medium text-fg-primary">
            {t('settings:remoteAccess.pathSelfTitle')}
          </div>
          <p className="text-xs text-fg-tertiary mt-1">{t('settings:remoteAccess.pathSelfDesc')}</p>
        </button>
        <button
          type="button"
          onClick={onAgent}
          disabled={busy}
          className={`text-left p-3 rounded-xl border transition-colors disabled:opacity-60 ${
            setupPath === 'agent' ? 'border-brand-500 bg-brand-500/5' : 'border-border-default bg-surface-secondary hover:border-brand-400/60'
          }`}
        >
          <div className="text-sm font-medium text-fg-primary">
            {t('settings:remoteAccess.pathAgentTitle')}
          </div>
          <p className="text-xs text-fg-tertiary mt-1">{t('settings:remoteAccess.pathAgentDesc')}</p>
        </button>
      </div>
    </div>
  );
}

/* ── 4. Commands panel (path A) ─────────────────────────────────────────────── */

function CommandsPanel({
  t,
  platform,
  onPlatform,
  commands,
  meta,
  detected,
  copied,
  onCopy,
  onDone,
  busy,
}: {
  t: TFn;
  platform: Platform;
  onPlatform: (p: Platform) => void;
  commands: { install: string; run: string };
  meta: { binary: 'cloudflared' | 'tailscale' | null; kind: RemoteEndpointKind };
  detected: { cloudflared: boolean; tailscale: boolean } | null;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  onDone: () => void;
  busy: boolean;
}) {
  const missingBinary = !!(meta.binary && detected && !detected[meta.binary]);
  return (
    <div className="p-3 rounded-xl bg-surface-secondary border border-border-default space-y-3">
      <div className="flex items-center gap-2">
        {PLATFORMS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPlatform(p)}
            className={`px-2 py-1 text-xs rounded-md transition-colors ${
              platform === p ? 'bg-brand-600 text-white' : 'bg-surface-secondary text-fg-secondary hover:text-fg-primary'
            }`}
          >
            {t(PLATFORM_LABEL[p])}
          </button>
        ))}
      </div>

      {missingBinary && meta.binary && (
        <div className="text-xs text-amber-600 dark:text-amber-400">
          {t('settings:remoteAccess.commandsMissingBinary', { binary: meta.binary })}
        </div>
      )}

      {(['install', 'run'] as const).map((which) => (
        <div key={which}>
          <div className="text-xs text-fg-tertiary mb-1">
            {which === 'install' ? t('settings:remoteAccess.commandsInstall') : t('settings:remoteAccess.commandsRun')}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 text-xs bg-surface-secondary rounded font-mono whitespace-pre-wrap break-all">
              {commands[which]}
            </code>
            <button
              type="button"
              onClick={() => onCopy(commands[which], which)}
              className={`px-2 py-1.5 text-xs border rounded transition-colors shrink-0 ${
                copied === which ? 'border-green-500 text-green-600 dark:text-green-400' : 'border-border-default hover:bg-surface-elevated'
              }`}
            >
              {copied === which ? t('settings:remoteAccess.commandsCopied') : t('settings:remoteAccess.commandsCopy')}
            </button>
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={onDone}
        disabled={busy}
        className="w-full px-3 py-2 text-sm font-medium bg-brand-600 hover:bg-brand-500 text-white rounded-lg transition-colors disabled:opacity-60"
      >
        {t('settings:remoteAccess.commandsDone')}
      </button>
    </div>
  );
}

/* ── 4b. Address prompt — self-run path: "I've run it" → paste what it printed ─ */

function AddressPrompt({
  t,
  value,
  busy,
  onChange,
  onSubmit,
}: {
  t: TFn;
  value: string;
  busy: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="p-3 rounded-xl bg-surface-secondary border border-border-default space-y-2">
      <p className="text-xs text-fg-secondary">{t('settings:remoteAccess.addressPrompt')}</p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('settings:remoteAccess.errorManualPlaceholder')}
          className="flex-1 px-2 py-1.5 text-xs bg-surface-secondary border border-border-default rounded font-mono"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !value.trim()}
          className="px-3 py-1.5 text-xs font-medium bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-60"
        >
          {t('settings:remoteAccess.errorManualSubmit')}
        </button>
      </div>
    </div>
  );
}

/* ── 5. Error / recovery notice ─────────────────────────────────────────────── */

function ErrorNotice({
  t,
  message,
  verifyFailure,
  showManual,
  manualUrl,
  busy,
  onToggleManual,
  onManualChange,
  onManualSubmit,
  onRetry,
  onStartOver,
}: {
  t: TFn;
  message: string | null;
  verifyFailure: VerifyFailureReason | null;
  showManual: boolean;
  manualUrl: string;
  busy: boolean;
  onToggleManual: () => void;
  onManualChange: (v: string) => void;
  onManualSubmit: () => void;
  onRetry: () => void;
  onStartOver: () => void;
}) {
  return (
    <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 space-y-2">
      <div className="text-sm font-medium text-red-600 dark:text-red-400">
        {t('settings:remoteAccess.errorTitle')}
      </div>
      <p className="text-xs text-fg-secondary">
        {verifyFailure ? t(VERIFY_REASON_LABEL[verifyFailure]) : message ?? t('settings:remoteAccess.errorGeneric')}
      </p>
      {verifyFailure === 'unreachable' && (
        <p className="text-xs text-amber-600 dark:text-amber-400">{t('settings:remoteAccess.errorBlockedHint')}</p>
      )}

      {showManual && (
        <div className="flex items-center gap-2 pt-1">
          <input
            type="text"
            value={manualUrl}
            onChange={(e) => onManualChange(e.target.value)}
            placeholder={t('settings:remoteAccess.errorManualPlaceholder')}
            className="flex-1 px-2 py-1.5 text-xs bg-surface-secondary border border-border-default rounded font-mono"
          />
          <button
            type="button"
            onClick={onManualSubmit}
            disabled={busy || !manualUrl.trim()}
            className="px-3 py-1.5 text-xs font-medium bg-brand-600 hover:bg-brand-500 text-white rounded-lg disabled:opacity-60"
          >
            {t('settings:remoteAccess.errorManualSubmit')}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onRetry}
          className="px-3 py-1.5 text-xs font-medium bg-brand-600 hover:bg-brand-500 text-white rounded-lg"
        >
          {t('settings:remoteAccess.errorRetry')}
        </button>
        <button
          type="button"
          onClick={onToggleManual}
          className="px-3 py-1.5 text-xs border border-border-default rounded-lg hover:bg-surface-elevated"
        >
          {t('settings:remoteAccess.errorManualToggle')}
        </button>
        <button
          type="button"
          onClick={onStartOver}
          className="ml-auto px-3 py-1.5 text-xs text-fg-secondary hover:text-fg-primary"
        >
          {t('settings:remoteAccess.errorStartOver')}
        </button>
      </div>
    </div>
  );
}

/* ── 6. Ready panel ─────────────────────────────────────────────────────────── */

function ReadyPanel({
  t,
  phase,
  meta,
  entryUrl,
  publicUrl,
  health,
  latencyMs,
  message,
  busy,
  copied,
  onCopy,
  onRestart,
  onRotate,
  onClose,
}: {
  t: TFn;
  phase: WizardPhase;
  meta: { kind: RemoteEndpointKind };
  entryUrl: string | null;
  publicUrl: string | null;
  health: 'unknown' | 'up' | 'down';
  latencyMs: number | null;
  message: string | null;
  busy: boolean;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  onRestart: () => void;
  onRotate: () => void;
  onClose: () => void;
}) {
  const reconnecting = phase === 'reconnecting';
  const online = health === 'up' && !reconnecting;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${online ? 'bg-green-500 animate-pulse' : reconnecting ? 'bg-blue-500 animate-pulse' : 'bg-amber-500'}`} />
        <span className="text-sm font-medium text-fg-primary">
          {online
            ? t('settings:remoteAccess.readyOnline')
            : reconnecting
              ? t('settings:remoteAccess.wizard.reconnecting')
              : t('settings:remoteAccess.readyDegraded')}
        </span>
        {online && latencyMs != null && (
          <span className="text-xs text-fg-tertiary">{t('settings:remoteAccess.readyLatency', { ms: latencyMs })}</span>
        )}
        <span className="text-xs text-fg-tertiary">
          · {t(METHOD_LABEL[meta.kind].name)}
        </span>
      </div>

      {reconnecting && (
        <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400">
          <Spinner />
          {t('settings:remoteAccess.wizard.reconnectingHint')}
        </div>
      )}
      {!reconnecting && message && (
        <div className="text-xs text-amber-600 dark:text-amber-400">{message}</div>
      )}

      {/* Shareable entry */}
      {entryUrl && (
        <div className="p-3 rounded-xl bg-surface-elevated border border-border-default space-y-2">
          <div className="text-xs text-fg-tertiary uppercase tracking-wider">
            {t('settings:remoteAccess.readyEntry')}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-1.5 text-sm bg-surface-secondary rounded font-mono truncate">{entryUrl}</code>
            <button
              type="button"
              onClick={() => onCopy(entryUrl, 'entry')}
              className={`px-2 py-1.5 text-xs border rounded transition-colors shrink-0 ${
                copied === 'entry' ? 'border-green-500 text-green-600 dark:text-green-400' : 'border-border-default hover:bg-surface-elevated'
              }`}
            >
              {copied === 'entry' ? t('settings:remoteAccess.copied') : t('settings:remoteAccess.copy')}
            </button>
          </div>
          <p className="text-xs text-fg-secondary">{t('settings:remoteAccess.readyEntryHint')}</p>
          <div className="pt-1">
            <QRCode url={entryUrl} />
            <p className="text-xs text-fg-tertiary mt-1">{t('settings:remoteAccess.readyScanQr')}</p>
          </div>
          <p className="text-xs text-fg-tertiary">{t('settings:remoteAccess.readyAuthGateNote')}</p>
        </div>
      )}

      {/* Actual tunnel address (302 target) */}
      {publicUrl && (
        <div className="p-3 rounded-xl bg-surface-secondary border border-border-default space-y-1">
          <div className="text-xs text-fg-tertiary uppercase tracking-wider">
            {t('settings:remoteAccess.readyPublicUrl')}
          </div>
          <code className="block text-xs font-mono break-all text-fg-secondary">{publicUrl}</code>
          <p className="text-xs text-fg-tertiary">{t('settings:remoteAccess.readyAddressBarNote')}</p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onRestart}
          disabled={busy}
          className="px-3 py-1.5 text-xs border border-border-default rounded-lg hover:bg-surface-elevated disabled:opacity-60"
        >
          {t('settings:remoteAccess.readyRestart')}
        </button>
        <button
          type="button"
          onClick={onRotate}
          disabled={busy}
          className="px-3 py-1.5 text-xs border border-border-default rounded-lg hover:bg-surface-elevated disabled:opacity-60"
        >
          {t('settings:remoteAccess.readyRotate')}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="ml-auto px-3 py-1.5 text-xs text-red-600 dark:text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 disabled:opacity-60"
        >
          {t('settings:remoteAccess.readyClose')}
        </button>
      </div>
    </div>
  );
}

/* ── 7. Honest tips ─────────────────────────────────────────────────────────── */

function HonestTips({ t }: { t: TFn }) {
  const [open, setOpen] = useState(false);
  const items = [
    t('settings:remoteAccess.tipAddressBar'),
    t('settings:remoteAccess.tipRateLimit'),
    t('settings:remoteAccess.tipRandomDomain'),
    t('settings:remoteAccess.tipChina'),
    t('settings:remoteAccess.tipSecurity'),
    t('settings:remoteAccess.tipSecuritySteps'),
  ];
  return (
    <div className="rounded-xl border border-border-default bg-surface-secondary">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full px-3 py-2 text-sm text-fg-secondary hover:text-fg-primary"
      >
        <span>{t('settings:remoteAccess.tipsTitle')}</span>
        <span className={`transition-transform ${open ? '' : '-rotate-90'}`}>▾</span>
      </button>
      {open && (
        <ul className="px-4 pb-3 space-y-1.5 list-disc list-inside">
          {items.map((item, i) => (
            <li key={i} className="text-xs text-fg-tertiary leading-snug">{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

