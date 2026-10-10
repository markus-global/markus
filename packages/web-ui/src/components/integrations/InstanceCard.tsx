/**
 * One bot card — the only card the Integrations page renders.
 *
 * ── What changed and why ────────────────────────────────────────────────────
 *
 * A bot used to be configured by *two* cards stacked on each other: a
 * platform-level card with its own header, an "Enable integration" block and a
 * "Save & test" button, wrapped by an instance card that re-hosted a second
 * header, a routing panel and a second Save. The user saw both, and they
 * disagreed — two status badges, two switches, three save paths, each with its
 * own idea of whether the bot was configured.
 *
 * There is now one card and one lifecycle:
 *
 *   • configuration saves itself: every edit is debounced, written and probed,
 *     so "did that stick?" is never a question answered by hunting a button;
 *   • the on/off switch lives in the header beside the status, because "is it
 *     on" and "does it work" are the two things a header is for;
 *   • the header badge is derived from *configuration* and *verification*
 *     together (`connectionState`), not from "our process holds a socket";
 *   • everything a normal user never needs — transport knobs (ports, webhook
 *     URLs, signing keys) and the routing overrides — is folded behind one
 *     "More settings" disclosure;
 *   • the two-way verification result is remembered and re-runnable.
 *
 * ── Add-bot is this same card ───────────────────────────────────────────────
 * A new bot is a draft (no id yet) rendered by this component, so the first
 * thing the user sees is the setup steps — not a prompt demanding a name for
 * something that does not exist yet. The first complete save creates the row;
 * the name is simply the first field of the credentials.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api.ts';
import {
  bindingFor,
  connectionState,
  filterChannels,
  instanceAsPlatform,
  isDraft,
  isTestLive,
  orphanBindings,
  removeChannelBinding,
  setChannelBinding,
  type ConnectionTestSnapshot,
  type InstanceChannelBinding,
  type InstanceChannelsResponse,
  type InstanceStatus,
  type PlatformChannel,
} from '../../lib/instanceIntegrations.ts';
import {
  buildSavePayload,
  initialDraft,
  missingRequired,
  primaryFields,
  secondaryFields,
  statusFingerprint,
  testResultMessage,
  type PlatformExtras,
  type PlatformExtrasContext,
  type TestConnectionResponse,
} from '../../lib/platformIntegrations.ts';
import { fieldText } from '../../lib/platformI18n.ts';
import { AgentSelect, loadAgentOptions, useAgentOptions, type AgentOption } from './AgentSelect.tsx';
import { ConnectionTestPanel } from './ConnectionTestPanel.tsx';
import { Msg, PlatformFields, StatusBadge } from './PlatformCard.tsx';
import { PlatformIcon } from './PlatformIcon.tsx';
import { SetupGuide } from './SetupGuide.tsx';
import { ConfirmModal } from '../ConfirmModal.tsx';
import { Switch } from '../Switch.tsx';

/** The instance operations the UI needs; injectable for tests. */
export interface InstanceClient {
  create(platform: string, label: string): Promise<InstanceStatus>;
  save(id: string, payload: Record<string, unknown>): Promise<void>;
  /** The cheap credential probe ("is this token real?"). */
  test(id: string, payload: Record<string, unknown>): Promise<TestConnectionResponse>;
  remove(id: string): Promise<void>;
  listChannels(id: string): Promise<InstanceChannelsResponse>;
  saveChannels(id: string, channels: InstanceChannelBinding[]): Promise<void>;
  /** Begin a two-leg verification; resolves with the initial run snapshot. */
  startConnectionTest(
    id: string,
    body?: { channelId?: string; channelName?: string },
  ): Promise<ConnectionTestSnapshot>;
  /** The active run, or `null` when none exists. */
  getConnectionTest(id: string): Promise<ConnectionTestSnapshot | null>;
}

export const defaultInstanceClient: InstanceClient = {
  create: (platform, label) =>
    api.settings.createInstance(platform, label).then((r) => r.instance),
  save: (id, payload) => api.settings.saveInstance(id, payload).then(() => undefined),
  test: (id, payload) => api.settings.testInstance(id, payload),
  remove: (id) => api.settings.deleteInstance(id).then(() => undefined),
  listChannels: (id) => api.settings.listInstanceChannels(id),
  saveChannels: (id, channels) =>
    api.settings.saveInstanceChannels(id, channels).then(() => undefined),
  startConnectionTest: (id, body) => api.settings.startConnectionTest(id, body).then((r) => r.test),
  getConnectionTest: (id) => api.settings.getConnectionTest(id).then((r) => r.test),
};

/** How long an edit must be quiet before it is written. */
const AUTOSAVE_DEBOUNCE_MS = 700;

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; text: string };

export interface InstanceCardProps {
  instance: InstanceStatus;
  client?: InstanceClient;
  /** Front-end extras registry, keyed by platform id (unchanged seam). */
  extras?: Record<string, PlatformExtras>;
  /** Called after any server-side change so the parent can re-read. */
  onChanged?: () => void | Promise<void>;
  /** Draft only: the bot now exists — the parent swaps the draft for the real card. */
  onCreated?: (id: string) => void;
  /** Agent list loader. Defaults to the cached API. */
  loadAgents?: () => Promise<AgentOption[]>;
  defaultExpanded?: boolean;
}

export function InstanceCard({
  instance,
  client = defaultInstanceClient,
  extras = {},
  onChanged,
  onCreated,
  loadAgents,
  defaultExpanded,
}: InstanceCardProps) {
  const { t } = useTranslation(['settings', 'common']);
  const draft = isDraft(instance);
  // A draft opens straight into its steps; an existing bot stays folded, so the
  // page is a scannable list until the user asks for one.
  const [expanded, setExpanded] = useState(defaultExpanded ?? draft);
  const [moreOpen, setMoreOpen] = useState(false);

  const status = useMemo(() => instanceAsPlatform(instance), [instance]);

  // ── The form ──────────────────────────────────────────────────────────────
  const [label, setLabel] = useState(instance.label);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialDraft(status));
  const [enabled, setEnabled] = useState(instance.enabled);
  const [bindings, setBindings] = useState<InstanceChannelBinding[]>(instance.channels);
  const [notifyAgentId, setNotifyAgentId] = useState<string>(
    typeof instance.notifyAgentId === 'string' ? instance.notifyAgentId : '',
  );
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });

  // ── Routing (inside "More settings") ──────────────────────────────────────
  const [known, setKnown] = useState<PlatformChannel[]>([]);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // ── Verification ──────────────────────────────────────────────────────────
  const [test, setTest] = useState<ConnectionTestSnapshot | null>(null);
  const [startingTest, setStartingTest] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const testLive = isTestLive(test);

  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // Only a platform that actually declares an agent field needs the list: asking
  // for it otherwise is a request no one uses.
  const needsAgents = instance.fields.some((field) => field.type === 'agent');
  const agents = useAgentOptions(
    useMemo(() => loadAgents ?? loadAgentOptions, [loadAgents]),
    needsAgents,
  );
  const agentName = useCallback(
    (id: string | null) => (id ? agents.find((a) => a.id === id)?.name ?? id : ''),
    [agents],
  );

  // ── Adopt server-side changes, but never clobber unsaved edits ────────────
  // Keyed on a *content* fingerprint, so the re-read after a save does not
  // reset the form, while a genuine change to the stored values does. The
  // `dirty` guard is what stops a re-read mid-typing from eating keystrokes.
  const fingerprint = statusFingerprint(status);
  const instanceRef = useRef(instance);
  instanceRef.current = instance;
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (dirtyRef.current) return;
    const next = instanceRef.current;
    setLabel(next.label);
    setValues(initialDraft(instanceAsPlatform(next)));
    setEnabled(next.enabled);
    setBindings(next.channels);
    setNotifyAgentId(typeof next.notifyAgentId === 'string' ? next.notifyAgentId : '');
  }, [fingerprint]);

  // A different bot entirely: forget the previous one's transient state.
  useEffect(() => {
    setSaveState({ kind: 'idle' });
    setTest(null);
    setTestError(null);
  }, [instance.id]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setSaveState({ kind: 'idle' });
  }, []);

  const setField = useCallback((key: string, value: unknown) => {
    markDirty();
    setValues((prev) => ({ ...prev, [key]: value }));
  }, [markDirty]);

  const changeLabel = useCallback((value: string) => {
    markDirty();
    setLabel(value);
  }, [markDirty]);

  const changeEnabled = useCallback((next: boolean) => {
    markDirty();
    setEnabled(next);
  }, [markDirty]);

  const runSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const runSave = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaveState({ kind: 'saving' });
    try {
      let id = instanceRef.current.id;
      if (!id) {
        const created = await client.create(instanceRef.current.platform, label.trim());
        id = created.id;
      }
      // One payload, one writer: credential fields and the routing key are both
      // read from the *current draft*, so a routing change can never replay a
      // stale `agentId` over a freshly picked one.
      await client.save(id, { ...buildSavePayload(status, values, enabled), notifyAgentId });
      if (instanceRef.current.canListChannels) {
        await client.saveChannels(id, bindings);
      }

      // Then probe. The probe is the cheap half of "test"; the two-way
      // handshake stays user-initiated because it sends a real IM message.
      let failure: string | null = null;
      try {
        const { ok, text, code } = testResultMessage(await client.test(id, {}));
        if (!ok && !/not supported/i.test(text)) {
          failure =
            code === 'network_unreachable'
              ? t('settings:integrations.savedNotVerifiedNetwork')
              : t('settings:integrations.savedNotVerified', { reason: text });
        }
      } catch (err) {
        failure = t('settings:integrations.savedNotVerified', { reason: String(err) });
      }

      dirtyRef.current = false;
      setSaveState(failure ? { kind: 'error', text: failure } : { kind: 'saved' });

      await onChanged?.();
      if (instanceRef.current.id === '') onCreated?.(id);
    } catch (err) {
      setSaveState({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      savingRef.current = false;
    }
  }, [client, status, values, enabled, notifyAgentId, bindings, label, t, onChanged, onCreated]);

  runSaveRef.current = runSave;

  const missing = missingRequired(status.fields, values, instance.secrets);
  const nameMissing = draft && label.trim() === '';
  // A chat ticked while the bot has no default agent carries an empty agentId,
  // which is not a route — persisting it would leave a chat that answers from
  // nowhere. It blocks the save, and the routing panel names the gap. Saving is
  // automatic now, so "blocked" has to mean "does not fire", not "button is
  // disabled" — otherwise the warning would be the only signal.
  const routesComplete = bindings.every((binding) => binding.agentId);
  const readyToSave = !nameMissing && missing.length === 0 && routesComplete;

  // A stable content key for everything the save writes.
  const editKey = useMemo(
    () => JSON.stringify([label, enabled, notifyAgentId, bindings, values]),
    [label, enabled, notifyAgentId, bindings, values],
  );

  useEffect(() => {
    if (!dirtyRef.current || !readyToSave) return;
    const timer = setTimeout(() => { void runSaveRef.current(); }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [editKey, readyToSave]);

  // ── Verification: adopt the live run, and poll while it can still change ──
  useEffect(() => {
    if (!expanded || draft) return;
    let alive = true;
    client.getConnectionTest(instance.id)
      .then((next) => { if (alive && next) setTest(next); })
      .catch(() => { /* transient: keep the last known state rather than clearing it */ });
    return () => { alive = false; };
  }, [expanded, draft, client, instance.id]);

  useEffect(() => {
    if (!expanded || !testLive) return;
    let alive = true;
    const timer = setInterval(() => {
      client.getConnectionTest(instance.id)
        .then((next) => { if (alive && next) setTest(next); })
        .catch(() => { /* transient: keep the last known state */ });
    }, 2500);
    return () => { alive = false; clearInterval(timer); };
  }, [expanded, testLive, client, instance.id]);

  // A completed run is a *durable* fact, but the badge's durable answer comes
  // from the instance list (`lastVerifiedAt`), which is only as fresh as the last
  // read. Pull the list back in once per completed verification so the verified
  // state survives the transient run being forgotten or expiring.
  const refreshedRef = useRef<string | null>(null);
  useEffect(() => {
    if (test?.status !== 'verified') return;
    if (refreshedRef.current === instance.id) return;
    refreshedRef.current = instance.id;
    void onChanged?.();
  }, [test?.status, instance.id, onChanged]);

  const runConnectionTest = useCallback(async () => {
    setStartingTest(true);
    setTestError(null);
    try {
      setTest(await client.startConnectionTest(instance.id));
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingTest(false);
    }
  }, [client, instance.id]);

  // ── Conversations (only when the platform can enumerate them) ─────────────
  useEffect(() => {
    if (!expanded || !instance.canListChannels || !instance.id) return;
    let alive = true;
    client.listChannels(instance.id)
      .then((res) => {
        if (!alive) return;
        setKnown(res.channels ?? []);
        setChannelsError(res.error ?? null);
      })
      .catch((err) => {
        if (!alive) return;
        setKnown([]);
        setChannelsError(err instanceof Error ? err.message : String(err));
      });
    return () => { alive = false; };
  }, [expanded, instance.canListChannels, instance.id, client]);

  // ── Extras (a platform's own richer panel) ────────────────────────────────
  const extrasEntry = extras[instance.platform];
  const extrasCtx: PlatformExtrasContext = useMemo(
    () => ({
      platformId: instance.platform,
      status,
      values,
      setValue: setField,
      reload: () => { void onChanged?.(); },
    }),
    [instance.platform, status, values, setField, onChanged],
  );
  const ownedKeys = useMemo(() => new Set(extrasEntry?.ownedFields ?? []), [extrasEntry]);
  const genericFields = useMemo(
    () => status.fields.filter((f) => !ownedKeys.has(f.key)),
    [status.fields, ownedKeys],
  );
  const primary = useMemo(() => primaryFields(genericFields), [genericFields]);
  const secondary = useMemo(() => secondaryFields(genericFields), [genericFields]);

  const visibleKnown = useMemo(() => filterChannels(known, search), [known, search]);
  const orphans = useMemo(() => orphanBindings(bindings, known), [bindings, known]);
  const unassigned = bindings.filter((b) => !b.agentId).length;

  const toggleChannel = useCallback((channel: PlatformChannel, on: boolean) => {
    markDirty();
    setBindings((prev) =>
      on
        ? setChannelBinding(
            prev,
            channel.id,
            bindingFor(prev, channel.id)?.agentId ?? instance.agentId ?? '',
            channel.kind ?? null,
          )
        : removeChannelBinding(prev, channel.id),
    );
  }, [markDirty, instance.agentId]);

  const assignChannel = useCallback((nativeId: string, agentId: string) => {
    markDirty();
    setBindings((prev) =>
      setChannelBinding(prev, nativeId, agentId, bindingFor(prev, nativeId)?.kind ?? null),
    );
  }, [markDirty]);

  const handleDisconnect = useCallback(async () => {
    setConfirmDisconnect(false);
    try {
      await client.remove(instance.id);
      // The parent re-reads and this card is no longer in the list, so it
      // unmounts — leaving no "Disconnected" ghost behind for a deleted bot.
      await onChanged?.();
    } catch (err) {
      setSaveState({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }, [client, instance.id, onChanged]);

  const state = connectionState(instance, test?.status === 'verified');
  // A draft has no id yet, but its DOM must still be addressable: every test id
  // below is keyed on this, so tests (and the browser) can find a bot that the
  // server does not know about yet.
  const uid = instance.id || `new-${instance.platform}`;
  const nameId = `instance-name-${uid}`;
  const missingLabels = missing
    .map((key) => {
      const field = status.fields.find((f) => f.key === key);
      return field ? fieldText(t, instance.platform, field).label : key;
    })
    .join(', ');

  return (
    <div
      className="bg-surface-elevated rounded-xl overflow-hidden border border-border-default"
      data-testid={`instance-card-${uid}`}
      data-instance={instance.id}
      data-platform={instance.platform}
      data-draft={draft ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
      data-connection={state}
    >
      {/* ── Header: identity, status, and the bot's master switch ───────── */}
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          data-testid={`instance-toggle-${uid}`}
          className="flex-1 min-w-0 flex items-center gap-3 text-left"
        >
          <PlatformIcon id={instance.platform} />
          <span className="flex-1 min-w-0 flex items-center gap-2.5">
            <span
              className="text-sm font-medium text-fg-primary truncate"
              data-testid={`instance-label-${uid}`}
            >
              {label.trim() === '' ? t('settings:instances.newBot', { defaultValue: 'New bot' }) : label}
            </span>
            {!draft && (
              <span
                className="hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium bg-surface-secondary border border-border-default text-fg-tertiary"
                data-testid={`instance-platform-${uid}`}
              >
                {instance.platform}
              </span>
            )}
            {!draft && instance.agentId && (
              <span
                className="hidden sm:inline-flex items-center gap-1.5 text-xs text-fg-tertiary truncate"
                data-testid={`instance-agent-${uid}`}
                title={t('settings:instances.boundAgent', { defaultValue: 'Bound agent' })}
              >
                <span className="text-fg-quaternary">→</span>
                {agentName(instance.agentId)}
              </span>
            )}
          </span>
        </button>
        <div className="flex items-center gap-2.5 shrink-0">
          <StatusBadge state={state} />
          {!draft && (
            <Switch
              checked={enabled}
              onChange={changeEnabled}
              size="md"
              testId={`instance-enabled-${uid}`}
              label={t('settings:instances.toggleLabel', { defaultValue: 'Turn this bot on or off' })}
            />
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            data-testid={`instance-chevron-${uid}`}
            className="p-1 text-fg-tertiary hover:text-fg-secondary transition-colors"
          >
            <svg
              className={`w-4 h-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
              viewBox="0 0 20 20"
              fill="currentColor"
            >
              <path
                fillRule="evenodd"
                d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-6 pb-6 pt-5 border-t border-border-default space-y-6">
          {/* 1 — How to get the credentials. Always first: for a new bot it is
                 the whole point, and for a configured one it collapses. */}
          <SetupGuide status={status} configured={instance.hasConfig} />

          {/* 2 — The platform's own richer panel, when it asks to be seen first
                 (Feishu's scan-to-create is the recommended path). */}
          {extrasEntry?.placement === 'before' && extrasEntry.render(extrasCtx)}

          {/* 3 — Credentials. Only what the platform cannot work without, plus
                 the agent that answers; everything else moved to "More". */}
          <section data-testid={`instance-credentials-${uid}`}>
            <h3 className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider mb-3">
              {t('settings:instances.credentials', { defaultValue: 'Credentials' })}
            </h3>
            <div className="space-y-4">
              <div>
                <label htmlFor={nameId} className="block text-xs font-medium text-fg-secondary mb-1.5">
                  {t('settings:instances.addBot.name', { defaultValue: 'Bot name' })}
                  <span className="text-red-500 ml-0.5">*</span>
                </label>
                <input
                  id={nameId}
                  data-testid={`new-bot-name-${instance.platform}`}
                  value={label}
                  onChange={(e) => changeLabel(e.target.value)}
                  placeholder={t('settings:instances.addBot.namePlaceholder', { defaultValue: 'e.g. Sales' })}
                  className="w-full px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500 transition-colors"
                />
              </div>
              <PlatformFields
                status={status}
                draft={values}
                fields={primary}
                onChange={setField}
                agentOptions={agents}
              />
            </div>

            {/* Auto-save outcome, right where the edits happen. */}
            <div className="mt-3 min-h-[1.25rem]" data-testid={`instance-save-state-${uid}`}>
              <span
                data-state={saveState.kind}
                className="inline-flex items-center gap-2 text-xs text-fg-tertiary"
              >
                {saveState.kind === 'saving' && (
                  <>
                    <span className="w-3 h-3 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
                    {t('settings:instances.autosave.saving', { defaultValue: 'Saving…' })}
                  </>
                )}
                {saveState.kind === 'saved' && (
                  <span className="text-green-600">
                    ✓ {t('settings:instances.autosave.saved', { defaultValue: 'Saved' })}
                  </span>
                )}
                {!readyToSave && (
                  <span data-testid={`instance-missing-${uid}`}>
                    {missing.length > 0
                      ? t('settings:integrations.missingRequired', {
                          defaultValue: 'Required: {{fields}}',
                          fields: missingLabels,
                        })
                      : t('settings:instances.addBot.labelRequired', { defaultValue: 'Give the bot a name.' })}
                  </span>
                )}
              </span>
            </div>
            {saveState.kind === 'error' && (
              <div className="mt-2">
                <Msg type="err" text={saveState.text} />
              </div>
            )}
          </section>

          {/* 4 — The two-way handshake. A run, not a setting, so it sits above
                 the settings fold. */}
          {!draft && (
            <section>
              <ConnectionTestPanel
                test={test}
                starting={startingTest}
                lastVerifiedAt={instance.lastVerifiedAt}
                onStart={() => { void runConnectionTest(); }}
              />
              {testError && (
                <div className="mt-3">
                  <Msg type="err" text={testError} />
                </div>
              )}
            </section>
          )}

          {/* 5 — Everything else, folded away. */}
          <section>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              data-testid={`instance-more-toggle-${uid}`}
              className="w-full flex items-center gap-2 text-left group"
            >
              <span className="text-xs font-semibold text-fg-tertiary uppercase tracking-wider">
                {t('settings:instances.moreSettings', { defaultValue: 'More settings' })}
              </span>
              <span className="text-[11px] text-fg-quaternary truncate hidden sm:inline">
                {t('settings:instances.moreSettingsHint', {
                  defaultValue: 'Routing, notification target and advanced options',
                })}
              </span>
              <svg
                className={`ml-auto w-3.5 h-3.5 text-fg-tertiary transition-transform ${moreOpen ? 'rotate-90' : ''}`}
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                  clipRule="evenodd"
                />
              </svg>
            </button>

            {moreOpen && (
              <div
                className="mt-3 space-y-5 bg-surface-secondary border border-border-default rounded-xl p-5"
                data-testid={`instance-more-${uid}`}
              >
                {secondary.length > 0 && (
                  <div className="space-y-4">
                    {!draft && (
                      <p className="text-[11px] text-fg-tertiary">
                        {t('settings:instances.advancedHint', {
                          defaultValue:
                            'These default to the right value for almost every setup — leave them alone unless you know you need them.',
                        })}
                      </p>
                    )}
                    <PlatformFields
                      status={status}
                      draft={values}
                      fields={secondary}
                      onChange={setField}
                      agentOptions={agents}
                    />
                  </div>
                )}

                {!draft && (
                  <div>
                    <div className="text-xs font-medium text-fg-secondary mb-1.5">
                      {t('settings:instances.routing.notifyTarget', { defaultValue: 'Notification target' })}
                    </div>
                    <div data-testid={`instance-notify-${uid}`}>
                      <AgentSelect
                        value={notifyAgentId}
                        options={agents}
                        onChange={(_key, value) => {
                          markDirty();
                          setNotifyAgentId(typeof value === 'string' ? value : '');
                        }}
                        fieldKey="notifyAgentId"
                        ariaLabel={t('settings:instances.routing.notifyTarget', {
                          defaultValue: 'Notification target',
                        })}
                      />
                    </div>
                    <p className="text-[11px] text-fg-tertiary mt-1">
                      {t('settings:instances.routing.notifyTargetHint', {
                        defaultValue:
                          'Approvals and notifications about this bot are delivered here. Leave empty to use the org secretary.',
                      })}
                    </p>
                  </div>
                )}

                {!draft && (
                  <div>
                    <div className="text-xs font-medium text-fg-secondary mb-1.5">
                      {t('settings:instances.routing.chats', { defaultValue: 'Chat bindings' })}
                    </div>

                    {!instance.canListChannels && (
                      <p
                        className="text-[11px] text-fg-tertiary"
                        data-testid={`instance-chats-unsupported-${uid}`}
                      >
                        {t('settings:instances.routing.unsupported', {
                          defaultValue: 'This platform does not let us list its chats.',
                        })}
                      </p>
                    )}

                    {channelsError && (
                      <p
                        className="text-[11px] text-red-600 mb-2"
                        data-testid={`instance-chats-error-${uid}`}
                      >
                        {channelsError}
                      </p>
                    )}

                    {instance.canListChannels && known.length > 0 && (
                      <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={t('settings:instances.routing.searchChats', {
                          defaultValue: 'Search chats…',
                        })}
                        data-testid={`instance-chat-search-${uid}`}
                        className="w-full mb-2 px-3 py-2 text-sm bg-surface-primary border border-border-default rounded-lg text-fg-primary placeholder-fg-tertiary focus:outline-none focus:ring-2 focus:ring-brand-500/40 focus:border-brand-500"
                      />
                    )}

                    <div className="space-y-2" data-testid={`instance-chats-${uid}`}>
                      {visibleKnown.map((channel) => {
                        const bound = bindingFor(bindings, channel.id);
                        return (
                          <div key={channel.id} className="flex flex-wrap items-center gap-2">
                            <label className="flex items-center gap-2 text-sm text-fg-primary min-w-0 flex-1">
                              <input
                                type="checkbox"
                                checked={!!bound}
                                data-testid={`instance-chat-toggle-${uid}-${channel.id}`}
                                onChange={(e) => toggleChannel(channel, e.target.checked)}
                                className="rounded border-border-default"
                              />
                              <span className="truncate" title={channel.id}>{channel.name}</span>
                            </label>
                            {bound && (
                              <div
                                className="w-56"
                                data-testid={`instance-chat-agent-${uid}-${channel.id}`}
                              >
                                <AgentSelect
                                  value={bound.agentId}
                                  options={agents}
                                  onChange={(_key, value) =>
                                    assignChannel(channel.id, typeof value === 'string' ? value : '')
                                  }
                                  fieldKey="agentId"
                                  ariaLabel={t('settings:instances.routing.chatAgent', {
                                    defaultValue: 'Agent for this chat',
                                  })}
                                />
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* A conversation the platform no longer advertises keeps
                          its binding visible rather than vanishing silently. */}
                      {orphans.map((b) => (
                        <div key={b.nativeId} className="flex flex-wrap items-center gap-2">
                          <label className="flex items-center gap-2 text-sm text-fg-primary min-w-0 flex-1">
                            <input
                              type="checkbox"
                              checked
                              data-testid={`instance-chat-toggle-${uid}-${b.nativeId}`}
                              onChange={() => setBindings((prev) => removeChannelBinding(prev, b.nativeId))}
                              className="rounded border-border-default"
                            />
                            <span className="truncate font-mono text-xs" title={b.nativeId}>
                              {b.nativeId}
                            </span>
                          </label>
                          <div
                            className="w-56"
                            data-testid={`instance-chat-agent-${uid}-${b.nativeId}`}
                          >
                            <AgentSelect
                              value={b.agentId}
                              options={agents}
                              onChange={(_key, value) =>
                                assignChannel(b.nativeId, typeof value === 'string' ? value : '')
                              }
                              fieldKey="agentId"
                              ariaLabel={t('settings:instances.routing.chatAgent', {
                                defaultValue: 'Agent for this chat',
                              })}
                            />
                          </div>
                        </div>
                      ))}
                    </div>

                    <p className="text-[11px] text-fg-tertiary mt-2">
                      {t('settings:instances.routing.autoSaved', {
                        defaultValue: 'Changes are saved automatically.',
                      })}
                    </p>

                    {unassigned > 0 && (
                      <div className="mt-3">
                        <Msg
                          type="err"
                          text={t('settings:instances.routing.agentRequired', {
                            defaultValue: 'Pick an agent for every selected chat ({{count}} still unassigned).',
                            count: unassigned,
                          })}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* 6 — A platform panel that asked to sit after the form. */}
          {extrasEntry && extrasEntry.placement !== 'before' && extrasEntry.render(extrasCtx)}

          {/* 7 — Destructive, and last. */}
          {!draft && (
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setConfirmDisconnect(true)}
                data-testid={`instance-disconnect-${uid}`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition-colors"
              >
                {t('settings:integrations.disconnect', { defaultValue: 'Disconnect' })}
              </button>
            </div>
          )}
        </div>
      )}

      {confirmDisconnect && (
        <ConfirmModal
          title={t('settings:integrations.disconnectConfirmTitle', { defaultValue: 'Disconnect this bot?' })}
          message={t('settings:integrations.disconnectConfirmMessage', {
            defaultValue:
              'Its stored credentials are removed and it stops sending and receiving messages. This cannot be undone.',
          })}
          confirmLabel={t('settings:integrations.disconnect', { defaultValue: 'Disconnect' })}
          variant="danger"
          onConfirm={() => { void handleDisconnect(); }}
          onCancel={() => setConfirmDisconnect(false)}
        />
      )}
    </div>
  );
}
