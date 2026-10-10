/**
 * Platform integration store — the single read/write path behind
 * `/api/settings/integrations`.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * Before the platform-manifest programme (issue #340) the Settings API named one
 * platform in every handler: the path, the config shape, the storage call. This
 * module is the piece that removes the naming — it is driven entirely by
 * `PLATFORM_MANIFESTS`, so every handler above it works for *any* registered
 * platform and adding one stays a single additive registry entry.
 *
 * ── Storage rule: one writer, one place ─────────────────────────────────────
 *
 * A platform's config is one `integrations` row per `(orgId, platform)`
 * (`IntegrationRepo`), every field — secrets included — stored under `config`.
 * `markus.json` is **read-only here**, consulted only as a bootstrap default
 * when the database has no value (see `PlatformStoreDeps.bootstrap`). That is
 * what makes this change transparent to installs whose credentials still live in
 * `markus.json`: nothing is lost and nothing has to be re-entered.
 *
 * ── Secret rule ─────────────────────────────────────────────────────────────
 *
 * Fields the manifest marks `secret: true` are never produced in plaintext by
 * this module. `PlatformStatus.secrets` carries presence only, and
 * `flattenStatus()` substitutes `SECRET_MASK`. A submitted secret equal to `''`
 * or the mask is treated as "leave unchanged", so a form that round-trips the
 * masked value cannot overwrite the real secret.
 *
 * See `packages/org-manager/docs/settings-integrations-api.md`.
 */

import {
  getManifest,
  PLATFORM_MANIFESTS,
  type PlatformCapabilities,
  type PlatformField,
  type PlatformManifest,
} from '@markus/comms';
import type { IntegrationRepo, IntegrationRow } from '@markus/storage';

/** Placeholder returned in place of a configured secret. */
export const SECRET_MASK = '••••';

/** Presence flag for one secret field — never the value itself. */
export interface PlatformSecretState {
  hasValue: boolean;
}

/** Everything the Settings API needs to describe one platform. */
export interface PlatformStatus {
  id: string;
  label: string;
  docsUrl?: string;
  capabilities: PlatformCapabilities;
  fields: PlatformField[];
  defaultEnabled: boolean;
  enabled: boolean;
  connected: boolean;
  hasConfig: boolean;
  /** Stored non-secret values (manifest fields + preserved legacy keys). */
  values: Record<string, unknown>;
  /** Secret fields → presence only. */
  secrets: Record<string, PlatformSecretState>;
}

export interface PlatformStoreDeps {
  repo?: IntegrationRepo;
  orgId: string;
  /**
   * Read-only legacy fallback per platform (e.g. the old `markus.json`
   * `integrations.feishu` block). Consulted **only** when the database holds no
   * value for the field, so existing installs keep working unchanged.
   */
  bootstrap?: (platform: string) => Record<string, unknown>;
  /**
   * The org's **default** answering agent (the secretary), resolved per org —
   * never hard-coded, because the id is assigned at bootstrap.
   *
   * `agentId` is a required manifest field, so a platform save that carries no
   * agent would be rejected and an existing install could be locked out of its
   * own settings. Treating the default as the already-stored value lets the
   * first save materialise the binding instead.
   */
  defaultAgentId?: () => string | null;
  /** Live connection state per platform, supplied by the messaging gateway. */
  connected?: (platform: string) => boolean;
}

/** True when `id` is a registered platform (i.e. has a manifest). */
export function isKnownPlatform(id: string): boolean {
  return getManifest(id) !== undefined;
}

/** Registered platforms, in registry (display) order. */
export function listPlatforms(): readonly PlatformManifest[] {
  return PLATFORM_MANIFESTS;
}

/** The id → manifest list used when validating a `:platform` path segment. */
export function knownPlatformIds(): string[] {
  return PLATFORM_MANIFESTS.map((manifest) => manifest.id);
}

function rowFor(deps: PlatformStoreDeps, platform: string): IntegrationRow | undefined {
  const repo = deps.repo;
  if (!repo) return undefined;
  const rows = repo.listByPlatform(deps.orgId, platform) as IntegrationRow[];
  return rows[0];
}

function rowConfig(row: IntegrationRow | undefined): Record<string, unknown> {
  const cfg = row?.['config'];
  return cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {};
}

/**
 * Resolve a platform's effective values: manifest defaults, overlaid by the
 * legacy bootstrap, overlaid by the database. The database always wins, so once
 * a value is saved here the bootstrap is dead weight (by design).
 *
 * Non-manifest keys already stored under `config` are carried through so the
 * generic API does not silently drop runtime preferences written by an older
 * build. Anything colliding with a manifest secret name is excluded by
 * construction — extras are computed by removing every manifest field key.
 */
export function readPlatformValues(
  deps: PlatformStoreDeps,
  manifest: PlatformManifest,
  options: { withDefaults?: boolean } = {},
): Record<string, unknown> {
  const withDefaults = options.withDefaults ?? true;
  const db = rowConfig(rowFor(deps, manifest.id));
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

/** Build the status view for one manifest from resolved values. */
/**
 * Stored config for a platform as startup needs it: the values persisted in the
 * `integrations` row (legacy bootstrap excluded — the config file is read
 * separately, and the database wins anyway) plus the row's `enabled` flag.
 */
export interface StoredPlatformConfig {
  values: Record<string, unknown>;
  /** Row `enabled` flag; `undefined` when the platform has no stored row. */
  enabled?: boolean;
}

/**
 * Read a platform's persisted config for the startup traversal. Deliberately
 * **omits manifest defaults** (`withDefaults: false`): a `field.default` is the
 * settings *form* starting value, and applying it here would silently switch on
 * a platform that declares no required field. The Settings API writes here, so
 * reading here is what makes "configured in the UI" and "connected at boot"
 * the same thing.
 */
export function readStoredPlatformConfig(
  deps: Omit<PlatformStoreDeps, 'bootstrap' | 'connected'>,
  manifest: PlatformManifest,
): StoredPlatformConfig {
  const row = rowFor(deps, manifest.id);
  return {
    values: readPlatformValues(deps, manifest, { withDefaults: false }),
    enabled: row ? row.enabled : undefined,
  };
}

export function buildPlatformStatus(
  deps: PlatformStoreDeps,
  manifest: PlatformManifest,
): PlatformStatus {
  const row = rowFor(deps, manifest.id);
  const values = readPlatformValues(deps, manifest);

  const exposed: Record<string, unknown> = {};
  const secrets: Record<string, PlatformSecretState> = {};
  const secretKeys = new Set(manifest.fields.filter((f) => f.secret).map((f) => f.key));

  for (const [key, value] of Object.entries(values)) {
    if (secretKeys.has(key)) {
      secrets[key] = { hasValue: typeof value === 'string' ? value.length > 0 : true };
    } else {
      exposed[key] = value;
    }
  }
  // Secret fields that carry no value still need a presence entry, so a client
  // can render "not set" without guessing the manifest.
  for (const key of secretKeys) {
    if (!(key in secrets)) secrets[key] = { hasValue: false };
  }

  return {
    id: manifest.id,
    label: manifest.label,
    docsUrl: manifest.docsUrl,
    capabilities: manifest.capabilities,
    fields: manifest.fields,
    defaultEnabled: manifest.defaultEnabled ?? false,
    enabled: row ? !!row.enabled : (manifest.defaultEnabled ?? false),
    connected: deps.connected?.(manifest.id) ?? false,
    hasConfig: row !== undefined,
    values: exposed,
    secrets,
  };
}

/** Status for every registered platform, in registry order. */
export function listPlatformStatuses(deps: PlatformStoreDeps): PlatformStatus[] {
  return PLATFORM_MANIFESTS.map((manifest) => buildPlatformStatus(deps, manifest));
}

/** Status for one platform; `undefined` when the id is unknown. */
export function getPlatformStatus(deps: PlatformStoreDeps, id: string): PlatformStatus | undefined {
  const manifest = getManifest(id);
  return manifest ? buildPlatformStatus(deps, manifest) : undefined;
}

/**
 * `GET /api/settings/integrations/:platform` body: the status object with the
 * non-secret values flattened onto the top level and each secret replaced by the
 * mask. The flattening keeps callers written against the pre-manifest shape
 * (`body.appId`, `body.notifyChatId`, …) working.
 */
export function flattenStatus(status: PlatformStatus): Record<string, unknown> {
  const flat: Record<string, unknown> = {
    id: status.id,
    label: status.label,
    docsUrl: status.docsUrl,
    capabilities: status.capabilities,
    fields: status.fields,
    defaultEnabled: status.defaultEnabled,
    enabled: status.enabled,
    connected: status.connected,
    hasConfig: status.hasConfig,
    values: status.values,
    secrets: status.secrets,
  };
  for (const [key, value] of Object.entries(status.values)) flat[key] = value;
  for (const key of Object.keys(status.secrets)) {
    flat[key] = status.secrets[key].hasValue ? SECRET_MASK : '';
  }
  return flat;
}

/** Coerce a submitted value to the manifest field's declared type. */
function coerce(field: PlatformField, raw: unknown): unknown {
  switch (field.type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return Number.isFinite(n) ? n : raw;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).trim().toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      return Boolean(raw);
    }
    case 'select': {
      // A set-valued select (e.g. notification priorities) stores a string[];
      // coerce a scalar or comma-joined string into an array so a hand-rolled
      // client cannot corrupt the shape.
      if (field.multiple) {
        const list = Array.isArray(raw)
          ? raw
          : String(raw ?? '').split(',');
        const allowed = field.options ? new Set(field.options.map((o) => o.value)) : undefined;
        const values = list
          .map((v) => String(v).trim())
          .filter((v) => v.length > 0 && (!allowed || allowed.has(v)));
        // De-duplicate while preserving order.
        return [...new Set(values)];
      }
      return typeof raw === 'string' ? raw : String(raw);
    }
    default:
      return typeof raw === 'string' ? raw : String(raw);
  }
}

/** True when a submitted secret should be read as "leave the stored value". */
function isSecretUnchanged(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const s = typeof value === 'string' ? value.trim() : String(value);
  return s === '' || s === SECRET_MASK;
}

/**
 * Required manifest fields with no value in the submission and none stored.
 * Secret fields are satisfied by a stored value, which is why a re-save that
 * round-trips the mask does not fail validation.
 */
export function missingRequiredFields(
  manifest: PlatformManifest,
  submitted: Record<string, unknown>,
  existing: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const field of manifest.fields) {
    if (!field.required) continue;
    const incoming = submitted[field.key];
    if (field.secret) {
      if (isSecretUnchanged(incoming)) {
        const stored = existing[field.key];
        if (!(typeof stored === 'string' && stored.length > 0) && stored === undefined) missing.push(field.key);
        else if (stored === undefined || stored === null || (typeof stored === 'string' && stored.length === 0)) {
          missing.push(field.key);
        }
      }
      continue;
    }
    if (incoming === undefined || incoming === null) {
      // Nothing submitted: a value already stored satisfies the field. Without
      // this, a *partial* save (the routing save that only writes
      // `notifyAgentId`) would 400 on every other required field, and a field
      // that became required after a row already existed — `agentId` — would
      // lock a working install out of its own settings.
      if (hasUsableValue(existing[field.key])) continue;
      missing.push(field.key);
      continue;
    }
    if (typeof incoming === 'string' && incoming.trim() === '') {
      if (hasUsableValue(existing[field.key])) continue;
      missing.push(field.key);
    }
  }
  return missing;
}

/** Whether a stored value is present and non-blank (a `0`/`false` still counts). */
function hasUsableValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  return !(typeof value === 'string' && value.trim() === '');
}

/**
 * Merge a submission into the stored config. Only manifest fields are written;
 * pre-existing non-manifest keys are preserved so nothing silently disappears.
 * A masked/empty secret keeps the stored value.
 */
export function mergeSubmission(
  manifest: PlatformManifest,
  submitted: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  for (const field of manifest.fields) {
    if (!(field.key in submitted)) continue;
    const raw = submitted[field.key];
    if (field.secret && isSecretUnchanged(raw)) continue;
    if (raw === undefined || raw === null) continue;
    next[field.key] = coerce(field, raw);
  }
  return next;
}

/**
 * Persist a submission. Returns the refreshed status **and** the raw stored
 * config — the latter so a caller can push the resolved values into a live
 * runtime (the status deliberately masks secrets). Throws with no storage.
 */
/**
 * The stored values a save merges onto — with the org default materialised for a
 * required field the org has never set.
 *
 * `agentId` is required, but an install may predate that (or simply never picked
 * a bot). Treating the org default as the stored value keeps the required field
 * from blocking a save and makes the binding materialise on first write.
 *
 * Validation (the API handler) and the write (`savePlatform`) both read through
 * here, so the rule has exactly one definition.
 */
export function readPlatformValuesForSave(
  deps: PlatformStoreDeps,
  manifest: PlatformManifest,
): Record<string, unknown> {
  const values = readPlatformValues(deps, manifest);
  if (manifest.fields.some((f) => f.key === 'agentId') && !values['agentId']) {
    const fallback = deps.defaultAgentId?.() ?? null;
    if (fallback) values['agentId'] = fallback;
  }
  return values;
}

export async function savePlatform(
  deps: PlatformStoreDeps,
  manifest: PlatformManifest,
  submitted: Record<string, unknown>,
  enabled?: boolean,
): Promise<{ status: PlatformStatus; config: Record<string, unknown> }> {
  const repo = deps.repo;
  if (!repo) throw new Error('Storage not available');

  const existingRow = rowFor(deps, manifest.id);
  // Read through the save view so a required field with no stored value falls
  // back to the org default (see `readPlatformValuesForSave`).
  const existingValues = readPlatformValuesForSave(deps, manifest);
  const mergedConfig = mergeSubmission(manifest, submitted, existingValues);
  const nextEnabled =
    enabled ?? (existingRow ? !!existingRow.enabled : (manifest.defaultEnabled ?? false));

  const payload: Record<string, unknown> = {
    id: existingRow?.id ?? `${manifest.id}_default`,
    orgId: deps.orgId,
    platform: manifest.id,
    displayName: manifest.label,
    enabled: nextEnabled,
    config: mergedConfig,
    forwardRules: (existingRow?.['forwardRules'] as unknown[]) ?? [],
  };

  if (existingRow) await repo.update(existingRow.id, payload);
  else await repo.create(payload);

  return { status: buildPlatformStatus(deps, manifest), config: mergedConfig };
}

/** Remove a platform's stored config. No-op when nothing is stored. */
export async function deletePlatform(deps: PlatformStoreDeps, platform: string): Promise<void> {
  const repo = deps.repo;
  if (!repo) return;
  const row = rowFor(deps, platform);
  if (row) await repo.delete(row.id);
}

/** A platform→agent binding read back from persisted config. */
export interface PlatformBinding {
  platform: string;
  agentId: string;
}

/**
 * Read the persisted agent bindings for every registered platform.
 *
 * This is the single source of startup routing: each platform's `agentId` lives
 * in its `integrations` row `config` (the manifest declares the field of the
 * same name), so the router's bindings are derived from exactly one place.
 * Platforms with nothing bound are simply absent — no platform is special-cased.
 */
export function loadPlatformBindings(deps: PlatformStoreDeps): PlatformBinding[] {
  const bindings: PlatformBinding[] = [];
  for (const manifest of PLATFORM_MANIFESTS) {
    const values = readPlatformValues(deps, manifest);
    const raw = values['agentId'];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      bindings.push({ platform: manifest.id, agentId: raw.trim() });
    }
  }
  return bindings;
}
