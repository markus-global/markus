/**
 * Markus Remote Access — frozen interface contract (T1).
 *
 * SINGLE SOURCE OF TRUTH for every interface shared between the local CLI
 * (`TunnelManager` / `RegistryClient` / `verify-server`) and the Markus Hub
 * (endpoint registry API + entry gate).
 *
 * Normative companions:
 *   • docs/architecture/remote-access.md   ← prose contract (freezes the same facts)
 *   • docs/design/remote-access.md / remote-access-design.md (v2) ← design intent
 *
 * ⚠️ This file is a CONTRACT. Changing anything here is a breaking change that
 * must be reflected in the doc AND in every task that implements it (T2/T3/T5/T6/
 * T7/T8/T9/T10). Do not "just tweak" a value.
 *
 * Convention:
 *   • Types describe shapes; the `const` tables below are the runtime authority
 *     for enumerations (arrays of string literals → type derived from them, so
 *     "the list" and "the union" can never drift).
 *   • Hub is a separate repository. It mirrors these types verbatim (it cannot
 *     `import` from `@markus/remote`); the doc + this file are the alignment source.
 */

/** Bumped whenever this contract changes in a breaking way. */
export const REMOTE_CONTRACT_VERSION = '1.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Data model — `remote_endpoints` (Hub)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Registry kind. This is what gets PERSISTED; it is the full set of tunnel
 * mechanisms the registry understands.
 *
 *  • cloudflare_quick  — `cloudflared tunnel --url` zero-config, random URL, changes on restart
 *  • cloudflare_named  — user-owned domain + named tunnel, stable URL (first-class, non-random)
 *  • tailscale_funnel  — public `*.ts.net` via Tailscale Funnel, stable
 *  • tailscale_serve   — tailnet-internal only, NEVER reaches the Hub (guide-only kind)
 *  • custom            — self-hosted reverse proxy / FRP / ngrok / anything else
 *
 * P3 mechanisms (FRP / ngrok) are represented as `custom` for now — they are NOT
 * separate kinds until a task explicitly widens this table.
 */
export const REMOTE_ENDPOINT_KINDS = [
  'cloudflare_quick',
  'cloudflare_named',
  'tailscale_funnel',
  'tailscale_serve',
  'custom',
] as const;
export type RemoteEndpointKind = (typeof REMOTE_ENDPOINT_KINDS)[number];

/** Liveness of the tunnel target as observed by the Hub / local watchdog. */
export const REMOTE_ENDPOINT_HEALTH = ['unknown', 'up', 'down'] as const;
export type RemoteEndpointHealth = (typeof REMOTE_ENDPOINT_HEALTH)[number];

export const DEFAULT_VERIFY_PATH = '/api/remote/verify';

/**
 * Persisted row shape (DB / `remote_endpoints`). `verifyToken` and `secretHash`
 * are SECRET-ADJACENT and MUST NEVER appear in any API response.
 */
export interface RemoteEndpointRow {
  id: string;
  userId: string;
  instanceName: string;
  kind: RemoteEndpointKind;
  /** Tunnel public address, e.g. `https://xxx.trycloudflare.com`. Always `https:`. */
  publicUrl: string;
  /** Challenge string the tunnel must echo back for ownership verification. */
  verifyToken: string;
  /** Local path the Hub probes; default {@link DEFAULT_VERIFY_PATH}. */
  verifyPath: string;
  /** ISO timestamp when ownership verification succeeded; `null` = not yet verified. */
  verifiedAt: string | null;
  /** sha256(secret) hex — the raw `secret` is never stored. `null` = never issued. */
  secretHash: string | null;
  /** 1 = the single active endpoint for this user; 0 = inactive. */
  isActive: 0 | 1;
  lastSeenAt: string | null;
  health: RemoteEndpointHealth;
  createdAt: string;
  updatedAt: string;
}

/**
 * Public projection returned by the Hub. Deliberately OMITS `verifyToken` and
 * `secretHash` (S1: an endpoint response must never leak secrets).
 */
export interface RemoteEndpointDTO {
  id: string;
  kind: RemoteEndpointKind;
  instanceName: string;
  /** Present for the OWNER after verification; the entry gate never returns it unauthenticated. */
  publicUrl: string;
  verifyPath: string;
  verified: boolean;
  verifiedAt: string | null;
  isActive: boolean;
  lastSeenAt: string | null;
  health: RemoteEndpointHealth;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Hub API — request / response envelopes
// ─────────────────────────────────────────────────────────────────────────────
//
// Routes (all Hub-side unless noted):
//   POST   /api/remote/endpoints              create/replace endpoint   [Hub token]
//   GET    /api/remote/endpoints              list own endpoints        [Hub token]
//   PATCH  /api/remote/endpoints/:id          rotate URL / heartbeat    [Hub token | HMAC]
//   DELETE /api/remote/endpoints/:id          unregister endpoint       [Hub token]
//   POST   /api/remote/endpoints/:id/verify   (re)trigger verification  [Hub token]
//   GET    /api/remote/entry/:username        entry status (PUBLIC)     [public]
//   GET    /api/remote/verify                 LOCAL verify-server       [none, tunnel-local]

/** `POST /api/remote/endpoints` request body. */
export interface CreateEndpointRequest {
  kind: RemoteEndpointKind;
  publicUrl: string;
  instanceName?: string;
}

/** `POST /api/remote/endpoints` response (201). `verifyToken` is returned exactly once here. */
export interface CreateEndpointResponse {
  endpointId: string;
  verifyToken: string;
  verifyPath: string;
}

/** `GET /api/remote/endpoints` response (200). */
export interface ListEndpointsResponse {
  endpoints: RemoteEndpointDTO[];
}

/** `PATCH /api/remote/endpoints/:id` request body — all fields optional; at least one required. */
export interface UpdateEndpointRequest {
  /** Rotate the tunnel URL (quick tunnels change on restart). */
  publicUrl?: string;
  /** Heartbeat. */
  lastSeenAt?: string;
  health?: RemoteEndpointHealth;
  /** Promote this endpoint to active (demotes any other active endpoint of the same user). */
  isActive?: boolean;
}

/** `PATCH /api/remote/endpoints/:id` response (200). */
export interface UpdateEndpointResponse {
  endpoint: RemoteEndpointDTO;
}

/** `DELETE /api/remote/endpoints/:id` response (200). */
export interface DeleteEndpointResponse {
  ok: true;
}

/** `POST /api/remote/endpoints/:id/verify` response (200). `secret` is returned exactly once. */
export interface VerifyEndpointResponse {
  verified: true;
  /** Issued only on the transition to verified; NEVER returned again. */
  secret?: string;
  verifiedAt: string;
}

/** Public entry status. Answers ONLY "can you enter", never "where does it go". */
export const ENTRY_STATUSES = ['inactive', 'pending', 'down', 'ready'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/**
 * `GET /api/remote/entry/:username` response (200, public).
 * The response body and headers MUST contain the status ONLY — never `target` /
 * `publicUrl` (S1). `target` exists solely in an authorised 302 `Location`.
 */
export interface EntryStatusResponse {
  status: EntryStatus;
}

/** `GET /api/remote/verify` response (local verify-server), shape returned THROUGH the tunnel. */
export interface LocalVerifyResponse {
  token: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Error codes (frozen) — every non-2xx Hub response uses this envelope
// ─────────────────────────────────────────────────────────────────────────────

export const REMOTE_ERROR_CODES = [
  'unauthorized',          // 401 — missing/invalid Hub token or HMAC signature
  'forbidden',             // 403 — authenticated but not the endpoint owner
  'not_found',             // 404 — endpoint or username does not exist
  'invalid_kind',          // 400 — unknown `kind`
  'invalid_public_url',    // 400 — URL fails validation (S5)
  'invalid_body',          // 400 — malformed JSON / missing required field
  'signature_expired',     // 401 — timestamp outside the ±300s clock window (S3)
  'signature_replayed',    // 401 — nonce already used (S3)
  'verify_failed',         // 502 — Hub could not fetch/compare the challenge token
  'verify_target_blocked', // 400 — SSRF guard rejected the target (private range, bad scheme…)
  'rate_limited',          // 429 — per-user/per-IP limit hit
  'conflict',              // 409 — e.g. activating an endpoint that is not verified
  'method_not_allowed',    // 405
] as const;
export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number];

export interface RemoteErrorResponse {
  error: RemoteErrorCode;
  /** Human-readable, actionable hint. Never contains a tunnel address. */
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Authentication & rotation signing (S3)
// ─────────────────────────────────────────────────────────────────────────────
//
// Two auth modes:
//   (a) Hub token  — `Authorization: Bearer <hub-token>` (same token the CLI keeps
//                    at ~/.markus/hub-token). Used by every owner-scoped route.
//   (b) HMAC rotation — lets a CLI rotate its OWN endpoint URL WITHOUT a Hub token
//                    round-trip, using the per-endpoint `secret` issued at verify
//                    time. Accepted on PATCH only.

/** Signed-request headers. */
export const SIGNATURE_HEADERS = {
  timestamp: 'x-markus-timestamp',
  nonce: 'x-markus-nonce',
  signature: 'x-markus-signature',
} as const;

/** Clock window for {@link SIGNATURE_HEADERS.timestamp}; outside → `signature_expired`. */
export const SIGNATURE_MAX_SKEW_SECONDS = 300;
/** Nonce length bounds (base64url / hex charset). Enforced by both sides. */
export const SIGNATURE_NONCE_MIN_LENGTH = 16;
export const SIGNATURE_NONCE_MAX_LENGTH = 64;
/** Signature scheme prefix so the algorithm can be rotated without ambiguity. */
export const SIGNATURE_SCHEME = 'v1';

export interface RotationSignatureInput {
  method: string;
  /** Request path WITHOUT query string, e.g. `/api/remote/endpoints/ep_123`. */
  path: string;
  /** Lowercase hex sha256 of the raw request body; `''` (empty) when there is no body. */
  bodyHash: string;
  /** Unix SECONDS, decimal string. */
  timestamp: string;
  nonce: string;
}

/**
 * NORMATIVE canonical string. Both the CLI (signer) and the Hub (verifier) MUST
 * build it with exactly these steps — this function IS the algorithm.
 *
 *   line 1: SIGNATURE_SCHEME ('v1')
 *   line 2: method, UPPERCASE
 *   line 3: path
 *   line 4: bodyHash
 *   line 5: timestamp
 *   line 6: nonce
 *   joined with '\n' (LF), no trailing newline
 *
 * Why `\n` and not the `|` used in the design draft: a URL path or a value can
 * legally contain `|`, which makes a `|`-joined string ambiguous (two different
 * inputs could produce one canonical form). LF cannot appear in any field.
 *
 * Signature = `hex( HMAC-SHA256(secret, canonical) )`, transmitted as
 * `X-Markus-Signature: v1=<hex>`. The server MUST: recompute, compare in constant
 * time, enforce `|now - timestamp| <= 300`, and reject a replayed nonce.
 */
export function buildRotationCanonicalString(input: RotationSignatureInput): string {
  return [
    SIGNATURE_SCHEME,
    input.method.toUpperCase(),
    input.path,
    input.bodyHash,
    input.timestamp,
    input.nonce,
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Ownership verification — challenge / response protocol
// ─────────────────────────────────────────────────────────────────────────────
//
//  ① CLI  POST /api/remote/endpoints {kind, publicUrl}
//         → { endpointId, verifyToken, verifyPath }   (verifyToken persisted in local config)
//  ② CLI  exposes GET {verifyPath} THROUGH the tunnel → { token: <verifyToken> }
//         (source of truth for what the Hub will read; also readable on loopback for self-test)
//  ③ Hub  GET https://{host}{verifyPath} (SSRF-guarded) → compare token === verifyToken
//         match → set verifiedAt, issue `secret` (returned ONCE), store sha256(secret)
//  ④ Until ③ succeeds the endpoint's entry route is INERT (entry status = `pending`).
//
// The Hub MUST NEVER trust the client's claim of ownership; verification is always
// an out-of-band fetch back to the tunnel.

/** Secret material is 32 random bytes, base64url-encoded (no padding). */
export const VERIFY_SECRET_BYTES = 32;
/** The verify endpoint is a tiny token echo — cap the fetch response hard. */
export const VERIFY_RESPONSE_MAX_BYTES = 64 * 1024;
/** Outbound fetch timeout for the ownership probe. */
export const VERIFY_FETCH_TIMEOUT_MS = 5_000;
/** Redirect chain cap while probing. */
export const VERIFY_MAX_REDIRECTS = 3;

/** Why a `POST /:id/verify` attempt did not succeed (surfaced as `verify_failed` detail). */
export const VERIFY_FAILURE_REASONS = [
  'unreachable',        // connection refused / DNS failure / timeout
  'non_https',          // target was not https:
  'blocked_target',     // SSRF guard rejected the resolved IP
  'too_many_redirects',
  'response_too_large',
  'token_mismatch',     // reachable, but echoed token != verifyToken
  'malformed_response', // body was not the expected LocalVerifyResponse shape
] as const;
export type VerifyFailureReason = (typeof VERIFY_FAILURE_REASONS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// 6. Runtime status event — RemoteStatusV2 (`remote:status` WS payload)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Status `mode`. Superset of {@link RemoteEndpointKind}: adds `relay_legacy`,
 * the legacy WebRTC relay reported while it still exists during the grey-release.
 */
export const REMOTE_MODES = [
  ...REMOTE_ENDPOINT_KINDS,
  'relay_legacy',
] as const;
export type RemoteMode = (typeof REMOTE_MODES)[number];

export const REMOTE_STATES = [
  'idle',
  'installing',
  'starting',
  'verifying',
  'ready',
  'degraded',
  'error',
] as const;
export type RemoteState = (typeof REMOTE_STATES)[number];

/**
 * Payload of the `remote:status` WebSocket event (field-extended V2).
 * Replaces the legacy `RemoteAccessStatus`; the legacy type stays only for the
 * relay_legacy mode during the grey-release.
 */
export interface RemoteStatusV2 {
  enabled: boolean;
  mode: RemoteMode;
  state: RemoteState;
  /** Stable shareable entry, `https://{user}.remote.markus.global`; null until known. */
  entryUrl: string | null;
  /** Actual tunnel address (the 302 target); null unless a tunnel is live. */
  publicUrl: string | null;
  health: RemoteEndpointHealth;
  latencyMs?: number;
  /** Actionable hint, e.g. "cloudflared not detected". */
  message?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Agent-assisted setup contract (path B · "hand it to an Agent")
// ─────────────────────────────────────────────────────────────────────────────
//
// The wizard can hand the install/configure job to an Agent. The job is ALWAYS
// expressed as this fixed structure — never free-form prose — so an Agent can
// execute it deterministically and report back.

export interface AgentTunnelTaskCommand {
  /** Which shell to run under. */
  shell: 'sh' | 'powershell';
  /** The exact command line. MUST be copy-pasteable as-is. */
  run: string;
  /** Human explanation of what this command does and why it is needed. */
  purpose: string;
  /** true → the Agent must obtain explicit user consent before running (e.g. writes to ~/.markus/.env, installs a system service). */
  sensitive: boolean;
  /** Idempotency hint so a retry is safe. */
  idempotent: boolean;
}

export interface AgentTunnelTaskSuccessCriterion {
  /** Stable key the Agent reports against. */
  id: string;
  /** Human-readable, testable statement of done. */
  description: string;
  /** How to verify it (a command whose exit code 0 / output means "met"). */
  check: string;
}

export interface AgentTunnelTaskRollbackStep {
  description: string;
  /** Undo command, or null when the step is "uninstall the binary" prose-only. */
  run: string | null;
}

/**
 * The contract a "hand it to an Agent" task carries. Fixed shape = the Agent
 * always knows what to do; the user always knows what will happen.
 */
export interface AgentTunnelTaskContract {
  /** One-sentence objective. */
  goal: string;
  commands: AgentTunnelTaskCommand[];
  successCriteria: AgentTunnelTaskSuccessCriterion[];
  rollback: AgentTunnelTaskRollbackStep[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Validation & SSRF policy constants (S4/S5) — shared by CLI pre-checks and Hub
// ─────────────────────────────────────────────────────────────────────────────

/** Max length of a stored/echoed `publicUrl` / `Location` value (S5). */
export const PUBLIC_URL_MAX_LENGTH = 512;

/**
 * Complete denylist of destination ranges the ownership probe must refuse (S4).
 * A URL is rejected if the host resolves into ANY of these.
 */
export const SSRF_BLOCKED_CIDRS = [
  '0.0.0.0/8',        // "this network"
  '10.0.0.0/8',       // private
  '127.0.0.0/8',      // loopback
  '169.254.0.0/16',   // link-local
  '172.16.0.0/12',    // private
  '192.168.0.0/16',   // private
  '100.64.0.0/10',    // CGNAT
  '::1/128',          // IPv6 loopback
  'fc00::/7',         // IPv6 unique-local
  '::ffff:0:0/96',    // IPv4-mapped IPv6
  '64:ff9b::/96',     // NAT64
] as const;

/**
 * Ordering rule for the probe (S4) — expressed as a constant so it is stated once:
 *   1. scheme MUST be `https:`
 *   2. resolve the host EXACTLY ONCE, reject if any resolved IP is in {@link SSRF_BLOCKED_CIDRS}
 *   3. PIN the connection to that resolved IP (NO second resolution — defeats DNS rebinding)
 *   4. on each redirect hop, re-run 1–3; stop after {@link VERIFY_MAX_REDIRECTS} hops
 *   5. enforce {@link VERIFY_FETCH_TIMEOUT_MS} and {@link VERIFY_RESPONSE_MAX_BYTES}
 */
export const SSRF_POLICY_VERSION = '1.0.0';

/** Per-user endpoint cap (P0/P1). Enforced by the registry. */
export const MAX_ENDPOINTS_PER_USER = 5;
