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
import { useChannelList } from '../../hooks/useChannelList.ts';
import {
  notificationDestinationFields,
  notificationFields,
} from '../../lib/platformNotifications.ts';
import { AgentSelect, loadAgentOptions, useAgentOptions, type AgentOption } from './AgentSelect.tsx';
import { ChannelsRefresh } from './ChannelsRefresh.tsx';
import { ConnectionTestPanel } from './ConnectionTestPanel.tsx';
import { NotificationPanel } from './NotificationPanel.tsx';
import { Msg, PlatformFields, StatusBadge } from './PlatformCard.tsx';
import { PlatformIcon } from './PlatformIcon.tsx';
import { SetupGuide } from './SetupGuide.tsx';
import { ConfirmModal } from '../ConfirmModal.tsx';
import { Switch } from '../Switch.tsx';
import { CARD, CARD_TITLE, HINT, INPUT, ROW, ROW_CONTROL, ROW_LABEL } from './ui.ts';

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

  // ── Setup method — the guided scan and the manual credential inputs are
  // alternatives, never shown together ───────────────────────────────────────
  // A platform that declares `guidedSetup` (Feishu) offers a guided way to
  // establish its own credentials. A bot that already has credentials, or a
  // platform with no guided method, sits on the manual path.
  const offersGuided = !!extras[instance.platform]?.guidedSetup;
  const [setupMethod, setSetupMethod] = useState<'guided' | 'manual'>(
    offersGuided && !instance.hasConfig ? 'guided' : 'manual',
  );
  // True while the guided method is the one on screen. The guided panel and the
  // manual credential inputs are rendered in place of each other — see the
  // connection section below.
  const guidedActive = offersGuided && setupMethod === 'guided';

  // ── Conversations (one shared action; see `useChannelList`) ───────────────
  // The notification picker and the chat-bindings fold are two views of the
  // SAME list, so they share one fetch, one loading flag and one error — the
  // card can only ever be looking at one version of "who can this bot reach".
  const {
    channels: known,
    error: channelsError,
    loading: channelsLoading,
    reloadChannels,
  } = useChannelList(client.listChannels, instance.id, expanded && instance.canListChannels);
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
    setShowCredentials(false);
  }, [instance.id]);

  // The guided method only makes sense while the bot has no credentials of its
  // own; once they exist — or for a platform with no guided method — the card
  // falls back to the manual path. (Re-keyed on `hasConfig` so a bot created by
  // the scan opens, on the next read, on the manual path with its credentials.)
  useEffect(() => {
    setSetupMethod(offersGuided && !instance.hasConfig ? 'guided' : 'manual');
  }, [instance.id, instance.hasConfig, offersGuided]);

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
  // The guided path (scan) creates the bot server-side, so the card must NOT
  // also auto-create it from a half-filled draft — autosave is off while guided.
  const readyToSave = !guidedActive && !nameMissing && missing.length === 0 && routesComplete;

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

  // ── Extras (a platform's own richer panel) ────────────────────────────────
  const extrasEntry = extras[instance.platform];
  const extrasCtx: PlatformExtrasContext = useMemo(
    () => ({
      platformId: instance.platform,
      instanceId: instance.id || undefined,
      status,
      values,
      setValue: setField,
      reload: () => { void onChanged?.(); },
      agents,
      onCreated,
      // Present only for a platform that offers the guided method — the card owns
      // the choice so it can hide + stop requiring the fields the guided path
      // supplies; the panel renders the guided UI when `guided`.
      setupMethod: offersGuided ? setupMethod : undefined,
      setSetupMethod: offersGuided ? setSetupMethod : undefined,
    }),
    [instance.platform, instance.id, status, values, setField, onChanged, agents, onCreated, offersGuided, setupMethod],
  );
  const ownedKeys = useMemo(() => new Set(extrasEntry?.ownedFields ?? []), [extrasEntry]);

  // ── Notification destinations (generic, manifest-driven) ──────────────────
  // A platform whose manifest declares a destination gets the *same* panel as
  // every other one — there is deliberately no per-platform code path here, so
  // a platform added later is covered the day it annotates a destination. The
  // panel then owns those fields (and the preference knobs next to them), so
  // the generic form must not render them a second time. A platform that
  // declares no destination keeps today's behaviour exactly.
  const hasNotificationPanel = notificationDestinationFields(status.fields).length > 0;
  const notificationOwned = useMemo(
    () => new Set(hasNotificationPanel ? notificationFields(status.fields).map((f) => f.key) : []),
    [status.fields, hasNotificationPanel],
  );

  const genericFields = useMemo(
    () => status.fields.filter((f) => !ownedKeys.has(f.key) && !notificationOwned.has(f.key)),
    [status.fields, ownedKeys, notificationOwned],
  );
  const primary = useMemo(() => primaryFields(genericFields), [genericFields]);
  const secondary = useMemo(() => secondaryFields(genericFields), [genericFields]);

  // The primary fields are two different things wearing one label: the *agent*
  // that answers (the step that actually remains after a bot is connected) and
  // the *credentials* (already filled in by a scan or an earlier save). They are
  // split so the agent is always visible and the credentials can fold away once
  // they resolve — a user who just scanned a QR did not come here to retype the
  // app secret.
  const agentFields = useMemo(() => primary.filter((f) => f.type === 'agent'), [primary]);
  const credentialFields = useMemo(() => primary.filter((f) => f.type !== 'agent'), [primary]);
  const [showCredentials, setShowCredentials] = useState(false);
  // "Credentials are in place" is a fact about the **stored** row, never about
  // the live draft. Deriving it from `values` made the fold flip the instant the
  // user cleared a field — which re-mounted the very input being edited and
  // dropped the keystrokes. Reading it from `instance` means it can only change
  // when the server says so.
  const storedMissing = useMemo(
    () => missingRequired(instance.fields, instance.values, instance.secrets),
    [instance.fields, instance.values, instance.secrets],
  );
  const credentialsConfigured =
    instance.hasConfig && !storedMissing.some((key) => credentialFields.some((f) => f.key === key));

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
                <span className="text-fg-muted">→</span>
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
          {/* 1 — How to get the credentials — the *manual* path's instructions.
                 Shown only while they still apply: a bot that already has
                 credentials is past them, and the scan path needs none of them
                 (the app is created and configured for you). */}
          {!instance.hasConfig && !guidedActive && (
            <SetupGuide
              status={status}
              configured={instance.hasConfig}
              canListChannels={instance.canListChannels}
              channelsGuidance={instance.channelsGuidance ?? null}
            />
          )}

          {/* 2 — A platform panel that asked to be seen first *and* declares no
                 guided method. A platform WITH a guided method (Feishu) is
                 rendered inside the connection section below instead, so the
                 guided path and the manual inputs can replace each other. */}
          {!offersGuided && extrasEntry?.placement === 'before' && extrasEntry.render(extrasCtx)}

          {/* 3 — How this bot connects. A platform that offers a guided method
                 (scan-to-create) shows a chooser between it and the manual
                 inputs — never both at once. Everything else is manual only.
                 Only what the platform cannot work without, plus the agent that
                 answers; the rest moved to "More". */}
          <section data-testid={`instance-credentials-${uid}`} className={CARD}>
            <h3 className={`${CARD_TITLE} mb-3`}>
              {instance.hasConfig
                ? t('settings:instances.setup.configuredTitle', { defaultValue: 'Bot setup' })
                : offersGuided
                  ? t('settings:instances.setup.title', { defaultValue: 'Connection' })
                  : t('settings:instances.credentials', { defaultValue: 'Credentials' })}
            </h3>

            {/* The scan/manual choice is a *creation* decision: a bot that
                already has credentials cannot be scan-created, so the chooser is
                shown only while the bot is still unconfigured. */}
            {offersGuided && !instance.hasConfig && (
              <div
                role="tablist"
                className="inline-flex rounded-lg border border-border-default bg-surface-secondary p-0.5 mb-4"
              >
                {(['guided', 'manual'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={setupMethod === m}
                    onClick={() => setSetupMethod(m)}
                    data-testid={`setup-method-${m}-${uid}`}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      setupMethod === m
                        ? 'bg-surface-elevated text-fg-primary shadow-sm'
                        : 'text-fg-tertiary hover:text-fg-secondary'
                    }`}
                  >
                    {m === 'guided'
                      ? t('settings:instances.setup.guided', { defaultValue: 'Scan to create (recommended)' })
                      : t('settings:instances.setup.manual', { defaultValue: 'Enter credentials manually' })}
                  </button>
                ))}
              </div>
            )}

            {guidedActive ? (
              <div className="space-y-4">{extrasEntry!.render(extrasCtx)}</div>
            ) : (
            <div className="space-y-4">
              <div className={ROW}>
                <label htmlFor={nameId} className={ROW_LABEL}>
                  {t('settings:instances.addBot.name', { defaultValue: 'Bot name' })}
                  <span className="text-red-500 ml-0.5">*</span>
                </label>
                <div className={ROW_CONTROL}>
                  <input
                    id={nameId}
                    data-testid={`new-bot-name-${instance.platform}`}
                    value={label}
                    onChange={(e) => changeLabel(e.target.value)}
                    placeholder={t('settings:instances.addBot.namePlaceholder', { defaultValue: 'e.g. Sales' })}
                    className={INPUT}
                  />
                </div>
              </div>
              {agentFields.length > 0 && (
                <PlatformFields
                  status={status}
                  draft={values}
                  fields={agentFields}
                  onChange={setField}
                  agentOptions={agents}
                />
              )}
              {credentialFields.length > 0 &&
                (credentialsConfigured && !showCredentials ? (
                  <div data-testid={`instance-credentials-configured-${uid}`} className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
                        <span aria-hidden="true">✓</span>
                        {t('settings:instances.credentialsSet', { defaultValue: 'Credentials set' })}
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowCredentials(true)}
                        data-testid={`instance-credentials-edit-${uid}`}
                        className="text-xs text-brand-600 hover:text-brand-700"
                      >
                        {t('settings:instances.credentialsEdit', { defaultValue: 'Change' })}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {credentialsConfigured && (
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
                          <span aria-hidden="true">✓</span>
                          {t('settings:instances.credentialsSet', { defaultValue: 'Credentials set' })}
                        </span>
                        <button
                          type="button"
                          onClick={() => setShowCredentials(false)}
                          data-testid={`instance-credentials-hide-${uid}`}
                          className="text-xs text-brand-600 hover:text-brand-700"
                        >
                          {t('settings:instances.credentialsHide', { defaultValue: 'Hide' })}
                        </button>
                      </div>
                    )}
                    <PlatformFields
                      status={status}
                      draft={values}
                      fields={credentialFields}
                      onChange={setField}
                      agentOptions={agents}
                    />
                  </div>
                ))}
            </div>
            )}

            {/* Auto-save outcome, right where the edits happen. Hidden while the
                guided method is showing — the scan (not autosave) creates the
                bot, so there is nothing to save and no gap to name. */}
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
                {!readyToSave && !guidedActive && (
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

          {/* 4 — The two-way handshake, directly under the credentials it proves:
                 a run, not a setting, so it never hides in the settings fold. */}
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

          {/* 5 — Where this bot delivers. Rendered for any platform whose
                 manifest declares a destination — never a Feishu-only branch. */}
          {!draft && hasNotificationPanel && (
            <NotificationPanel
              status={status}
              values={values}
              setValue={setField}
              channels={known}
              canListChannels={instance.canListChannels}
              channelsLoading={channelsLoading}
              channelsError={channelsError}
              onReloadChannels={reloadChannels}
              channelsGuidance={instance.channelsGuidance ?? null}
              testSlot={extrasEntry?.sendTest?.(extrasCtx)}
            />
          )}

          {/* 6 — Advanced, folded away. Each subsection is its own card, so the
                 fold never becomes a wall of unrelated controls. */}
          <section data-testid={`instance-more-${uid}`}>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              data-testid={`instance-more-toggle-${uid}`}
              className="w-full flex items-center gap-2 text-left group px-1"
            >
              <span className={CARD_TITLE}>
                {t('settings:instances.moreSettings', { defaultValue: 'Advanced' })}
              </span>
              <span className={`${HINT} truncate hidden sm:inline`}>
                {t('settings:instances.moreSettingsHint', {
                  defaultValue: 'Chat routing and platform options',
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
              <div className="mt-3 space-y-4">
                {secondary.length > 0 && (
                  <div className={CARD}>
                    <h4 className={`${CARD_TITLE} mb-1`}>
                      {t('settings:instances.advancedTitle', { defaultValue: 'Platform options' })}
                    </h4>
                    {!draft && (
                      <p className={`${HINT} mb-3`}>
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

                {/* The old “fallback: notify this agent” picker lived here. It
                    was removed: it delivered notifications to an *agent’s own
                    conversation* (a DM), which contradicts the one rule this
                    area now enforces — approvals and notifications go to a
                    group. A destination is declared in the panel above; a
                    second, invisible terminus only made “where did it go?”
                    unanswerable. */}

                {!draft && (
                  <div className={CARD}>
                    <h4 className={`${CARD_TITLE} mb-1`}>
                      {t('settings:instances.routing.chats', { defaultValue: 'Chat routing' })}
                    </h4>
                    <p className={`${HINT} mb-3`}>
                      {t('settings:instances.routing.chatsHint', {
                        defaultValue:
                          'The agent bound above answers every chat by default. Route a specific chat to a different agent here.',
                      })}
                    </p>

                    {!instance.canListChannels && (
                      <p
                        className="text-[11px] text-fg-tertiary"
                        data-testid={`instance-chats-unsupported-${uid}`}
                      >
                        {/* The manifest explains *why* (slice U1); fall back to a
                            generic line when the locale has no copy for it. */}
                        {instance.channelsGuidance
                          ? t(instance.channelsGuidance, {
                              defaultValue: t('settings:instances.routing.unsupported', {
                                defaultValue: 'This platform does not let us list its chats.',
                              }),
                            })
                          : t('settings:instances.routing.unsupported', {
                              defaultValue: 'This platform does not let us list its chats.',
                            })}
                      </p>
                    )}

                    {instance.canListChannels && (
                      <div className="mb-2">
                        <ChannelsRefresh
                          loading={channelsLoading}
                          error={channelsError}
                          onReload={reloadChannels}
                          empty={known.length === 0}
                          buttonTestId={`instance-chats-refresh-${uid}`}
                          errorTestId={`instance-chats-error-${uid}`}
                        />
                      </div>
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

          {/* 7 — A platform panel that asked to sit after the form (and declares
                 no guided method; a guided one is rendered in the connection
                 section above). */}
          {!offersGuided && extrasEntry && extrasEntry.placement !== 'before' && extrasEntry.render(extrasCtx)}

          {/* 8 — Destructive, and last. */}
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
