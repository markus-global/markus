/**
 * Bot-instance types + pure logic for the multi-bot Settings UI (slice G5 of the
 * messaging-gateway programme).
 *
 * Why this module
 * ───────────────
 * Before G5 the Settings page rendered **one card per platform**, because the
 * server could only store one bot per platform. Now a platform hosts many bot
 * instances (each with its own credentials, its own bound agent, its own groups),
 * so the page renders **one card per instance**.
 *
 * An instance is still a platform configuration — it is the *same* manifest
 * fields, the *same* secret-masking rule, the *same* required-field rule. So
 * instead of a second form implementation, `InstanceCard` adapts its
 * `InstanceStatus` into the `PlatformStatus` the existing form already
 * understands (`instanceAsPlatform`) and reuses the pure logic in
 * `platformIntegrations.ts` verbatim. One implementation of "how a platform
 * config behaves", N instances.
 *
 * What is genuinely new here — and therefore lives in this file — is the
 * instance *identity* (id/label) and the routing the platform card cannot
 * express: per-group bindings and the notification target.
 *
 * The DTO shapes mirror the server
 * (packages/org-manager/src/instance-integrations.ts).
 */

import {
  buildSavePayload,
  type PlatformCapabilities,
  type PlatformField,
  type PlatformSecretState,
  type PlatformStatus,
} from './platformIntegrations.ts';

// ─── Wire types ──────────────────────────────────────────────────────────────

/** One conversation a bot already knows about (group / DM). */
export interface PlatformChannel {
  id: string;
  name: string;
  kind?: string;
}

/** A per-conversation route: this native chat → this agent. */
export interface InstanceChannelBinding {
  nativeId: string;
  kind: string | null;
  agentId: string;
}

/** Everything the UI needs to render one bot's card. */
export interface InstanceStatus {
  /** Stable instance id (`bi_…`) — the only identity that survives a rename. */
  id: string;
  /** Manifest id (`feishu`, `telegram`, …). Drives every field on the card. */
  platform: string;
  /** User-facing instance name, e.g. `Sales`. Unique per (platform). */
  label: string;
  enabled: boolean;
  connected: boolean;
  hasConfig: boolean;
  capabilities: PlatformCapabilities;
  fields: PlatformField[];
  /** Stored non-secret values. */
  values: Record<string, unknown>;
  /** Secret fields → presence only; the value never reaches the browser. */
  secrets: Record<string, PlatformSecretState>;
  /** The bot's default answering agent. */
  agentId: string | null;
  /** Where this bot's notifications are delivered (falls back to the org secretary). */
  notifyAgentId: string | null;
  /** Per-conversation agent overrides. */
  channels: InstanceChannelBinding[];
  lastError: string | null;
  /** False when the platform manifest has no way to enumerate its conversations. */
  canListChannels: boolean;
  /**
   * When this bot last passed the two-leg handshake, or `null` if never.
   *
   * Persisted (unlike the transient run) because "did this ever work?" is a
   * fact about the bot, not about one pending handshake — the panel used to
   * forget it the moment the card was closed.
   */
  lastVerifiedAt: string | null;
}

/** `GET /api/settings/integrations/instances`. */
export interface InstanceListResponse {
  instances: InstanceStatus[];
}

/** `GET /api/settings/integrations/instances/:id/channels`. */
export interface InstanceChannelsResponse {
  supported: boolean;
  channels: PlatformChannel[];
  /** A listing that failed does not fail the page — it is reported here. */
  error?: string;
}

// ─── Connection verification (two-leg handshake) ─────────────────────────────

/**
 * One direction of the handshake, as measured by the gateway.
 *
 * The legs are separate on purpose: the interesting failures are asymmetric.
 * "inbound ok / outbound failed" is a bot that can hear you but cannot speak
 * (missing send scope); "outbound ok / inbound pending" is a prompt that went out
 * with no answer yet. One boolean would hide both.
 */
export type ConnectionTestLegState = 'pending' | 'ok' | 'failed';

export interface ConnectionTestLeg {
  state: ConnectionTestLegState;
  at?: string;
  detail?: string;
}

export type ConnectionTestStatus =
  | 'awaiting_reply'
  | 'awaiting_inbound'
  | 'verified'
  | 'expired';

/** `GET|POST /api/settings/integrations/instances/:id/connection-test`. */
export interface ConnectionTestSnapshot {
  instanceId: string;
  platform: string;
  status: ConnectionTestStatus;
  /** Short code the prompt asks the user to quote back. `null` if none was sent. */
  code: string | null;
  targetChannelId: string | null;
  targetChannelName: string | null;
  outbound: ConnectionTestLeg;
  inbound: ConnectionTestLeg;
  startedAt: string;
  expiresAt: string;
}

/** `GET …/connection-test` — `null` means "no run", a normal answer. */
export interface ConnectionTestResponse {
  test: ConnectionTestSnapshot | null;
}

/** True while the UI should keep polling for the user's reply. */
export function isTestLive(test: ConnectionTestSnapshot | null): boolean {
  return test?.status === 'awaiting_reply' || test?.status === 'awaiting_inbound';
}

// ─── Connection state ────────────────────────────────────────────────────────

/**
 * The one honest answer to "is this bot working?".
 *
 * Derived from two independent facts, in order: is it configured at all, and
 * has the two-way handshake succeeded. A green badge therefore claims both
 * — it is not just "the process started", which is what the old badge said.
 *
 * `liveRunVerified` lets the badge answer from the run the same card is already
 * displaying. The durable `lastVerifiedAt` is only written when the reply lands
 * (and the badge's list is only re-read after that), so a badge that read the
 * durable fact alone stayed "unverified" for a beat while the panel directly
 * below it reported the handshake had passed — one observation, two answers.
 * Passing the run in makes the two agree, from the same server-provided fact.
 */
export type ConnectionState = 'unconfigured' | 'off' | 'unverified' | 'verified';

export function connectionState(
  instance: InstanceStatus,
  liveRunVerified = false,
): ConnectionState {
  if (!instance.hasConfig) return 'unconfigured';
  if (!instance.enabled) return 'off';
  if (instance.lastVerifiedAt || liveRunVerified) return 'verified';
  return 'unverified';
}

/**
 * A blank instance for the "Add bot" flow.
 *
 * Creating a bot deliberately does **not** happen up front: the user is asked
 * for nothing until they have seen how, and the first save (which needs a name)
 * is what actually creates the row. Until then this is a draft with no id.
 */
export function draftInstance(platform: PlatformStatus): InstanceStatus {
  return {
    id: '',
    platform: platform.id,
    label: '',
    enabled: true,
    connected: false,
    hasConfig: false,
    capabilities: platform.capabilities,
    fields: platform.fields,
    values: {},
    secrets: platform.secrets ?? {},
    agentId: null,
    notifyAgentId: null,
    channels: [],
    lastError: null,
    canListChannels: false,
    lastVerifiedAt: null,
  };
}

/** True while the card has no server row yet (the "Add bot" draft). */
export function isDraft(instance: InstanceStatus): boolean {
  return instance.id === '';
}

// ─── Adapter: instance → the platform view the existing form understands ─────

/**
 * The `PlatformStatus` equivalent of one instance.
 *
 * `PlatformCard` was written against `PlatformStatus`; an instance carries a
 * strict superset of those fields (plus identity and routing). This mapping is
 * the *single* place those two shapes meet — the card is not duplicated, and the
 * card never learns what an instance is.
 */
export function instanceAsPlatform(instance: InstanceStatus): PlatformStatus {
  return {
    id: instance.platform,
    label: instance.label,
    capabilities: instance.capabilities,
    fields: instance.fields,
    defaultEnabled: false,
    enabled: instance.enabled,
    connected: instance.connected,
    hasConfig: instance.hasConfig,
    // The bound agent lives on the instance row; the form reads it through the
    // manifest's agent field (`AGENT_BINDING_FIELD.key === 'agentId'`). Feeding
    // it here is what makes the column and the field ONE fact — otherwise the
    // picker would show blank for a bot that is demonstrably bound.
    values: { ...instance.values, agentId: instance.agentId ?? '' },
    secrets: instance.secrets,
  };
}

/**
 * The payload for the instance's credentials save.
 *
 * Identical rule to the platform save (an untouched secret is omitted so the
 * stored value survives) — delegating keeps one definition of that rule.
 */
export function buildInstancePayload(
  instance: InstanceStatus,
  draft: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  return buildSavePayload(instanceAsPlatform(instance), draft, enabled);
}

/**
 * The payload for a *routing-only* save — the notification target — and nothing
 * else.
 *
 * This is deliberately the **only** key it writes. The previous version replayed
 * the instance's *stored* values, which made routing a second writer of
 * `agentId`: after the user picked a new agent (still unsaved in the credentials
 * draft) and then clicked Save routing, the stale stored `agentId` was written
 * back over the new one. Credentials and the bound agent have exactly one writer
 * (the credential Save); routing owns `notifyAgentId`.
 */
export function buildRoutingPayload(notifyAgentId: string): Record<string, unknown> {
  return { notifyAgentId };
}

// ─── Pure routing helpers ────────────────────────────────────────────────────

/** The binding currently in force for a conversation, if any. */
export function bindingFor(
  bindings: InstanceChannelBinding[],
  nativeId: string,
): InstanceChannelBinding | undefined {
  return bindings.find((b) => b.nativeId === nativeId);
}

/**
 * Bind (or re-bind) one conversation, keeping the list sorted so the payload is
 * stable — a save that changes nothing must not look like a change.
 */
export function setChannelBinding(
  bindings: InstanceChannelBinding[],
  nativeId: string,
  agentId: string,
  kind?: string | null,
): InstanceChannelBinding[] {
  const next = bindings.filter((b) => b.nativeId !== nativeId);
  next.push({ nativeId, kind: kind ?? null, agentId });
  return next.sort((a, b) => a.nativeId.localeCompare(b.nativeId));
}

/** Drop one conversation's binding (the conversation falls back to the bot default). */
export function removeChannelBinding(
  bindings: InstanceChannelBinding[],
  nativeId: string,
): InstanceChannelBinding[] {
  return bindings.filter((b) => b.nativeId !== nativeId);
}

/**
 * A binding whose conversation is no longer advertised by the platform is still
 * shown — dropping it here would silently unbind a group the user set up, which
 * is exactly the kind of quiet data loss this UI must not do.
 */
export function orphanBindings(
  bindings: InstanceChannelBinding[],
  known: PlatformChannel[],
): InstanceChannelBinding[] {
  const knownIds = new Set(known.map((c) => c.id));
  return bindings.filter((b) => !knownIds.has(b.nativeId));
}

/** Case-insensitive filter over a channel's name and id, for the picker search. */
export function filterChannels(known: PlatformChannel[], query: string): PlatformChannel[] {
  const q = query.trim().toLowerCase();
  if (!q) return known;
  return known.filter(
    (c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q),
  );
}

/** Group instances by platform, preserving the server's ordering within a group. */
export function groupByPlatform(
  instances: InstanceStatus[],
): Array<{ platform: string; instances: InstanceStatus[] }> {
  const groups = new Map<string, InstanceStatus[]>();
  for (const instance of instances) {
    const list = groups.get(instance.platform);
    if (list) list.push(instance);
    else groups.set(instance.platform, [instance]);
  }
  return [...groups.entries()].map(([platform, list]) => ({ platform, instances: list }));
}

/**
 * The platform ids the section must show: the manifest catalog (so an unset
 * platform can still get its *first* bot) unioned with every platform that
 * already has an instance — a platform that disappeared from the registry must
 * still be visible and deletable rather than silently hidden.
 */
export function visiblePlatformIds(
  catalog: Array<{ id: string }>,
  instances: InstanceStatus[],
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const platform of catalog) {
    if (seen.has(platform.id)) continue;
    seen.add(platform.id);
    ids.push(platform.id);
  }
  for (const instance of instances) {
    if (seen.has(instance.platform)) continue;
    seen.add(instance.platform);
    ids.push(instance.platform);
  }
  return ids;
}
