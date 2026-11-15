/**
 * Remote Access — browser-side contract mirror + setup-wizard state machine (T9).
 *
 * ── Why this file mirrors instead of imports ─────────────────────────────────
 * `packages/web-ui` is a **self-contained browser SPA**: it cannot import
 * `@markus/remote` / `@markus/shared` / `@markus/core` (those are Node packages).
 * The existing precedent is to *mirror* the server contract locally and keep the
 * server file as the single source of truth — see `lib/modelCapabilities.ts`,
 * `lib/deliverableShare.ts`, `lib/mediaRefs.ts`.
 *
 * SINGLE SOURCE OF TRUTH for everything mirrored here:
 *   • `packages/remote/src/contract.ts`   (REMOTE_CONTRACT_VERSION 1.0.0, T1)
 *   • `docs/architecture/remote-access.md`  (normative prose)
 * If the contract changes, this mirror + `test/remoteAccessWizard.test.ts` must
 * change with it. The enums below are runtime `const` arrays with the type
 * derived from them, so "the list" and "the union" can never drift here either.
 *
 * Everything in this module is **pure and dependency-free** so the wizard state
 * machine can be unit-tested without rendering React or a live backend.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. Contract mirror — enums (verbatim from contract.ts §1/§3/§5/§6)
// ─────────────────────────────────────────────────────────────────────────────

/** Registry kind — what gets PERSISTED. Mirrors `REMOTE_ENDPOINT_KINDS`. */
export const REMOTE_ENDPOINT_KINDS = [
  'cloudflare_quick',
  'cloudflare_named',
  'tailscale_funnel',
  'tailscale_serve',
  'custom',
] as const;
export type RemoteEndpointKind = (typeof REMOTE_ENDPOINT_KINDS)[number];

/** Mirrors `REMOTE_ENDPOINT_HEALTH`. */
export const REMOTE_ENDPOINT_HEALTH = ['unknown', 'up', 'down'] as const;
export type RemoteEndpointHealth = (typeof REMOTE_ENDPOINT_HEALTH)[number];

/** Mirrors `REMOTE_MODES` = kinds ∪ {'relay_legacy'} (grey-release legacy relay). */
export const REMOTE_MODES = [...REMOTE_ENDPOINT_KINDS, 'relay_legacy'] as const;
export type RemoteMode = (typeof REMOTE_MODES)[number];

/** Mirrors `REMOTE_STATES`. */
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

/** Mirrors `ENTRY_STATUSES` (Hub entry gate). */
export const ENTRY_STATUSES = ['inactive', 'pending', 'down', 'ready'] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

/** Mirrors `VERIFY_FAILURE_REASONS`. */
export const VERIFY_FAILURE_REASONS = [
  'unreachable',
  'non_https',
  'blocked_target',
  'too_many_redirects',
  'response_too_large',
  'token_mismatch',
  'malformed_response',
] as const;
export type VerifyFailureReason = (typeof VERIFY_FAILURE_REASONS)[number];

/** Mirrors `MAX_ENDPOINTS_PER_USER`. */
export const MAX_ENDPOINTS_PER_USER = 5;

/** Entry host suffix: the shareable entry is `https://{username}.<suffix>`. */
export const ENTRY_HOST_SUFFIX = 'remote.markus.global';

/** Hub web origin — used for the login redirect that precedes the entry gate. */
export const HUB_WEB_ORIGIN = 'https://www.markus.global';

/**
 * Payload of the `remote:status` WebSocket event (field-extended V2).
 * Mirrors `RemoteStatusV2` (contract §6).
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
// 2. Connection-method catalog — the "门槛 / 稳定性 / 账号 / 域名" badges
// ─────────────────────────────────────────────────────────────────────────────

export type Barrier = 'low' | 'medium' | 'high';
export type Stability = 'high' | 'medium' | 'low';

export interface ConnectionMethodMeta {
  kind: RemoteEndpointKind;
  /** ★ recommended for long-term use. */
  recommended: boolean;
  /** 门槛 — how much setup this asks of the user. */
  barrier: Barrier;
  /** 稳定性. */
  stability: Stability;
  needsAccount: boolean;
  needsDomain: boolean;
  /** Which tunnel binary this method needs on the machine (for the ✓ badge). */
  binary: 'cloudflared' | 'tailscale' | null;
  /** Whether the address reaches the Hub registry (tailscale_serve does NOT). */
  reachesHub: boolean;
}

/**
 * Ordered as shown in the chooser. `cloudflare_named` is first-class (★):
 * stable, own domain, non-random.
 */
export const CONNECTION_METHODS: readonly ConnectionMethodMeta[] = [
  {
    kind: 'cloudflare_quick',
    recommended: false,
    barrier: 'low',
    stability: 'low',
    needsAccount: false,
    needsDomain: false,
    binary: 'cloudflared',
    reachesHub: true,
  },
  {
    kind: 'cloudflare_named',
    recommended: true,
    barrier: 'medium',
    stability: 'high',
    needsAccount: true,
    needsDomain: true,
    binary: 'cloudflared',
    reachesHub: true,
  },
  {
    kind: 'tailscale_funnel',
    recommended: false,
    barrier: 'low',
    stability: 'high',
    needsAccount: true,
    needsDomain: false,
    binary: 'tailscale',
    reachesHub: true,
  },
  {
    kind: 'tailscale_serve',
    recommended: false,
    barrier: 'low',
    stability: 'high',
    needsAccount: true,
    needsDomain: false,
    binary: 'tailscale',
    reachesHub: false,
  },
  {
    kind: 'custom',
    recommended: false,
    barrier: 'high',
    stability: 'medium',
    needsAccount: false,
    needsDomain: false,
    binary: null,
    reachesHub: true,
  },
] as const;

export function connectionMethod(kind: RemoteEndpointKind): ConnectionMethodMeta {
  return CONNECTION_METHODS.find((m) => m.kind === kind) ?? CONNECTION_METHODS[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Setup command snippets (path A — "I'll run it myself")
// ─────────────────────────────────────────────────────────────────────────────

export type Platform = 'macos' | 'linux' | 'windows';

export interface SetupCommands {
  /** Install the tunnel binary. */
  install: string;
  /** Start the tunnel pointing at the local Markus API port. */
  run: string;
}

/** Default local API port the tunnel must target (config.server.apiPort). */
export const DEFAULT_LOCAL_PORT = 8056;

/**
 * Copy-pasteable commands per method × platform. Kept short and honest — the
 * guide (`docs/guides/remote-access.md`) carries the long-form walkthrough.
 */
export function setupCommands(
  kind: RemoteEndpointKind,
  platform: Platform,
  localPort: number = DEFAULT_LOCAL_PORT,
): SetupCommands {
  const p = localPort;
  switch (kind) {
    case 'cloudflare_quick':
      return {
        install:
          platform === 'macos'
            ? 'brew install cloudflared'
            : platform === 'linux'
              ? 'curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared'
              : 'winget install --id Cloudflare.cloudflared',
        run: `cloudflared tunnel --url http://localhost:${p}`,
      };
    case 'cloudflare_named':
      return {
        install:
          platform === 'macos'
            ? 'brew install cloudflared'
            : platform === 'linux'
              ? 'curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared'
              : 'winget install --id Cloudflare.cloudflared',
        run: `cloudflared tunnel login && cloudflared tunnel run --url http://localhost:${p} markus`,
      };
    case 'tailscale_funnel':
      return {
        install:
          platform === 'macos'
            ? 'brew install tailscale'
            : platform === 'linux'
              ? 'curl -fsSL https://tailscale.com/install.sh | sh'
              : 'winget install --id Tailscale.Tailscale',
        run: `tailscale up && tailscale funnel ${p}`,
      };
    case 'tailscale_serve':
      return {
        install:
          platform === 'macos'
            ? 'brew install tailscale'
            : platform === 'linux'
              ? 'curl -fsSL https://tailscale.com/install.sh | sh'
              : 'winget install --id Tailscale.Tailscale',
        run: `tailscale up && tailscale serve ${p}`,
      };
    case 'custom':
      return {
        install: '# Install your own reverse proxy / FRP client (see the guide)',
        run: `# Point your proxy at http://localhost:${p} and expose it over HTTPS`,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Local API routes (single source; the local api-server implements them)
// ─────────────────────────────────────────────────────────────────────────────
//
// These are *local* (api-server) routes, not the Hub API frozen in T1 §2. The
// wizard is their client; the local wiring lands in T8. Keeping them here means
// one place to change if a route is renamed.

export const REMOTE_LOCAL_ROUTES = {
  status: '/settings/remote',
  detect: '/settings/remote/detect',
  tunnelRestart: '/settings/remote/tunnel/restart',
  tunnelRotate: '/settings/remote/tunnel/rotate',
  tunnelStop: '/settings/remote/tunnel/stop',
  /** Register/replace the public address (used for manual re-entry after a failed verify). */
  tunnelRegister: '/settings/remote/tunnel/register',
  agentSetup: '/settings/remote/agent-setup',
  /** Candidate recipient Agents for the Path-B picker. */
  agentSetupTargets: '/settings/remote/agent-setup/targets',
} as const;

// ── Path B mirrors (T10) ─────────────────────────────────────────────────────
// The plan is built SERVER-side (`@markus/remote#buildAgentSetupPlan`) and comes
// back inside the dispatch response. These mirrors exist so the wizard can render
// what will actually run — never to construct the plan in the browser.

export interface RemoteSetupTarget {
  id: string;
  name: string;
  role: string;
}

export interface RemoteSetupTargets {
  agents: RemoteSetupTarget[];
  recommendedId: string | null;
}

/** One shell step of an `AgentTunnelTaskContract` (mirror of the remote builder). */
export interface AgentSetupCommand {
  id: string;
  shell: string;
  run: string;
  purpose: string;
  sensitive: boolean;
  idempotent: boolean;
}

export interface AgentSetupCriterion {
  id: string;
  label: string;
  check: string;
}

/** Mirror of `@markus/remote`'s `AgentTunnelTaskContract` (display only). */
export interface AgentTunnelTaskContract {
  goal: string;
  commands: AgentSetupCommand[];
  successCriteria: AgentSetupCriterion[];
  rollback: Array<{ id: string; description: string; run?: string }>;
  planVersion?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Setup-wizard state machine
// ─────────────────────────────────────────────────────────────────────────────
//
// The wizard has six progress steps (mirroring the product brief):
//   install → start → resolve → register → verify → ready
// plus two non-linear phases:
//   idle          nothing started yet
//   error         a step failed (actionable message + retry)
//   reconnecting  a tunnel that HAD been ready dropped — never silent
//
// The backend `RemoteState` (7 values, contract §6) is the authority once the
// tunnel is live; `phaseFromRemoteState` maps it onto these steps.

export const SETUP_STEPS = ['install', 'start', 'resolve', 'register', 'verify', 'ready'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export const WIZARD_PHASES = ['idle', 'error', 'reconnecting', ...SETUP_STEPS] as const;
export type WizardPhase = (typeof WIZARD_PHASES)[number];

export type SetupPath = 'self' | 'agent';

export interface WizardState {
  /** Which of the two onboarding paths the user picked (A: run it yourself, B: hand to an Agent). */
  path: SetupPath | null;
  /** Selected tunnel kind. */
  kind: RemoteEndpointKind | null;
  phase: WizardPhase;
  /** Authoritative backend state, when a status event has been seen. */
  remoteState: RemoteState | null;
  /** Stable shareable entry `https://{user}.remote.markus.global`. */
  entryUrl: string | null;
  /** Actual tunnel address (302 target). */
  publicUrl: string | null;
  health: RemoteEndpointHealth;
  latencyMs: number | null;
  /** Actionable hint (backend message or local error text). */
  message: string | null;
  /** Last verification failure reason, when phase === 'error' due to verify. */
  verifyFailure: VerifyFailureReason | null;
  /** True once a tunnel reached ready — lets us show "reconnecting" instead of a cold error. */
  wasReady: boolean;
  /** Path B — the Agent the user asked to run the setup (null until chosen). */
  agentId: string | null;
  /** Path B — true once the plan's prompt has been prefilled into an Agent's chat. */
  handedToChat: boolean;
  /** Path B — the server-built contract returned by the dispatch, for display. */
  agentContract: AgentTunnelTaskContract | null;
}

export const initialWizardState: WizardState = {
  path: null,
  kind: null,
  phase: 'idle',
  remoteState: null,
  entryUrl: null,
  publicUrl: null,
  health: 'unknown',
  latencyMs: null,
  message: null,
  verifyFailure: null,
  wasReady: false,
  agentId: null,
  handedToChat: false,
  agentContract: null,
};

export type WizardEvent =
  | { type: 'selectKind'; kind: RemoteEndpointKind }
  | { type: 'choosePath'; path: SetupPath }
  | { type: 'selectAgent'; agentId: string }
  /** Path B — the prompt was prefilled into the Agent's chat for the user to send. */
  | { type: 'handedToChat'; contract?: AgentTunnelTaskContract | null }
  | { type: 'beginInstall' }
  | { type: 'installSucceeded' }
  | { type: 'installFailed'; message: string }
  | { type: 'processStarted' }
  | { type: 'addressResolved'; publicUrl: string }
  | { type: 'registered'; entryUrl?: string | null }
  | { type: 'verifyStarted' }
  | { type: 'verifyFailed'; reason: VerifyFailureReason; message?: string }
  | { type: 'ready' }
  | { type: 'degraded'; message?: string }
  | { type: 'disconnected'; message?: string }
  | { type: 'userError'; message: string }
  /** Authoritative backend status (WS `remote:status` or poll). */
  | { type: 'status'; status: RemoteStatusV2 }
  | { type: 'reset' };

/**
 * Map the backend `RemoteState` onto a wizard phase.
 * `starting` is refined by the presence of a resolved address / registered entry.
 */
export function phaseFromRemoteState(
  state: RemoteState,
  ctx: { publicUrl: string | null; entryUrl: string | null },
): WizardPhase {
  switch (state) {
    case 'idle':
      return 'idle';
    case 'installing':
      return 'install';
    case 'starting':
      if (ctx.entryUrl) return 'verify';
      if (ctx.publicUrl) return 'register';
      return 'start';
    case 'verifying':
      return 'verify';
    case 'ready':
    case 'degraded':
      return 'ready';
    case 'error':
      return 'error';
  }
}

/** Index of a progress phase in `SETUP_STEPS`; -1 for non-linear phases. */
export function stepIndex(phase: WizardPhase): number {
  return (SETUP_STEPS as readonly string[]).indexOf(phase);
}

export function isProgressPhase(phase: WizardPhase): phase is SetupStep {
  return stepIndex(phase) >= 0;
}

/**
 * The next step after the user reports "I've run it" on the self-run path.
 *
 * A known address goes straight to `register`. When the local supervisor has no
 * address yet — the normal case for a tunnel the USER started, because only their
 * own terminal ever saw the quick-tunnel hostname — we advance to `resolve` and
 * ask them for it. There is deliberately NO branch that leaves the wizard where
 * it was: the old code froze the UI whenever the status was `enabled && !publicUrl`,
 * which is exactly the state a hand-run quick tunnel leaves behind.
 */
export function afterSelfRun(status: RemoteStatusV2 | null): WizardEvent {
  if (status?.enabled && status.publicUrl) {
    return { type: 'addressResolved', publicUrl: status.publicUrl };
  }
  return { type: 'processStarted' };
}

/**
 * Pure reducer. Every transition the wizard can make is here, so the acceptance
 * case "idle→installing→…→ready/error" is provable without a DOM.
 */
export function wizardReducer(state: WizardState, event: WizardEvent): WizardState {
  switch (event.type) {
    case 'selectKind':
      return { ...state, kind: event.kind };
    case 'choosePath':
      return { ...state, path: event.path };
    case 'selectAgent':
      return { ...state, agentId: event.agentId };
    case 'handedToChat':
      // Nothing was dispatched: the prompt is sitting in the Agent's composer
      // awaiting the user's send. The wizard stays on the chooser and lets the
      // authoritative `remote:status` stream drive the real phases.
      return {
        ...state,
        path: 'agent',
        handedToChat: true,
        agentContract: event.contract ?? state.agentContract,
        message: null,
        verifyFailure: null,
      };
    case 'beginInstall':
      return { ...state, phase: 'install', message: null, verifyFailure: null };
    case 'installSucceeded':
      return { ...state, phase: 'start', message: null };
    case 'installFailed':
      return { ...state, phase: 'error', message: event.message };
    case 'processStarted':
      return { ...state, phase: 'resolve', message: null };
    case 'addressResolved':
      return { ...state, publicUrl: event.publicUrl, phase: 'register', health: 'up', message: null };
    case 'registered':
      return {
        ...state,
        entryUrl: event.entryUrl ?? state.entryUrl,
        phase: 'verify',
        message: null,
      };
    case 'verifyStarted':
      return { ...state, phase: 'verify', message: null };
    case 'verifyFailed':
      return {
        ...state,
        phase: 'error',
        verifyFailure: event.reason,
        message: event.message ?? null,
      };
    case 'ready':
      return { ...state, phase: 'ready', wasReady: true, verifyFailure: null, message: null, health: 'up' };
    case 'degraded':
      return { ...state, phase: 'ready', wasReady: true, message: event.message ?? state.message };
    case 'disconnected':
      return state.wasReady
        ? { ...state, phase: 'reconnecting', publicUrl: null, health: 'down' }
        : { ...state, phase: 'error', health: 'down', message: event.message ?? null };
    case 'userError':
      return { ...state, phase: 'error', message: event.message };
    case 'reset':
      // Keep the chosen kind so re-opening the same method is quick.
      return { ...initialWizardState, kind: state.kind, path: state.path };
    case 'status':
      return applyStatus(state, event.status);
  }
}

function applyStatus(state: WizardState, status: RemoteStatusV2): WizardState {
  // Disabled ⇒ back to idle (keep the user's method choice).
  if (!status.enabled) {
    return { ...initialWizardState, kind: state.kind, path: state.path };
  }

  const base: WizardState = {
    ...state,
    remoteState: status.state,
    entryUrl: status.entryUrl ?? state.entryUrl,
    publicUrl: status.publicUrl ?? state.publicUrl,
    health: status.health,
    latencyMs: status.latencyMs ?? null,
    message: status.message ?? null,
  };

  if (status.state === 'ready' || status.state === 'degraded') {
    return { ...base, phase: 'ready', wasReady: true, verifyFailure: null };
  }
  if (status.state === 'error') {
    return { ...base, phase: 'error' };
  }
  // A live tunnel that HAD been ready dropping back to a progress/idle state is
  // a disconnect — surface "reconnecting", never a silent reset.
  if (state.phase === 'ready' || state.phase === 'reconnecting') {
    return { ...base, phase: 'reconnecting', wasReady: true };
  }
  return { ...base, phase: phaseFromRemoteState(status.state, base) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Status adapter — V2 payloads pass through, legacy payloads are mapped
// ─────────────────────────────────────────────────────────────────────────────
//
// Until T8 flips the server to emit `RemoteStatusV2`, `/settings/remote` still
// returns the legacy `RemoteStatus`. The adapter is pure so it is unit-tested:
// it lets the new UI ship without waiting for the backend, and keeps working
// unchanged once the backend catches up.

const has = <T extends readonly string[]>(list: T, v: unknown): v is T[number] =>
  typeof v === 'string' && (list as readonly string[]).includes(v);

export function adaptRemoteStatus(raw: unknown): RemoteStatusV2 | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // ── V2 shape: carries `mode` (the discriminator legacy never had) ──
  if (has(REMOTE_MODES, r.mode) && has(REMOTE_STATES, r.state)) {
    return {
      enabled: r.enabled === true,
      mode: r.mode,
      state: r.state,
      entryUrl: typeof r.entryUrl === 'string' ? r.entryUrl : null,
      publicUrl: typeof r.publicUrl === 'string' ? r.publicUrl : null,
      health: has(REMOTE_ENDPOINT_HEALTH, r.health) ? r.health : 'unknown',
      latencyMs: typeof r.latencyMs === 'number' ? r.latencyMs : undefined,
      message: typeof r.message === 'string' ? r.message : undefined,
    };
  }

  // ── Legacy shape: { enabled, connected, state:'idle'|'registering'|'connecting'|'connected'|'disconnected', remoteUrl, peerCount, ... } ──
  if (typeof r.enabled === 'boolean' || typeof r.state === 'string') {
    const connected = r.connected === true;
    const legacyState = typeof r.state === 'string' ? r.state : 'idle';
    return {
      enabled: r.enabled === true,
      mode: 'relay_legacy',
      state: legacyStateToV2(legacyState, connected),
      entryUrl: null,
      publicUrl: typeof r.remoteUrl === 'string' ? r.remoteUrl : null,
      health: connected ? 'up' : 'unknown',
    };
  }

  return null;
}

function legacyStateToV2(legacyState: string, connected: boolean): RemoteState {
  switch (legacyState) {
    case 'registering':
    case 'connecting':
      return 'starting';
    case 'connected':
      return 'ready';
    case 'disconnected':
      return connected ? 'ready' : 'error';
    case 'idle':
    default:
      return 'idle';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Shareable entry URL for a username. */
export function entryUrlFor(username: string | null | undefined): string | null {
  if (!username) return null;
  return `https://${username}.${ENTRY_HOST_SUFFIX}`;
}

/** Hub login URL that returns to the entry after auth (the entry gate's redirect). */
export function hubLoginUrl(redirect?: string | null): string {
  const base = `${HUB_WEB_ORIGIN}/auth/login`;
  if (!redirect) return base;
  return `${base}?redirect=${encodeURIComponent(redirect)}`;
}

/** Best-effort platform from a user-agent string (defaults to linux). */
export function detectPlatform(ua: string): Platform {
  const s = ua.toLowerCase();
  if (s.includes('mac') || s.includes('darwin')) return 'macos';
  if (s.includes('win')) return 'windows';
  return 'linux';
}

/** Human label for a verify failure reason (i18n key under settings.remoteAccess.verifyReason.*). */
export function verifyReasonKey(reason: VerifyFailureReason): string {
  return `verifyReason.${reason}`;
}
