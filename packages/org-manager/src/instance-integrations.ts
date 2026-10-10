/**
 * Bot-instance integration store — the read/write path behind
 * `/api/settings/integrations/instances`.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * The platform-manifest programme removed per-platform naming from the
 * *platform* surface (`platform-integrations.ts`), but a platform is not a bot:
 * one Feishu app can host several bots, each with its own credentials, its own
 * answering agent and its own per-chat routes. `platform_instances` (slice G1)
 * is that second level, and this module is its settings-side projection. The
 * same manifest drives both levels, so a new platform still needs zero code
 * here — only `platform-integrations.ts` and this module's two callers.
 *
 * ── Scope: `channel` bindings only ──────────────────────────────────────────
 *
 * {@link setInstanceChannels} owns `scope='channel'` rows and **only** those.
 * The `global` row (the org-wide notification default) and the `instance` row
 * (a platform-level default answerer) are written elsewhere and read by the
 * gateway; managing them here would make this module a second writer that
 * silently deletes routes the UI never showed. Deleting an instance *does*
 * clean up every binding that pointed at it — see {@link deleteInstance}.
 *
 * ── Storage rule: one writer, one place ─────────────────────────────────────
 *
 * A bot's config is exactly one `platform_instances.config` blob, and secrets
 * live in it byte-for-byte as before — the G1 migration copied the legacy
 * `integrations.config` verbatim, so old installs need nothing re-entered.
 * `markus.json` stays read-only here too: it is consulted per *platform*, and
 * only when the row itself has no value, which is the same bootstrap contract
 * `platform-integrations.ts` uses (one rule for both surfaces, so a form cannot
 * mean two different things depending on which one it is rendered from).
 *
 * ── Secret rule ─────────────────────────────────────────────────────────────
 *
 * Identical to the platform store, and deliberately implemented by *delegating*
 * to it: a manifest field marked `secret: true` never leaves this module in
 * plaintext, an empty or {@link SECRET_MASK} submission means "keep the stored
 * value", and required-field validation treats a stored secret as satisfying
 * the field. `missingRequiredFields` / `mergeSubmission` are imported rather
 * than re-derived — two copies of a security rule drift, one does not.
 *
 * See `packages/org-manager/docs/settings-integrations-api.md`.
 */

import { createHash } from 'node:crypto';
import {
  getManifest,
  type PlatformCapabilities,
  type PlatformField,
  type PlatformManifest,
} from '@markus/comms';
import type {
  ChannelBindingRepo,
  ChannelBindingRow,
  PlatformInstanceRepo,
  PlatformInstanceRow,
} from '@markus/storage';
import { SECRET_MASK, mergeSubmission, missingRequiredFields } from './platform-integrations.js';

/** Re-exported so callers of this module need one import, not two. */
export { SECRET_MASK };

/**
 * One `scope='channel'` route of an instance: a native conversation → an agent.
 * Mirrors `ChannelBindingRow` minus the columns the UI has no business seeing
 * (row id, timestamps) — the native id is the identity the client round-trips.
 */
export interface InstanceChannelBinding {
  nativeId: string;
  kind: string | null;
  agentId: string;
}

/** Everything the Settings UI needs to render one bot instance. */
export interface InstanceStatus {
  id: string;
  /** Manifest id of the platform this bot speaks (`feishu`, `telegram`, …). */
  platform: string;
  /** User-chosen instance label, unique within `(org, platform)`. */
  label: string;
  enabled: boolean;
  connected: boolean;
  /**
   * True when the *instance row itself* carries stored config. Deliberately not
   * "a row exists" (always true here, so it would carry no information): with
   * each instance inheriting manifest defaults and the legacy bootstrap, the
   * interesting question is whether anything was ever saved for **this** bot.
   */
  hasConfig: boolean;
  capabilities: PlatformCapabilities;
  /** The platform's manifest fields — the whole form is driven by these. */
  fields: PlatformField[];
  /** Stored non-secret values (manifest fields + preserved extra keys). */
  values: Record<string, unknown>;
  /** Secret fields → presence only; the value never appears. */
  secrets: Record<string, { hasValue: boolean }>;
  /** The bot's default answering agent (`config.agentId`). */
  agentId: string | null;
  /** Notification target for this bot (`config.notifyAgentId`). */
  notifyAgentId: string | null;
  /** `scope='channel'` routes owned by this instance, ordered by native id. */
  channels: InstanceChannelBinding[];
  lastError: string | null;
  /** True when the manifest exposes `listChannels` — drives the channel picker. */
  canListChannels: boolean;
  /**
   * When this bot last passed the two-way handshake, or `null` if it never has.
   *
   * A fact about the bot, not about one pending run, so it survives a reload.
   * The badge reads it: "configured and verified" is a much stronger claim than
   * "our process happens to hold a socket", and only the handshake can make it.
   */
  lastVerifiedAt: string | null;
}

/** Live connection probe: instance id → is this bot connected right now. */
export type InstanceConnectedProbe = (instanceId: string) => boolean;

export interface InstanceStoreDeps {
  orgId: string;
  instances?: PlatformInstanceRepo;
  bindings?: ChannelBindingRepo;
  /** Read-only legacy fallback per platform (markus.json), as in the platform store. */
  bootstrap?: (platform: string) => Record<string, unknown>;
  /**
   * The org's **default** answering agent — the secretary. Resolved here, not
   * hard-coded, because the secretary's id is assigned per org at bootstrap.
   *
   * It is a *default*, not a binding, and it is never seeded into a new
   * instance's stored config: an instance whose `agentId` is empty reads through
   * it, so `agentId` (now a required field) resolves for every bot without the
   * user having to pick one first, while `hasConfig` still means "the org stored
   * something". Persisting it happens only on the first real save
   * (`saveInstance`). Returns `null` when the org has no secretary.
   */
  defaultAgentId?: () => string | null;
  /**
   * Per-**instance** connection state. The platform store's probe is keyed by
   * platform, which cannot distinguish two bots of one platform, so callers
   * resolve the instance's platform themselves (see the API route) and answer
   * per id.
   */
  connected?: InstanceConnectedProbe;
}

/**
 * An instance row whose platform is no longer in the registry. Rare (a platform
 * was removed after a bot was created) but it must not hide the row: the
 * operator still needs to see and delete it, so the form degrades to empty
 * rather than 404ing.
 */
const ORPHAN_CAPABILITIES: PlatformCapabilities = Object.freeze({
  inbound: false,
  outbound: false,
  threads: false,
  cards: false,
});

/**
 * Thrown when a save leaves required manifest fields unsatisfied. Carries the
 * field names so the route can return the same `{ error, missing }` body the
 * platform endpoint does — the rule lives here, the HTTP shape lives there.
 */
export class InstanceValidationError extends Error {
  constructor(readonly missing: string[]) {
    super(`Missing required field(s): ${missing.join(', ')}`);
    this.name = 'InstanceValidationError';
  }
}

// ─── Row access ──────────────────────────────────────────────────────────────

function instanceConfig(instance: PlatformInstanceRow | undefined): Record<string, unknown> {
  const config = instance?.config;
  return config && typeof config === 'object' ? config : {};
}

/**
 * Look up one instance **within this org**. `findById` is not org-scoped — an id
 * is a global primary key — so the org check is re-asserted here rather than
 * trusted: without it, an id leak from one org would expose (and allow edits to)
 * another org's credentials.
 */
function findInstance(deps: InstanceStoreDeps, id: string): PlatformInstanceRow | undefined {
  const repo = deps.instances;
  if (!repo) return undefined;
  const row = repo.findById(id);
  return row && row.orgId === deps.orgId ? row : undefined;
}

function instanceRows(deps: InstanceStoreDeps): PlatformInstanceRow[] {
  const repo = deps.instances;
  if (!repo) return [];
  return repo.listByOrg(deps.orgId) as PlatformInstanceRow[];
}

/**
 * Stable id for a new instance, mirroring storage's `stableGatewayId('bi', …)`
 * (`${prefix}_${first}_${sha1-12}` over the NUL-joined tuple). Matching the G1
 * migration's scheme on purpose: created and migrated rows for the same
 * `(platform, label)` then share one id, so the duplicate check below is a
 * genuine conflict rather than two rows for one bot.
 */
function instanceIdFor(orgId: string, platform: string, label: string): string {
  const hash = createHash('sha1')
    .update([platform, orgId, label].join('\u0000'))
    .digest('hex')
    .slice(0, 12);
  return `bi_${platform}_${hash}`;
}

/** Stable id for a channel-scope binding: `${prefix}_channel_${sha1-12}`. */
function bindingIdFor(orgId: string, instanceId: string, nativeId: string): string {
  const hash = createHash('sha1')
    .update(['channel', orgId, instanceId, nativeId].join('\u0000'))
    .digest('hex')
    .slice(0, 12);
  return `cb_channel_${hash}`;
}

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function channelsFor(deps: InstanceStoreDeps, instanceId: string): InstanceChannelBinding[] {
  const repo = deps.bindings;
  if (!repo) return [];
  return (repo.listByOrg(deps.orgId) as ChannelBindingRow[])
    .filter((row) => row.scope === 'channel' && row.instanceId === instanceId)
    .map((row) => ({ nativeId: row.nativeId ?? '', kind: row.kind, agentId: row.agentId }))
    .sort((a, b) => (a.nativeId < b.nativeId ? -1 : a.nativeId > b.nativeId ? 1 : 0));
}

// ─── Value resolution (DB → bootstrap → manifest default) ────────────────────

/**
 * Resolve an instance's effective values: manifest defaults, overlaid by the
 * legacy bootstrap, overlaid by the **row's own** config. The row always wins.
 *
 * Kept separate from the platform store's `readPlatformValues` because the
 * database layer differs (one instance row vs. one integrations row), not
 * because the precedence differs — a test asserts both layers agree on which
 * source wins, which is what keeps "the platform form" and "the bot form"
 * showing the same value.
 *
 * Non-manifest keys already stored on the row are carried through, so a
 * preference written by an older build (or by a future one) is never silently
 * dropped by a save routed through this module. Keys colliding with a manifest
 * secret name are excluded by construction — extras are computed by removing
 * every manifest field key.
 */
export function readInstanceValues(
  deps: InstanceStoreDeps,
  manifest: PlatformManifest,
  instance: PlatformInstanceRow | undefined,
  options: { withDefaults?: boolean } = {},
): Record<string, unknown> {
  const withDefaults = options.withDefaults ?? true;
  const db = instanceConfig(instance);
  const legacy = deps.bootstrap?.(manifest.id) ?? {};
  const out: Record<string, unknown> = {};

  const consider = (value: unknown, secret: boolean): boolean => {
    if (value === undefined || value === null) return false;
    // An empty secret means "unset" — let an earlier layer (bootstrap/default) win.
    if (secret && typeof value === 'string' && value.trim().length === 0) return false;
    return true;
  };

  for (const field of manifest.fields) {
    if (withDefaults && field.default !== undefined) out[field.key] = field.default;
    const boot = legacy[field.key];
    if (consider(boot, !!field.secret)) out[field.key] = boot;
    const stored = db[field.key];
    if (consider(stored, !!field.secret)) out[field.key] = stored;
  }

  const manifestKeys = new Set(manifest.fields.map((field) => field.key));
  for (const [key, value] of Object.entries(db)) {
    if (manifestKeys.has(key)) continue;
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Resolved, **unmasked** config for one instance — server-side only (the
 * channels probe needs real credentials). Exported so the API route never has to
 * re-derive resolution from the masked status.
 */
export function readInstanceConfig(
  deps: InstanceStoreDeps,
  id: string,
): Record<string, unknown> | undefined {
  const instance = findInstance(deps, id);
  if (!instance) return undefined;
  const manifest = getManifest(instance.platform);
  if (!manifest) return instanceConfig(instance);
  return readInstanceValues(deps, manifest, instance);
}

// ─── Status projection ───────────────────────────────────────────────────────

function buildInstanceStatus(deps: InstanceStoreDeps, instance: PlatformInstanceRow): InstanceStatus {
  const config = instanceConfig(instance);
  const manifest = getManifest(instance.platform);

  if (!manifest) {
    return {
      id: instance.id,
      platform: instance.platform,
      label: instance.label,
      enabled: instance.enabled,
      connected: false,
      hasConfig: Object.keys(config).length > 0,
      capabilities: ORPHAN_CAPABILITIES,
      fields: [],
      values: {},
      secrets: {},
      agentId: trimmed(config['agentId']),
      notifyAgentId: trimmed(config['notifyAgentId']),
      channels: channelsFor(deps, instance.id),
      lastError: instance.lastError,
      canListChannels: false,
      lastVerifiedAt: instance.lastVerifiedAt,
    };
  }

  // Same split as `buildPlatformStatus`: a field is a secret iff the *manifest*
  // says so, so the two surfaces cannot disagree about what is sensitive.
  const values = readInstanceValues(deps, manifest, instance);
  const exposed: Record<string, unknown> = {};
  const secrets: Record<string, { hasValue: boolean }> = {};
  const secretKeys = new Set(manifest.fields.filter((field) => field.secret).map((field) => field.key));

  for (const [key, value] of Object.entries(values)) {
    if (secretKeys.has(key)) {
      secrets[key] = { hasValue: typeof value === 'string' ? value.length > 0 : true };
    } else {
      exposed[key] = value;
    }
  }
  // A secret field with no value still needs a presence entry, so a client can
  // render "not set" without having to guess from the manifest.
  for (const key of secretKeys) {
    if (!(key in secrets)) secrets[key] = { hasValue: false };
  }

  return {
    id: instance.id,
    platform: instance.platform,
    label: instance.label,
    enabled: instance.enabled,
    connected: deps.connected?.(instance.id) ?? false,
    hasConfig: Object.keys(config).length > 0,
    capabilities: manifest.capabilities,
    fields: manifest.fields,
    values: exposed,
    secrets,
    // Read through the resolved view, so the form shows the agent that would
    // actually answer — a per-instance binding, one inherited from the legacy
    // bootstrap, or (failing both) the org secretary, which is the default the
    // instance was created with.
    agentId: trimmed(values['agentId']) ?? deps.defaultAgentId?.() ?? null,
    notifyAgentId: trimmed(values['notifyAgentId']),
    channels: channelsFor(deps, instance.id),
    lastError: instance.lastError,
    canListChannels: manifest.listChannels !== undefined,
    lastVerifiedAt: instance.lastVerifiedAt,
  };
}

/** Every bot in the org, ordered by `(platform, label, id)` for a stable list. */
export function listInstanceStatuses(deps: InstanceStoreDeps): InstanceStatus[] {
  return instanceRows(deps)
    .slice()
    .sort((a, b) => {
      const byPlatform = a.platform.localeCompare(b.platform);
      if (byPlatform !== 0) return byPlatform;
      const byLabel = a.label.localeCompare(b.label);
      if (byLabel !== 0) return byLabel;
      return a.id.localeCompare(b.id);
    })
    .map((row) => buildInstanceStatus(deps, row));
}

/** One bot; `undefined` when the id is unknown **or belongs to another org**. */
export function getInstanceStatus(deps: InstanceStoreDeps, id: string): InstanceStatus | undefined {
  const instance = findInstance(deps, id);
  return instance ? buildInstanceStatus(deps, instance) : undefined;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

/**
 * Create one bot of a platform.
 *
 * New instances start **enabled**: the row only exists because a user asked for
 * this bot, and startup skips a row whose required fields do not resolve
 * (`isManifestEnabled`), so "enabled" cannot connect a half-configured bot —
 * it only means the user has not switched it off.
 *
 * Throws (rather than returning a sentinel) for every rejection, because each
 * one maps to a different status code: unknown platform → 404, duplicate →
 * 409, missing storage → 501.
 */
export async function createInstance(
  deps: InstanceStoreDeps,
  input: { platform: string; label: string },
): Promise<InstanceStatus> {
  const repo = deps.instances;
  if (!repo) throw new Error('Storage not available');

  const platform = (input.platform ?? '').trim();
  const label = (input.label ?? '').trim();
  if (!platform || !label) throw new Error('platform and label are required');

  const manifest = getManifest(platform);
  if (!manifest) throw new Error(`Unknown platform: "${platform}"`);

  // Checked against the real rows rather than trusted to the unique index: the
  // index would throw an opaque constraint error, and the route must answer 409
  // with a message that says which label collided.
  const duplicate = (repo.listByPlatform(deps.orgId, platform) as PlatformInstanceRow[]).find(
    (row) => row.label === label,
  );
  if (duplicate) {
    throw new Error(`A ${manifest.label} instance labelled "${label}" already exists`);
  }

  // The row starts with **no config** — in particular the org's default agent
  // (the secretary) is deliberately NOT written here. `agentId` is a *routing*
  // key, not a credential, so storing it would flip `hasConfig` to true at
  // birth; the page reads `hasConfig` as "credentials configured" (it would
  // offer a Disconnect on a bot with nothing to disconnect, and hide the
  // recommended scan-to-create path). The default is instead read *through*
  // `buildInstanceStatus` and materialised only on the first real save
  // (`saveInstance`), which keeps `hasConfig` meaning "the org stored
  // something" and keeps the required field satisfiable without persisting a
  // binding the user never chose.
  const row = await repo.create({
    id: instanceIdFor(deps.orgId, platform, label),
    orgId: deps.orgId,
    platform,
    label,
    config: {},
    enabled: true,
  });
  return buildInstanceStatus(deps, row);
}

/**
 * Merge a submission into one instance's config and persist it.
 *
 * Only manifest field keys are written, plus the two routing keys: `agentId`
 * (a manifest field on every platform, but written explicitly so a manifest
 * that ever drops `AGENT_BINDING_FIELD` still binds an agent) and `notifyAgentId`
 * (a notification preference, not a manifest field, so it would otherwise be
 * dropped). `''` clears either one. Everything else already
 * on the row — including non-manifest keys — survives untouched.
 *
 * The merge starts from the *resolved* values, exactly as `savePlatform` does,
 * so a bot of a legacy install keeps the credentials it was already reading
 * instead of freezing into "unset".
 */
export async function saveInstance(
  deps: InstanceStoreDeps,
  id: string,
  submitted: Record<string, unknown>,
  enabled?: boolean,
): Promise<InstanceStatus> {
  const repo = deps.instances;
  if (!repo) throw new Error('Storage not available');

  const instance = findInstance(deps, id);
  if (!instance) throw new Error(`Instance not found: "${id}"`);
  const manifest = getManifest(instance.platform);
  if (!manifest) throw new Error(`Unknown platform: "${instance.platform}"`);

  const existing = readInstanceValues(deps, manifest, instance);
  // A bot that predates the required agent field, or any bot whose row has an
  // empty `agentId`, is treated here as already holding the org default. That
  // keeps the new required field from locking an existing install out of its
  // own settings, and makes the first save of any kind materialise the binding
  // (the merge base is `existing`).
  if (!trimmed(existing['agentId'])) {
    const fallback = deps.defaultAgentId?.() ?? null;
    if (fallback) existing['agentId'] = fallback;
  }
  const missing = missingRequiredFields(manifest, submitted, existing);
  if (missing.length > 0) throw new InstanceValidationError(missing);

  const merged = mergeSubmission(manifest, submitted, existing);
  applyRoutingKey(merged, submitted, 'agentId');
  applyRoutingKey(merged, submitted, 'notifyAgentId');

  await repo.update(instance.id, {
    config: merged,
    enabled: enabled ?? instance.enabled,
  });
  return getInstanceStatus(deps, instance.id)!;
}

/** Write or clear one string routing key (`agentId` / `notifyAgentId`). */
function applyRoutingKey(
  target: Record<string, unknown>,
  submitted: Record<string, unknown>,
  key: string,
): void {
  if (!(key in submitted)) return; // absent ⇒ leave whatever is stored
  const value = trimmed(submitted[key]);
  if (value) target[key] = value;
  else delete target[key]; // '' (or null) clears the binding
}

/**
 * Delete one bot, plus every binding that pointed at it.
 *
 * Cascade is deliberate: a binding whose `instance_id` no longer resolves is
 * already unreachable (`RepoBindingLookup` drops it), so leaving the rows would
 * be a silent leak that grows with every delete. `global` rows are untouched —
 * they have no instance, and they are the org's fallback route.
 *
 * `false` (not a throw) when the id is unknown: "already gone" is the desired
 * end state, and the route answers 404 either way.
 */
export async function deleteInstance(deps: InstanceStoreDeps, id: string): Promise<boolean> {
  const repo = deps.instances;
  if (!repo) return false;
  const instance = findInstance(deps, id);
  if (!instance) return false;

  const bindings = deps.bindings;
  if (bindings) {
    for (const row of bindings.listByOrg(deps.orgId) as ChannelBindingRow[]) {
      if (row.instanceId === id) await bindings.delete(row.id);
    }
  }
  await repo.delete(id);
  return true;
}

/**
 * Replace **this instance's** channel routes wholesale.
 *
 * Replace-all (delete then create) rather than a diff: the submitted list *is*
 * the desired state, and a diff would need stable per-row identity the client
 * does not have. Scoped strictly to `scope='channel'` rows of this instance —
 * see the module header for why the other scopes are off limits here.
 *
 * Duplicate native ids collapse (last one wins): the table's unique key is
 * `(org, scope, instance, native)`, so two entries for one chat would abort the
 * whole save on a constraint error instead of resolving to a single route.
 */
export async function setInstanceChannels(
  deps: InstanceStoreDeps,
  id: string,
  channels: InstanceChannelBinding[],
): Promise<InstanceStatus> {
  const instances = deps.instances;
  const bindings = deps.bindings;
  if (!instances || !bindings) throw new Error('Storage not available');

  const instance = findInstance(deps, id);
  if (!instance) throw new Error(`Instance not found: "${id}"`);

  for (const row of bindings.listByOrg(deps.orgId) as ChannelBindingRow[]) {
    if (row.scope === 'channel' && row.instanceId === id) await bindings.delete(row.id);
  }

  const byNativeId = new Map<string, InstanceChannelBinding>();
  for (const entry of channels ?? []) {
    const nativeId = (entry?.nativeId ?? '').trim();
    if (!nativeId) continue; // validated at the route; skipped here so a save can never half-apply
    byNativeId.set(nativeId, { nativeId, kind: entry.kind ?? null, agentId: entry.agentId });
  }

  for (const entry of byNativeId.values()) {
    await bindings.create({
      id: bindingIdFor(deps.orgId, id, entry.nativeId),
      orgId: deps.orgId,
      scope: 'channel',
      instanceId: id,
      nativeId: entry.nativeId,
      kind: entry.kind,
      agentId: entry.agentId,
    });
  }

  return getInstanceStatus(deps, id)!;
}

// ─── Connection testing ──────────────────────────────────────────────────────

/**
 * Where a "Save & test" prompt should be posted for an instance, derived from
 * the routes the operator already configured.
 *
 * Precedence: a channel marked `notification` (that is the conversation the
 * operator *designated* as the outbound destination, so it is the one they
 * expect the bot to be able to post into), then any bound channel. Returns
 * `null` when the instance has no routes yet — a valid answer, not a failure:
 * the gateway then starts the verification inbound-first (the user messages the
 * bot, and our acknowledgement proves the outbound leg).
 *
 * Lives here, not in the route, because "which conversation does this bot own?"
 * is instance knowledge — the route only knows how to ask.
 */
export function defaultTestTarget(
  instance: InstanceStatus,
): { channelId: string; name?: string | null } | null {
  const notification = instance.channels.find((c) => c.kind === 'notification');
  const chosen = notification ?? instance.channels[0];
  return chosen ? { channelId: chosen.nativeId, name: null } : null;
}

/**
 * Remember that a bot passed the two-way handshake.
 *
 * Called from the gateway when a verification completes, never from the UI: the
 * proof arrives out of band (the user's reply comes in over IM, through the
 * inbound path), so the gateway is the only component that actually observes
 * it. Writing it here keeps that single observation as the single writer of the
 * fact — the Settings page only reads it back.
 *
 * Best-effort by design: this is a record of something that already happened,
 * so a storage hiccup must not fail the verification the user just completed.
 */
export async function recordInstanceVerification(
  deps: InstanceStoreDeps,
  id: string,
  at: string,
): Promise<void> {
  const repo = deps.instances;
  if (!repo) return;
  await repo.update(id, { lastVerifiedAt: at });
}
