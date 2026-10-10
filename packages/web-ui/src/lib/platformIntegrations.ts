/**
 * Platform-integration types + pure form logic for the manifest-driven
 * Settings UI (slice S4 of the platform-manifest programme, issue #340).
 *
 * Why this module
 * ───────────────
 * `PlatformCard` renders a configuration form for *whatever* manifest the API
 * returns. The two rules that must hold for every platform — "a required field
 * is enforced" and "an untouched secret is never overwritten" — are pure
 * functions of the manifest + the draft, so they live here as testable logic
 * instead of being tangled into JSX. The component is then a thin renderer, and
 * the rules can be reasoned about (and tested) without a DOM.
 *
 * The DTO shapes mirror the server:
 *   - `PlatformStatus`    ← packages/org-manager/src/platform-integrations.ts
 *   - `PlatformField`     ← packages/comms/src/platforms/registry.ts
 */

import type { ReactNode } from 'react';

// ─── Wire types ──────────────────────────────────────────────────────────────

export type PlatformFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'agent';

export interface PlatformFieldOption {
  value: string;
  label: string;
}

export interface PlatformField {
  /** Stable config key, e.g. `appSecret`. */
  key: string;
  label: string;
  type: PlatformFieldType;
  required: boolean;
  /** Never round-trip the value to a client. Implies `type: 'password'`. */
  secret?: boolean;
  placeholder?: string;
  /** One-line guidance rendered under the input. */
  help?: string;
  /** Choices for `type: 'select'`. */
  options?: PlatformFieldOption[];
  /** `select` accepting a set — the value is a `string[]`. */
  multiple?: boolean;
  /** Value the form starts from when nothing is stored yet. */
  default?: string | number | boolean | string[];
}

export interface PlatformCapabilities {
  inbound: boolean;
  outbound: boolean;
  threads: boolean;
  cards?: boolean;
}

/** Presence flag for one secret field — the value itself never arrives. */
export interface PlatformSecretState {
  hasValue: boolean;
}

/** Everything the Settings UI needs to render one platform's card. */
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
  /** Stored non-secret values, keyed by manifest field. */
  values: Record<string, unknown>;
  /** Secret fields → presence only. */
  secrets: Record<string, PlatformSecretState>;
}

/** `GET /api/settings/integrations`. */
export interface PlatformListResponse {
  platforms: PlatformStatus[];
}

/** `POST /api/settings/integrations/:platform/test`. */
export interface TestConnectionResponse {
  ok?: boolean;
  success?: boolean;
  message?: string;
  error?: string;
  /** Structural verdict from the server, e.g. `network_unreachable`. */
  code?: string;
}

/** The 5 generic, manifest-driven endpoints (see S3 docs). */
export const INTEGRATIONS_PATH = '/settings/integrations';

// ─── Extras slot ─────────────────────────────────────────────────────────────

/**
 * Context handed to a platform's own extras panel.
 *
 * The extras panel edits the *same draft* the card saves — it never persists on
 * its own — so a field keeps exactly one writer (`buildSavePayload`).
 */
export interface PlatformExtrasContext {
  /** The platform's id (e.g. `feishu`). */
  platformId: string;
  /** The platform's status: manifest fields, secret presence, connection state. */
  status: PlatformStatus;
  /** The card's current draft, keyed by manifest field key. */
  values: Record<string, unknown>;
  /** Write one draft value. The card's Save persists it. */
  setValue: (key: string, value: unknown) => void;
  /** Re-read the platform from the server (e.g. after scan-to-register). */
  reload: () => void | Promise<void>;
}

/**
 * A platform's opt-in extras panel. The manifest is pure data sent over HTTP,
 * so it cannot carry a render function; this is where a platform plugs in the
 * capability a generic form cannot express (QR registration, chat picker, …).
 */
export interface PlatformExtras {
  /**
   * Manifest field keys this panel renders itself. The generic form omits them,
   * which is what keeps "one writer per field" true even for rich widgets.
   */
  ownedFields?: string[];
  /**
   * Where the panel sits inside the card. Default `'after'` (below the generic
   * form). `'before'` lifts a guided panel — e.g. Feishu's scan-to-create — to
   * the top, above the manual credentials, so the recommended path is seen
   * first.
   */
  placement?: 'before' | 'after';
  /** The panel. */
  render: (ctx: PlatformExtrasContext) => ReactNode;
}

// ─── Pure form logic ─────────────────────────────────────────────────────────

/** A blank draft value for one field, before any stored value is applied. */
export function blankValue(field: PlatformField): unknown {
  if (field.type === 'boolean') return field.default === true;
  if (field.multiple) return Array.isArray(field.default) ? [...field.default] : [];
  if (field.default !== undefined) return field.default;
  return '';
}

/** True when `value` is "no value supplied" for the field's type. */
export function isFieldEmpty(field: PlatformField, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (field.type === 'boolean') return false; // a boolean is never "empty"
  if (field.multiple) return !Array.isArray(value) || value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/**
 * Build the initial draft for a platform: stored non-secret values win, then
 * the manifest default, then blank. Secret fields start **empty** — the server
 * never sends their value, and empty means "leave unchanged".
 */
export function initialDraft(status: PlatformStatus): Record<string, unknown> {
  const draft: Record<string, unknown> = {};
  for (const field of status.fields) {
    if (field.secret) {
      draft[field.key] = '';
      continue;
    }
    const stored = status.values[field.key];
    draft[field.key] = stored !== undefined && stored !== null ? stored : blankValue(field);
  }
  return draft;
}

/**
 * Required fields the draft leaves unsatisfied. A required **secret** field is
 * satisfied either by a new value in the draft or by one already stored
 * (`secrets[key].hasValue`) — which is what lets a re-save that never touches
 * the masked input still pass.
 */
export function missingRequired(
  fields: PlatformField[],
  draft: Record<string, unknown>,
  secrets: Record<string, PlatformSecretState> = {},
): string[] {
  const missing: string[] = [];
  for (const field of fields) {
    if (!field.required) continue;
    if (field.secret) {
      if (!isFieldEmpty(field, draft[field.key])) continue;
      if (!secrets[field.key]?.hasValue) missing.push(field.key);
      continue;
    }
    if (isFieldEmpty(field, draft[field.key])) missing.push(field.key);
  }
  return missing;
}

/**
 * The payload for `POST /api/settings/integrations/:platform`.
 *
 * - Every manifest field is sent, except a **secret** the user left untouched
 *   (empty), which is omitted so the stored value survives — round-tripping the
 *   placeholder can never overwrite a real secret.
 * - `enabled` is included so the enable toggle saves with the same request.
 */
export function buildSavePayload(
  status: PlatformStatus,
  draft: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { enabled };
  for (const field of status.fields) {
    const value = draft[field.key];
    if (field.secret) {
      if (isFieldEmpty(field, value)) continue; // untouched → keep stored
      payload[field.key] = value;
      continue;
    }
    if (value === undefined) continue;
    payload[field.key] = value;
  }
  return payload;
}

// ─── Field tiers ─────────────────────────────────────────────────────────────

/**
 * The fields the user must see the moment the card opens: the ones the platform
 * cannot work without, plus the agent binding (which decides *who answers*, the
 * first thing anyone opens the page for).
 *
 * The tier is derived from the manifest — `required` and the field *type* — and
 * never from a field's name or the platform's id, so this stays a property of
 * "how a platform config behaves" rather than a per-platform branch.
 */
export function primaryFields(fields: PlatformField[]): PlatformField[] {
  return fields.filter((field) => field.required || field.type === 'agent');
}

/**
 * Everything else — the optional and transport knobs (webhook URLs and ports,
 * signature keys, API-domain overrides, …).
 *
 * These used to sit in their own always-visible accordion, which buried the two
 * boxes that actually matter under a wall of server plumbing. They are folded
 * behind one "More settings" disclosure instead: the defaults are the right
 * answer for essentially every user, and nothing here has to be understood to
 * get a bot working.
 */
export function secondaryFields(fields: PlatformField[]): PlatformField[] {
  return fields.filter((field) => !(field.required || field.type === 'agent'));
}

// ─── Draft identity ──────────────────────────────────────────────────────────

/**
 * Deterministic JSON with sorted object keys, so a fingerprint is stable across
 * renders regardless of key insertion order.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A **content** key for everything `initialDraft` / `enabled` read from a
 * status — the identity a form reset must key on.
 *
 * The card has to reload its draft when the *stored data* changes (a re-read
 * after a save), but NOT when the status object merely gets a new reference,
 * which happens on *every* parent re-render. Depending on the object reference
 * therefore wiped an in-progress draft: the user picked an agent, the card
 * re-rendered for an unrelated reason (typing elsewhere, a channel list
 * arriving) and the choice silently reverted to the stored value.
 *
 * Only the fields the draft is built from take part, so a change that cannot
 * affect the draft — `connected` flipping, or a routing-only key such as
 * `notifyAgentId` — never resets it.
 */
export function statusFingerprint(status: PlatformStatus): string {
  return stableStringify({
    id: status.id,
    enabled: status.enabled,
    fields: status.fields.map((field) => ({
      key: field.key,
      type: field.type,
      required: field.required,
      secret: field.secret === true,
      multiple: field.multiple === true,
      default: field.default ?? null,
      // A secret's value never reaches the client; its *presence* is what
      // changes after a save, so that is what the fingerprint tracks.
      value: field.secret ? false : status.values[field.key] ?? null,
      hasValue: field.secret ? status.secrets[field.key]?.hasValue === true : false,
    })),
  });
}

/** A short human label for what a test probe should say. */
export function testResultMessage(res: TestConnectionResponse): {
  ok: boolean;
  text: string;
  /**
   * Present only when the failure is *structural* rather than a platform
   * rejection. Callers use it to show a localised, actionable explanation
   * instead of a raw errno, which reads like a credential problem.
   */
  code?: string;
} {
  const ok = res.ok === true || res.success === true;
  return { ok, text: res.message ?? res.error ?? (ok ? 'OK' : 'Failed'), code: res.code };
}
